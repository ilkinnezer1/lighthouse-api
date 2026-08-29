import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { chooseOrgCredential, type GitAuthSource } from './git-auth';

const GITHUB_API = 'https://api.github.com';
const BRANCHES_PER_PAGE = 100;
const MAX_BRANCH_PAGES = 10;
const REPOS_PER_PAGE = 30;
const COMPARE_CONCURRENCY = 8;
const COMPARE_CACHE_TTL_MS = 5 * 60 * 1000;
const LOGIN_CACHE_TTL_MS = 5 * 60 * 1000;
// Sweep expired entries once the cache grows past this; sha-keyed entries are
// orphaned by every push, so without a bound the map grows without limit.
const COMPARE_CACHE_MAX = 1000;

export interface OrgGitAuth {
  token: string | null;
  source: GitAuthSource;
}

export interface RepoBranch {
  name: string;
  sha: string;
}

export interface BranchMeta {
  aheadBy: number | null;
  behindBy: number | null;
  lastCommitDate: string | null;
}

export type RepoBranchWithMeta = RepoBranch & BranchMeta;

export interface RepoCommit {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
  url: string;
}

export interface CommitRange {
  commits: RepoCommit[];
  /** GitHub's own count, which can exceed `commits.length` — see below. */
  totalCommits: number;
  truncated: boolean;
}

export interface RepoSummary {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  pushedAt: string;
  htmlUrl: string;
}

interface GithubRepo {
  full_name?: string;
  name?: string;
  owner?: { login?: string };
  private?: boolean;
  default_branch?: string;
  description?: string | null;
  language?: string | null;
  pushed_at?: string;
  html_url?: string;
}

@Injectable()
export class GithubApiService {
  private readonly logger = new Logger(GithubApiService.name);

  /** Base-relative deltas keyed `${repo}::${base}::${headSha}` (sha-keyed so a moved branch misses). */
  private readonly compareCache = new Map<
    string,
    { at: number; meta: BranchMeta }
  >();

