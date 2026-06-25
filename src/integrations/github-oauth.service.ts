import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { GithubApiService } from '../github/github-api.service';
import { PrismaService } from '../prisma/prisma.service';
import { signState, verifyState } from './oauth-state';

const GITHUB_OAUTH = 'https://github.com/login/oauth';
const GITHUB_API = 'https://api.github.com';
const OAUTH_SCOPES = 'repo read:org';

export interface Connection {
  provider: 'github';
  accountLogin: string;
  scopes: string[];
  connectedAt: string;
}

@Injectable()
export class GithubOauthService {
  private readonly logger = new Logger(GithubOauthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly github: GithubApiService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.clientId() && this.clientSecret());
  }

  authorizeUrl(userId: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId() ?? '',
      redirect_uri: this.callbackUrl(),
      scope: OAUTH_SCOPES,
      state: signState(userId),
      allow_signup: 'false',
    });
    return `${GITHUB_OAUTH}/authorize?${params.toString()}`;
  }

  async handleCallback(
    userId: string,
    code: string,
    state: string,
  ): Promise<void> {
    if (!verifyState(state, userId)) {
      throw new ForbiddenException('Invalid OAuth state');
    }

    const { accessToken, scopes } = await this.exchangeCode(code);
    const account = await this.fetchAccount(accessToken);

    await this.prisma.userIdentity.upsert({
      where: {
        provider_providerUserId: {
          provider: 'GITHUB',
          providerUserId: String(account.id),
        },
      },
      create: {
        userId,
        provider: 'GITHUB',
        providerUserId: String(account.id),
        providerEmail: account.email,
        accessTokenEnc: this.crypto.encrypt(accessToken),
        scopes,
      },
      update: {
        userId,
        providerEmail: account.email,
        accessTokenEnc: this.crypto.encrypt(accessToken),
        scopes,
      },
    });
  }

  async listConnections(userId: string): Promise<Connection[]> {
    const identities = await this.prisma.userIdentity.findMany({
      where: { userId, provider: 'GITHUB', accessTokenEnc: { not: null } },
      orderBy: { createdAt: 'desc' },
    });

    const login = identities.length
      ? await this.github.getOwnerLogin(userId)
      : null;

    return identities.map((identity) => ({
      provider: 'github' as const,
      accountLogin: login ?? identity.providerEmail ?? '',
      scopes: identity.scopes,
      connectedAt: identity.createdAt.toISOString(),
    }));
  }

  async disconnect(userId: string): Promise<void> {
    const identity = await this.prisma.userIdentity.findFirst({
      where: { userId, provider: 'GITHUB' },
    });

    if (identity?.accessTokenEnc && this.isConfigured()) {
      await this.revokeGrant(identity.accessTokenEnc);
    }

    await this.prisma.userIdentity.deleteMany({
      where: { userId, provider: 'GITHUB' },
    });
  }

  private async exchangeCode(
    code: string,
  ): Promise<{ accessToken: string; scopes: string[] }> {
    let res: Response;
    try {
      res = await fetch(`${GITHUB_OAUTH}/access_token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'lighthouse',
        },
        body: JSON.stringify({
          client_id: this.clientId(),
          client_secret: this.clientSecret(),
          code,
          redirect_uri: this.callbackUrl(),
        }),
      });
    } catch (err) {
      throw new BadGatewayException(
        `GitHub token exchange errored: ${String(err)}`,
      );
    }

    if (!res.ok) {
      throw new BadGatewayException(
        `GitHub token exchange failed: ${res.status} ${res.statusText}`,
      );
    }

    // Body carries the access token — never log it.
    const body = (await res.json()) as {
      access_token?: string;
      scope?: string;
      error?: string;
    };
    if (body.error || !body.access_token) {
      throw new BadGatewayException('GitHub token exchange rejected');
    }

    const scopes = body.scope
      ? body.scope
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    return { accessToken: body.access_token, scopes };
  }

  private async fetchAccount(
    token: string,
  ): Promise<{ id: number; login: string; email: string | null }> {
    let res: Response;
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
      throw new BadGatewayException(
        `GitHub user lookup errored: ${String(err)}`,
      );
    }
    if (!res.ok) {
      throw new BadGatewayException(
        `GitHub user lookup failed: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as {
      id?: number;
      login?: string;
      email?: string | null;
    };
    if (!body.id || !body.login) {
      throw new BadGatewayException('GitHub user lookup incomplete');
    }
    return { id: body.id, login: body.login, email: body.email ?? null };
  }

  private async revokeGrant(accessTokenEnc: string): Promise<void> {
    try {
      const token = this.crypto.decrypt(accessTokenEnc);
      const basic = Buffer.from(
        `${this.clientId()}:${this.clientSecret()}`,
      ).toString('base64');
      const res = await fetch(
        `${GITHUB_API}/applications/${this.clientId()}/grant`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${basic}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'lighthouse',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ access_token: token }),
        },
      );
      if (!res.ok) {
        this.logger.warn(
          `github grant revoke failed: ${res.status} ${res.statusText}`,
        );
      }
    } catch (err) {
      // Best-effort: a failed remote revoke must not block local deletion.
      this.logger.warn(`github grant revoke errored: ${String(err)}`);
    }
  }

  private clientId(): string | undefined {
    return this.config.get('GITHUB_OAUTH_CLIENT_ID', { infer: true });
  }

  private clientSecret(): string | undefined {
    return this.config.get('GITHUB_OAUTH_CLIENT_SECRET', { infer: true });
  }

  private callbackUrl(): string {
    return `${this.config.get('PUBLIC_API_URL', { infer: true })}/integrations/github/callback`;
  }
}
