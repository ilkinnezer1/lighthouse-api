import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { JiraApiService, JiraSite } from '../jira/jira-api.service';
import { PrismaService } from '../prisma/prisma.service';
import { signState, verifyState } from './oauth-state';

// `offline_access` is what earns a refresh token; without it the connection
// dies at the first token expiry and every branch quietly loses its title.
const OAUTH_SCOPES = 'read:me read:jira-user read:jira-work offline_access';

export interface AtlassianConnection {
  provider: 'atlassian';
  accountEmail: string;
  scopes: string[];
  connectedAt: string;
  sites: JiraSite[];
}

@Injectable()
export class AtlassianOauthService {
  private readonly logger = new Logger(AtlassianOauthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly jira: JiraApiService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.clientId() && this.clientSecret());
  }

  private authUrl(): string {
    return this.config.get('ATLASSIAN_AUTH_URL', { infer: true });
  }

  private apiUrl(): string {
    return this.config.get('ATLASSIAN_API_URL', { infer: true });
  }

  authorizeUrl(userId: string): string {
    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: this.clientId() ?? '',
      scope: OAUTH_SCOPES,
      redirect_uri: this.callbackUrl(),
      state: signState(userId),
      response_type: 'code',
      // Atlassian only returns a refresh token when consent is re-granted, so
      // a reconnect that skipped the prompt would come back without one.
      prompt: 'consent',
    });
    return `${this.authUrl()}/authorize?${params.toString()}`;
  }

  async handleCallback(
    userId: string,
    code: string,
    state: string,
  ): Promise<void> {
    if (!verifyState(state, userId)) {
      throw new ForbiddenException('Invalid OAuth state');
    }

    const token = await this.exchangeCode(code);
    const account = await this.fetchAccount(token.accessToken);

    await this.prisma.userIdentity.upsert({
      where: {
        provider_providerUserId: {
          provider: 'ATLASSIAN',
          providerUserId: account.accountId,
        },
      },
      create: {
        userId,
        provider: 'ATLASSIAN',
        providerUserId: account.accountId,
        providerEmail: account.email,
        accessTokenEnc: this.crypto.encrypt(token.accessToken),
        refreshTokenEnc: token.refreshToken
          ? this.crypto.encrypt(token.refreshToken)
          : null,
        tokenExpiresAt: token.expiresAt,
        scopes: token.scopes,
      },
      update: {
        userId,
        providerEmail: account.email,
        accessTokenEnc: this.crypto.encrypt(token.accessToken),
        refreshTokenEnc: token.refreshToken
          ? this.crypto.encrypt(token.refreshToken)
          : null,
        tokenExpiresAt: token.expiresAt,
        scopes: token.scopes,
      },
    });
  }

  async listConnections(userId: string): Promise<AtlassianConnection[]> {
    const identities = await this.prisma.userIdentity.findMany({
      where: { userId, provider: 'ATLASSIAN', accessTokenEnc: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (identities.length === 0) {
      return [];
    }

    const sites = await this.jira.listSites(userId);
    return identities.map((identity) => ({
      provider: 'atlassian' as const,
      accountEmail: identity.providerEmail ?? '',
      scopes: identity.scopes,
      connectedAt: identity.createdAt.toISOString(),
      sites,
    }));
  }

  async disconnect(userId: string): Promise<void> {
    await this.prisma.userIdentity.deleteMany({
      where: { userId, provider: 'ATLASSIAN' },
    });
  }

  private async exchangeCode(code: string): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
    scopes: string[];
  }> {
    let res: Response;
    try {
      res = await fetch(`${this.authUrl()}/oauth/token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: this.clientId(),
          client_secret: this.clientSecret(),
          code,
          redirect_uri: this.callbackUrl(),
        }),
      });
    } catch (err) {
      throw new BadGatewayException(
        `Atlassian token exchange errored: ${String(err)}`,
      );
    }
    if (!res.ok) {
      throw new BadGatewayException(
        `Atlassian token exchange failed: ${res.status} ${res.statusText}`,
      );
    }

    // Body carries both tokens — never log it.
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!body.access_token) {
      throw new BadGatewayException('Atlassian token exchange rejected');
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: body.expires_in
        ? new Date(Date.now() + body.expires_in * 1000)
        : null,
      scopes: body.scope ? body.scope.split(' ').filter(Boolean) : [],
    };
  }

  private async fetchAccount(
    token: string,
  ): Promise<{ accountId: string; email: string | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl()}/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      throw new BadGatewayException(
        `Atlassian account lookup errored: ${String(err)}`,
      );
    }
    if (!res.ok) {
      throw new BadGatewayException(
        `Atlassian account lookup failed: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as {
      account_id?: string;
      email?: string | null;
    };
    if (!body.account_id) {
      throw new BadGatewayException('Atlassian account lookup incomplete');
    }
    return { accountId: body.account_id, email: body.email ?? null };
  }

  private clientId(): string | undefined {
    return this.config.get('ATLASSIAN_OAUTH_CLIENT_ID', { infer: true });
  }

  private clientSecret(): string | undefined {
    return this.config.get('ATLASSIAN_OAUTH_CLIENT_SECRET', { infer: true });
  }

  private callbackUrl(): string {
    return `${this.config.get('PUBLIC_API_URL', { infer: true })}/integrations/atlassian/callback`;
  }
}
