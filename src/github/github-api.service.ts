import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

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
  private async authHeaders(ownerId: string): Promise<Record<string, string>> {
    const credential = await this.prisma.gitCredential.findFirst({
      where: { userId: ownerId, kind: 'PAT' },
      orderBy: { createdAt: 'desc' },
    });

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lighthouse',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (credential) {
      headers.Authorization = `Bearer ${this.crypto.decrypt(credential.secretEnc)}`;
    }
    return headers;
  }

  async commentOnPR(args: {
    ownerId: string;
    repoFullName: string;
    prNumber: number;
    body: string;
  }): Promise<void> {
    const credential = await this.prisma.gitCredential.findFirst({
      where: { userId: args.ownerId, kind: 'PAT' },
      orderBy: { createdAt: 'desc' },
    });
    if (!credential) {
      this.logger.warn(`no PAT for owner ${args.ownerId}; skipping PR comment`);
      return;
    }

    const token = this.crypto.decrypt(credential.secretEnc);

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
   * Look up a repo's default branch via the GitHub API. Uses the owner's PAT
   * when one exists (required for private repos, higher rate limits otherwise),
   * but falls back to an unauthenticated call so public repos still resolve.
   * Returns null on any failure so callers can fall back to their own default.
   */
  async getDefaultBranch(
    ownerId: string,
    repoFullName: string,
  ): Promise<string | null> {
    const headers = await this.authHeaders(ownerId);

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
    ownerId: string,
    repoFullName: string,
  ): Promise<RepoBranch[] | null> {
    const headers = await this.authHeaders(ownerId);

    const branches: RepoBranch[] = [];
    try {
      for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
        const res = await fetch(
          `${GITHUB_API}/repos/${repoFullName}/branches?per_page=${BRANCHES_PER_PAGE}&page=${page}`,
          { headers },
        );
        if (!res.ok) {
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
    ownerId: string,
    repoFullName: string,
    base: string,
    refresh = false,
  ): Promise<RepoBranchWithMeta[] | null> {
    const branches = await this.listBranches(ownerId, repoFullName);
    if (branches === null) {
      return null;
    }

    const headers = await this.authHeaders(ownerId);
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
   * scoped to the owner's login. Throws 428 when GitHub is not connected.
   */
  async listRepos(
    ownerId: string,
    opts: { search?: string; page?: number },
  ): Promise<{ items: RepoSummary[]; nextPage: number | null }> {
    const page = opts.page ?? 1;
    const token = await this.oauthToken(ownerId);
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

  /** GitHub login for the owner's OAuth token; null when unconnected/unavailable. */
  async getOwnerLogin(ownerId: string): Promise<string | null> {
    const cached = this.loginCache.get(ownerId);
    if (cached && Date.now() - cached.at < LOGIN_CACHE_TTL_MS) {
      return cached.login;
    }
    const token = await this.oauthToken(ownerId);
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
