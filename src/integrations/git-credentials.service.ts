import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { USER_REF_SELECT, type UserRef } from '../common/user-ref';
import { CryptoService } from '../crypto/crypto.service';
import { mayAddPersonalCredential } from '../github/git-auth';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateGitCredentialDto } from './dto/create-git-credential.dto';
import {
  FINGERPRINT_CHARS,
  hasRepoScope,
  isPlausibleToken,
  normalizeToken,
  parseOauthScopes,
} from './github-token';

const GITHUB_API = 'https://api.github.com';

/**
 * A stored git credential as the client sees it. There is no field here that
 * could reconstruct the token, and `secretEnc` is not even selected — the
 * ciphertext has no reader outside the git layer.
 */
export interface GitCredentialView {
  id: string;
  label: string | null;
  /** The GitHub account the token authenticates as, captured at creation. */
  login: string | null;
  /** Short peppered digest, so two entries can be told apart on screen. */
  fingerprint: string | null;
  scopes: string[];
  /**
   * Whether the token can read private repos. `null` means GitHub did not
   * report scopes (a fine-grained PAT never does), so this is unknown rather
   * than a warning — see github-token.ts.
   */
  hasRepoScope: boolean | null;
  createdAt: string;
  /**
   * Who added it. Null once that person is deleted — an organization
   * credential outlives them by design, so this is attribution, not ownership.
   */
  addedBy: UserRef | null;
}

const CREDENTIAL_SELECT = {
  id: true,
  label: true,
  login: true,
  fingerprint: true,
  scopes: true,
  createdAt: true,
  user: { select: USER_REF_SELECT },
} satisfies Prisma.GitCredentialSelect;

type CredentialRow = Prisma.GitCredentialGetPayload<{
  select: typeof CREDENTIAL_SELECT;
}>;

interface GithubIdentity {
  login: string | null;
  scopes: string[] | null;
}

@Injectable()
export class GitCredentialsService {
  private readonly logger = new Logger(GitCredentialsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Store a pasted PAT, after proving it works.
   *
   * Validating first is the point: a token that is expired, revoked or simply
   * mistyped otherwise sits in the database until it fails at clone time, where
   * the error surfaces as a git failure on a deploy and tells nobody why.
   */
  async create(
    userId: string,
    dto: CreateGitCredentialDto,
  ): Promise<GitCredentialView> {
    await this.assertMayAddPersonal(userId);
    return this.store(dto, { userId, organizationId: null });
  }

  /**
   * The organization's own credential — what every member's deploys clone and
   * comment as. `actorUserId` is recorded as who added it, and nothing more:
   * the row survives that person being deleted.
   */
  createForOrg(
    organizationId: string,
    actorUserId: string,
    dto: CreateGitCredentialDto,
  ): Promise<GitCredentialView> {
    return this.store(dto, { userId: actorUserId, organizationId });
  }

  /** The caller's own credentials — never the org ones they happened to add. */
  async list(userId: string): Promise<GitCredentialView[]> {
    const rows = await this.prisma.gitCredential.findMany({
      where: { userId, organizationId: null, kind: 'PAT' },
      orderBy: { createdAt: 'desc' },
      select: CREDENTIAL_SELECT,
    });
    return rows.map(toView);
  }

  async listForOrg(organizationId: string): Promise<GitCredentialView[]> {
    const rows = await this.prisma.gitCredential.findMany({
      where: { organizationId, kind: 'PAT' },
      orderBy: { createdAt: 'desc' },
      select: CREDENTIAL_SELECT,
    });
    return rows.map(toView);
  }

  /**
   * Scoped to the caller in the same statement that deletes, so someone else's
   * credential is a 404 rather than a permission check that could be forgotten.
   * `organizationId: null` keeps this to personal rows: an org credential is
   * not the adder's to delete from here, even though they added it.
   */
  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.gitCredential.deleteMany({
      where: { id, userId, organizationId: null },
    });
    if (count === 0) throw new NotFoundException('Credential not found');
  }

  async removeForOrg(organizationId: string, id: string): Promise<void> {
    const { count } = await this.prisma.gitCredential.deleteMany({
      where: { id, organizationId },
    });
    if (count === 0) throw new NotFoundException('Credential not found');
  }