  /** Owner-id → GitHub login from the OAuth token, short-TTL cached. */
  private readonly loginCache = new Map<
    string,
    { at: number; login: string }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Build GitHub API request headers, attaching the owner's PAT when one
   * exists (required for private repos, higher rate limits otherwise) and
   * falling back to an unauthenticated call so public repos still resolve.
   */
  /**
   * The credential that authenticates work done for an organization.
   *
   * Resolved from the ORGANIZATION, never from whoever happens to have created
   * the project — see git-auth.ts for why that ordering is the whole point.
   */
  async resolveOrgGitAuth(organizationId: string): Promise<OrgGitAuth> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        isPersonal: true,
        memberships: {
          where: { role: 'OWNER' },
          select: { userId: true },
          take: 1,
        },
        gitCredentials: {
          where: { kind: 'PAT' },
          orderBy: { createdAt: 'desc' },
          select: { id: true, secretEnc: true },
          take: 1,
        },
      },
    });
    if (!org) return { token: null, source: 'none' };

    // Only fetched for a personal org — in a shared one it is exactly the
    // credential that must not be borrowed, so it is never even read.
    const ownerId = org.memberships[0]?.userId;
    const ownerPersonalCredential =
      org.isPersonal && ownerId
        ? await this.prisma.gitCredential.findFirst({
            where: { userId: ownerId, organizationId: null, kind: 'PAT' },
            orderBy: { createdAt: 'desc' },
            select: { id: true, secretEnc: true },
          })
        : null;

    const { credential, source } = chooseOrgCredential({
      orgCredential: org.gitCredentials[0] ?? null,
      isPersonalOrg: org.isPersonal,
      ownerPersonalCredential,
    });
    if (!credential) return { token: null, source };

    try {
      return { token: this.crypto.decrypt(credential.secretEnc), source };
    } catch {
      this.logger.warn(`failed to decrypt git credential ${credential.id}`);
      return { token: null, source };
    }
  }

  private async orgHeaders(
    organizationId: string,
  ): Promise<{ headers: Record<string, string>; auth: OrgGitAuth }> {
    const auth = await this.resolveOrgGitAuth(organizationId);
    return { headers: this.githubHeaders(auth.token), auth };
  }

  /**
   * The error a shared organization gets when it has no credential of its own.
   *
   * Actionable on purpose: the alternative failures are a 404 on a private repo
   * or a generic 502, both of which read as "GitHub is broken" rather than
   * "an administrator has not set this up yet".
   */
  private orgCredentialMissing(): HttpException {
    return new HttpException(
      'No organization GitHub credential configured — an administrator must add one in the organization settings',
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }

  private githubHeaders(token: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lighthouse',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /** Decrypt a user's own stored PAT; null when absent. Personal work only. */
  private async patToken(userId: string): Promise<string | null> {
    const credential = await this.prisma.gitCredential.findFirst({
      where: { userId, organizationId: null, kind: 'PAT' },
      orderBy: { createdAt: 'desc' },
    });
    if (!credential) return null;
    try {
      return this.crypto.decrypt(credential.secretEnc);
    } catch {
      this.logger.warn(`failed to decrypt personal PAT for user ${userId}`);
      return null;
    }
  }

  /**
   * The token the repo browser authenticates with.
   *
   * OAuth first when both exist — it is the narrower, revocable grant — but a
   * stored PAT is a complete substitute here. Without this fallback a user who
   * pasted a token could clone private repos and read compare ranges, while the
   * Integrations page still told them GitHub was "not connected", because repo
   * listing was the one call that never looked at `git_credentials`.
   */
  private async repoBrowseToken(ownerId: string): Promise<string | null> {
    return (await this.oauthToken(ownerId)) ?? (await this.patToken(ownerId));
  }

  async commentOnPR(args: {
    organizationId: string;
    repoFullName: string;
    prNumber: number;
    body: string;
  }): Promise<void> {
    const { token, source } = await this.resolveOrgGitAuth(args.organizationId);
    if (!token) {
      // Best-effort decoration on a deploy that already happened, so this logs
      // and returns rather than throwing — but it comments as the organization
      // or not at all, never as whichever member happened to trigger it.
      this.logger.warn(
        `no git credential for org ${args.organizationId} (${source}); skipping PR comment`,
      );
      return;
    }

    try {
      const res = await fetch(
        `${GITHUB_API}/repos/${args.repoFullName}/issues/${args.prNumber}/comments`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'lighthouse',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ body: args.body }),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        this.logger.warn(
          `PR comment failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
        );
      }
    } catch (err) {
      this.logger.warn(`PR comment request errored: ${String(err)}`);
    }
  }

  /**
   * Look up a repo's default branch via the GitHub API. Uses the ORGANIZATION's
   * credential when it has one (required for private repos, higher rate limits
   * otherwise), falling back to an unauthenticated call so public repos still
   * resolve. Returns null on any failure so callers can use their own default.
   * Returns null on any failure so callers can fall back to their own default.
   */
  async getDefaultBranch(
    organizationId: string,
    repoFullName: string,
  ): Promise<string | null> {
    const { headers } = await this.orgHeaders(organizationId);

    try {
      const res = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
        headers,
      });
      if (!res.ok) {
        this.logger.warn(
          `default-branch lookup failed for ${repoFullName}: ${res.status} ${res.statusText}`,
        );
        return null;
      }
      const body = (await res.json()) as { default_branch?: string };
      return body.default_branch ?? null;
    } catch (err) {
      this.logger.warn(
        `default-branch lookup errored for ${repoFullName}: ${String(err)}`,
      );
      return null;
    }
  }

  /**
   * List a repo's branches via the GitHub API for the branch picker. Uses the
   * owner's PAT when one exists (required for private repos, higher rate limits
   * otherwise) and falls back to an unauthenticated call so public repos still
   * resolve. Paginates up to MAX_BRANCH_PAGES; returns null on any failure so
   * callers can decide how to surface it.
   */
  async listBranches(
    organizationId: string,
    repoFullName: string,
  ): Promise<RepoBranch[] | null> {
    const { headers, auth } = await this.orgHeaders(organizationId);

    const branches: RepoBranch[] = [];
    try {
      for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
        const res = await fetch(
          `${GITHUB_API}/repos/${repoFullName}/branches?per_page=${BRANCHES_PER_PAGE}&page=${page}`,
          { headers },
        );
        if (!res.ok) {
          // A private repo answers 404 to an unauthenticated caller. When the
          // org has no credential, THAT is the reason — surfacing it as a
          // generic upstream failure would read as "GitHub is broken" and send
          // nobody to the setting that actually fixes it.
          if (
            auth.source === 'none' &&
            (res.status === 404 || res.status === 401)
          ) {
            throw this.orgCredentialMissing();
          }
          this.logger.warn(
            `branch list failed for ${repoFullName}: ${res.status} ${res.statusText}`,
          );
          return null;
        }
        const body = (await res.json()) as Array<{
          name?: string;
          commit?: { sha?: string };
        }>;
        for (const item of body) {
          if (item.name && item.commit?.sha) {
            branches.push({ name: item.name, sha: item.commit.sha });
          }
        }
        if (body.length < BRANCHES_PER_PAGE) {
          break;
        }
      }
      return branches;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(
        `branch list errored for ${repoFullName}: ${String(err)}`,
      );
      return null;
    }
  }

  /**
   * List branches plus each branch's ahead/behind delta and last-commit date
   * against `base`. Returns null only if the branch list can't be fetched; a
   * per-branch compare failure degrades that row to null meta.
   */
  async listBranchesWithDeltas(
    organizationId: string,
    repoFullName: string,
    base: string,
    refresh = false,
  ): Promise<RepoBranchWithMeta[] | null> {
    const branches = await this.listBranches(organizationId, repoFullName);
    if (branches === null) {
      return null;
    }

    const { headers } = await this.orgHeaders(organizationId);
    const out: RepoBranchWithMeta[] = [];
    for (let i = 0; i < branches.length; i += COMPARE_CONCURRENCY) {
      const batch = branches.slice(i, i + COMPARE_CONCURRENCY);
      const metas = await Promise.all(
        batch.map((b) =>
          this.branchMeta(repoFullName, base, b, headers, refresh),
        ),
      );
      batch.forEach((b, j) => out.push({ ...b, ...metas[j] }));
    }
    return out;
  }

  /**
   * The commits reachable from `head` but not `base`, oldest first — what
   * landed between two builds of the same environment.
   *
   * GitHub's compare caps the embedded `commits` array at 250 even when
   * `total_commits` is higher, so the two are reported separately rather than
   * quietly showing a short list as if it were complete. Returns null on any
   * failure; the caller treats that as "cannot say", not "nothing changed".
   */
  async compareCommits(
    organizationId: string,
    repoFullName: string,
    base: string,
    head: string,
  ): Promise<CommitRange | null> {
    const { headers } = await this.orgHeaders(organizationId);
    try {
      const res = await fetch(
        `${GITHUB_API}/repos/${repoFullName}/compare/${encodeURIComponent(
          base,
        )}...${encodeURIComponent(head)}`,
        { headers },
      );
      if (!res.ok) {
        this.logger.warn(
          `compare commits ${base}...${head} failed for ${repoFullName}: ${res.status} ${res.statusText}`,
        );
        return null;
      }
      const body = (await res.json()) as {
        total_commits?: number;
        commits?: Array<{
          sha?: string;
          html_url?: string;
          commit?: {
            message?: string;
            author?: { name?: string; date?: string };
          };
        }>;
      };
      const commits: RepoCommit[] = (body.commits ?? [])
        .filter((c) => c.sha)
        .map((c) => ({
          sha: c.sha!,
          // Only the subject: a body can run for paragraphs and the list is
          // meant to be scanned.
          message: (c.commit?.message ?? '').split('\n')[0],
          author: c.commit?.author?.name ?? null,
          date: c.commit?.author?.date ?? null,
          url:
            c.html_url ?? `https://github.com/${repoFullName}/commit/${c.sha!}`,
        }));
      const totalCommits = body.total_commits ?? commits.length;
      return {
        commits,
        totalCommits,
        truncated: totalCommits > commits.length,
      };
    } catch (err) {
      this.logger.warn(
        `compare commits ${base}...${head} errored for ${repoFullName}: ${String(err)}`,
      );
      return null;
    }
  }

  /** Cache a delta, sweeping expired entries when the map grows past its cap. */
  private cacheCompare(key: string, meta: BranchMeta): void {
    const now = Date.now();
    if (this.compareCache.size >= COMPARE_CACHE_MAX) {
      for (const [k, v] of this.compareCache) {
        if (now - v.at >= COMPARE_CACHE_TTL_MS) {
          this.compareCache.delete(k);
        }
      }
    }
    this.compareCache.set(key, { at: now, meta });
  }

  /**
   * Resolve one branch's ahead/behind + last-commit date relative to `base` via
   * the GitHub compare API. Cached per repo+base+head-sha; nulls on failure.
   * `refresh` skips the cache read (so a Fetch picks up a moved base), still
   * writing the recomputed result back.
   */
  private async branchMeta(
    repoFullName: string,
    base: string,
    branch: RepoBranch,
    headers: Record<string, string>,
    refresh = false,
  ): Promise<BranchMeta> {
    const cacheKey = `${repoFullName}::${base}::${branch.sha}`;
    if (!refresh) {
      const cached = this.compareCache.get(cacheKey);
      if (cached && Date.now() - cached.at < COMPARE_CACHE_TTL_MS) {
        return cached.meta;
      }
    }

    const empty: BranchMeta = {
      aheadBy: null,
      behindBy: null,
      lastCommitDate: null,
    };
    try {
      const res = await fetch(
        `${GITHUB_API}/repos/${repoFullName}/compare/${encodeURIComponent(
          base,
        )}...${branch.sha}`,
        { headers },
      );
      if (!res.ok) {
        this.logger.warn(
          `compare ${base}...${branch.name} failed for ${repoFullName}: ${res.status} ${res.statusText}`,
        );
        return empty;
      }
      const body = (await res.json()) as {
        ahead_by?: number;
        behind_by?: number;
        commits?: Array<{ commit?: { committer?: { date?: string } } }>;
        merge_base_commit?: { commit?: { committer?: { date?: string } } };
      };
      const headCommit = body.commits?.at(-1) ?? body.merge_base_commit;
      const meta: BranchMeta = {
        aheadBy: body.ahead_by ?? null,
        behindBy: body.behind_by ?? null,
        lastCommitDate: headCommit?.commit?.committer?.date ?? null,
      };
      this.cacheCompare(cacheKey, meta);
      return meta;
    } catch (err) {
      this.logger.warn(
        `compare ${base}...${branch.name} errored for ${repoFullName}: ${String(err)}`,
      );
      return empty;
    }
  }

  /**
   * List the repos the owner can access via their GitHub OAuth token (personal,
   * collaborator, and org membership — private included). No `search` lists
   * `/user/repos` sorted by push; a `search` term narrows via the Search API
   * scoped to the owner's login. Throws 428 when neither an OAuth token nor a
   * stored PAT is available.
   */
  async listRepos(
    ownerId: string,
    opts: { search?: string; page?: number },
  ): Promise<{ items: RepoSummary[]; nextPage: number | null }> {
    const page = opts.page ?? 1;
    const token = await this.repoBrowseToken(ownerId);
    if (!token) {
      throw new HttpException(
        'GitHub not connected',
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
    const headers = this.oauthHeaders(token);
    const search = opts.search?.trim();

    let url: string;
    if (search) {
      const login = await this.getOwnerLogin(ownerId);
      const q = `${search} user:${login ?? ''}`;
      url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(
        q,
      )}&sort=updated&per_page=${REPOS_PER_PAGE}&page=${page}`;
    } else {
      url =
        `${GITHUB_API}/user/repos?affiliation=owner,collaborator,organization_member` +
        `&sort=pushed&per_page=${REPOS_PER_PAGE}&page=${page}`;
    }

    const res = await fetch(url, { headers });
    if (res.status === 401) {
      // Token revoked at GitHub — surface as "not connected" so the UI reconnects.
      throw new HttpException(
        'GitHub not connected',
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
    if (!res.ok) {
      this.logger.warn(
        `repo list failed for owner ${ownerId}: ${res.status} ${res.statusText}`,
      );
      throw new HttpException(
        'GitHub repo list failed',
        HttpStatus.BAD_GATEWAY,
      );
    }

    const body = (await res.json()) as GithubRepo[] | { items?: GithubRepo[] };
    const repos = Array.isArray(body) ? body : (body.items ?? []);
    const items = repos.map((r) => this.mapRepo(r));
    const nextPage = items.length === REPOS_PER_PAGE ? page + 1 : null;
    return { items, nextPage };
  }

  /** GitHub login for the owner's token (OAuth or PAT); null when unavailable. */
  async getOwnerLogin(ownerId: string): Promise<string | null> {
    const cached = this.loginCache.get(ownerId);
    if (cached && Date.now() - cached.at < LOGIN_CACHE_TTL_MS) {
      return cached.login;
    }
    const token = await this.repoBrowseToken(ownerId);
    if (!token) return null;
    try {
      const res = await fetch(`${GITHUB_API}/user`, {
        headers: this.oauthHeaders(token),
      });
      if (!res.ok) {
        this.logger.warn(
          `github /user failed for owner ${ownerId}: ${res.status} ${res.statusText}`,
        );
        return null;
      }
      const body = (await res.json()) as { login?: string };
      const login = body.login ?? null;
      if (login) this.loginCache.set(ownerId, { at: Date.now(), login });
      return login;
    } catch (err) {
      this.logger.warn(
        `github /user errored for owner ${ownerId}: ${String(err)}`,
      );
      return null;
    }
  }

  private mapRepo(r: GithubRepo): RepoSummary {
    const fullName = r.full_name ?? '';
    return {
      fullName,
      name: r.name ?? fullName.split('/').at(-1) ?? '',
      owner: r.owner?.login ?? fullName.split('/')[0] ?? '',
      private: Boolean(r.private),
      defaultBranch: r.default_branch ?? 'main',
      description: r.description ?? null,
      language: r.language ?? null,
      pushedAt: r.pushed_at ?? '',
      htmlUrl: r.html_url ?? '',
    };
  }

  /** Decrypt the owner's GitHub OAuth token (UserIdentity); null when absent. */
  private async oauthToken(ownerId: string): Promise<string | null> {
    const identity = await this.prisma.userIdentity.findFirst({
      where: {
        userId: ownerId,
        provider: 'GITHUB',
        accessTokenEnc: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!identity?.accessTokenEnc) return null;
    try {
      return this.crypto.decrypt(identity.accessTokenEnc);
    } catch {
      this.logger.warn(
        `failed to decrypt github oauth token for owner ${ownerId}`,
      );
      return null;
    }
  }

  private oauthHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lighthouse',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }
}
