import type { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import type { GithubApiService } from '../github/github-api.service';
import type { AtlassianOauthService } from './atlassian-oauth.service';
import type { GitCredentialsService } from './git-credentials.service';
import type { GithubOauthService } from './github-oauth.service';
import { IntegrationsController } from './integrations.controller';

const USER = { id: 'user-1', role: 'USER' } as unknown as User;

const GITHUB_CONNECTION = {
  provider: 'github' as const,
  accountLogin: 'aysel',
  scopes: ['repo'],
  connectedAt: '2026-08-20T11:00:00.000Z',
};

function controller(opts: {
  githubConfigured: boolean;
  atlassianConfigured: boolean;
  githubConnections?: unknown[];
  atlassianConnections?: unknown[];
  gitCredentials?: unknown[];
}) {
  const githubOauth = {
    isConfigured: () => opts.githubConfigured,
    listConnections: () => Promise.resolve(opts.githubConnections ?? []),
  } as unknown as GithubOauthService;

  const atlassianOauth = {
    isConfigured: () => opts.atlassianConfigured,
    listConnections: () => Promise.resolve(opts.atlassianConnections ?? []),
  } as unknown as AtlassianOauthService;

  const gitCredentials = {
    list: () => Promise.resolve(opts.gitCredentials ?? []),
  } as unknown as GitCredentialsService;

  return new IntegrationsController(
    githubOauth,
    atlassianOauth,
    gitCredentials,
    {} as unknown as GithubApiService,
    {} as unknown as ConfigService<never, true>,
  );
}

describe('GET /integrations', () => {
  // The bug this fixes: with no OAuth App credentials set, the client rendered
  // an enabled "Connect GitHub" button, and clicking it left the SPA on a raw
  // 503 JSON body. The payload has to say which providers are even usable.
  it('reports each provider as configured or not', async () => {
    const both = await controller({
      githubConfigured: true,
      atlassianConfigured: true,
    }).list(USER);
    expect(both.providers).toEqual({
      github: { configured: true },
      atlassian: { configured: true },
    });

    const neither = await controller({
      githubConfigured: false,
      atlassianConfigured: false,
    }).list(USER);
    expect(neither.providers).toEqual({
      github: { configured: false },
      atlassian: { configured: false },
    });
  });

  // The two are independent: in dev, GitHub is commonly set and Atlassian not.
  it('reports the two providers independently', async () => {
    const { providers } = await controller({
      githubConfigured: true,
      atlassianConfigured: false,
    }).list(USER);

    expect(providers.github.configured).toBe(true);
    expect(providers.atlassian.configured).toBe(false);
  });

  it('always carries both flags, even with no connections at all', async () => {
    const { providers } = await controller({
      githubConfigured: false,
      atlassianConfigured: false,
    }).list(USER);

    expect(Object.keys(providers).sort()).toEqual(['atlassian', 'github']);
    for (const status of Object.values(providers)) {
      expect(typeof status.configured).toBe('boolean');
    }
  });

  // "Configured" and "connected" are orthogonal — credentials can be removed
  // after someone connected, and that must not read as "not configured".
  it('is independent of whether the user has connected', async () => {
    const { connections, providers } = await controller({
      githubConfigured: false,
      atlassianConfigured: false,
      githubConnections: [GITHUB_CONNECTION],
    }).list(USER);

    expect(connections).toEqual([GITHUB_CONNECTION]);
    expect(providers.github.configured).toBe(false);
  });

  // A PAT authenticates GitHub on its own, so the page must be able to say
  // "connected via token" even with no OAuth App configured.
  it('reports stored git credentials beside the configured flags', async () => {
    const credential = {
      id: 'cred-1',
      label: 'laptop',
      login: 'aysel',
      fingerprint: 'a1b2c3d4e5f6',
      scopes: ['repo'],
      hasRepoScope: true,
      createdAt: '2026-08-29T12:00:00.000Z',
    };
    const result = await controller({
      githubConfigured: false,
      atlassianConfigured: false,
      gitCredentials: [credential],
    }).list(USER);

    expect(result.gitCredentials).toEqual([credential]);
    expect(result.providers.github.configured).toBe(false);
  });

  it('reports an empty credential list rather than omitting it', async () => {
    const result = await controller({
      githubConfigured: true,
      atlassianConfigured: true,
    }).list(USER);

    expect(result.gitCredentials).toEqual([]);
  });

  it('leaves the connections array exactly as it was', async () => {
    const atlassian = { provider: 'atlassian' as const, sites: [] };
    const result = await controller({
      githubConfigured: true,
      atlassianConfigured: true,
      githubConnections: [GITHUB_CONNECTION],
      atlassianConnections: [atlassian],
    }).list(USER);

    expect(result.connections).toEqual([GITHUB_CONNECTION, atlassian]);
  });

  // A boolean and nothing else — no ids, no secrets.
  it('never leaks credentials', async () => {
    const result = await controller({
      githubConfigured: true,
      atlassianConfigured: true,
    }).list(USER);

    const body = JSON.stringify(result);
    expect(body).not.toMatch(/client[_-]?id|client[_-]?secret/i);
    expect(Object.keys(result.providers.github)).toEqual(['configured']);
    expect(Object.keys(result.providers.atlassian)).toEqual(['configured']);
  });
});