  /** The org-level switch controlling whether members may add their own. */
  async setMemberPolicy(
    organizationId: string,
    allowMemberGitCredentials: boolean,
  ): Promise<{ allowMemberGitCredentials: boolean }> {
    try {
      const org = await this.prisma.organization.update({
        where: { id: organizationId },
        data: { allowMemberGitCredentials },
        select: { allowMemberGitCredentials: true },
      });
      return org;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Organization not found');
      }
      throw err;
    }
  }

  /**
   * A company that turns personal credentials off means it, so the strictest
   * policy the caller is subject to wins across every org they are a MEMBER or
   * VIEWER of. Admins and owners set the policy and are never blocked by it.
   */
  private async assertMayAddPersonal(userId: string): Promise<void> {
    const memberships = await this.prisma.orgMembership.findMany({
      where: { userId },
      select: {
        role: true,
        organization: { select: { allowMemberGitCredentials: true } },
      },
    });

    const allowed = mayAddPersonalCredential(
      memberships.map((m) => ({
        role: m.role,
        allowMemberGitCredentials: m.organization.allowMemberGitCredentials,
      })),
    );
    if (!allowed) {
      throw new ForbiddenException(
        'An administrator has disabled personal GitHub credentials for your organization',
      );
    }
  }

  /** The validate-then-store flow, shared by the personal and org routes. */
  private async store(
    dto: CreateGitCredentialDto,
    owner: { userId: string; organizationId: string | null },
  ): Promise<GitCredentialView> {
    const token = normalizeToken(dto.token);
    if (!isPlausibleToken(token)) {
      throw new BadRequestException('That does not look like a GitHub token');
    }

    const identity = await this.verify(token);

    // Deterministic under the master key, so the same token always lands on the
    // same fingerprint — which is what makes this check possible at all.
    const fingerprint = this.crypto
      .hashToken(token)
      .slice(0, FINGERPRINT_CHARS);

    // Scoped to the same owner: the same token may legitimately be both an
    // org credential and its adder's personal one.
    const existing = await this.prisma.gitCredential.findFirst({
      where: {
        kind: 'PAT',
        fingerprint,
        organizationId: owner.organizationId,
        ...(owner.organizationId === null ? { userId: owner.userId } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('That token is already stored');
    }

    const created = await this.prisma.gitCredential.create({
      data: {
        userId: owner.userId,
        organizationId: owner.organizationId,
        kind: 'PAT',
        label: dto.label?.trim() || null,
        secretEnc: this.crypto.encrypt(token),
        fingerprint,
        login: identity.login,
        scopes: identity.scopes ?? [],
      },
      select: CREDENTIAL_SELECT,
    });
    return toView(created);
  }

  /** Ask GitHub who this token is, and what it may do. */
  private async verify(token: string): Promise<GithubIdentity> {
    let res: globalThis.Response;
    try {
      res = await fetch(`${GITHUB_API}/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'lighthouse',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (err) {
      this.logger.warn(`github token check errored: ${String(err)}`);
      throw new BadGatewayException(
        'Could not reach GitHub to check the token',
      );
    }

    if (res.status === 401) {
      throw new BadRequestException(
        'GitHub rejected this token — check it has not expired or been revoked',
      );
    }
    // Anything else non-OK is GitHub's problem, not the token's: a 403 here is
    // usually rate limiting or SSO enforcement, and calling that "a bad token"
    // would send someone off to regenerate a credential that was fine.
    if (!res.ok) {
      this.logger.warn(`github token check failed: ${res.status}`);
      throw new BadGatewayException(
        `GitHub could not verify the token (${res.status})`,
      );
    }

    const body = (await res.json()) as { login?: unknown };
    return {
      login: typeof body.login === 'string' ? body.login : null,
      scopes: parseOauthScopes(res.headers.get('x-oauth-scopes')),
    };
  }
}

function toView(row: CredentialRow): GitCredentialView {
  return {
    id: row.id,
    label: row.label,
    login: row.login,
    fingerprint: row.fingerprint,
    scopes: row.scopes,
    hasRepoScope: hasRepoScope(row.scopes),
    createdAt: row.createdAt.toISOString(),
    addedBy: row.user,
  };
}
