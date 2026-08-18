import type { ConfigService } from '@nestjs/config';
import type { CryptoService } from '../crypto/crypto.service';
import type { PrismaService } from '../prisma/prisma.service';
import { JiraApiService } from './jira-api.service';

// The service's whole contract is "resolve what you can, never throw" — every
// failure mode here is a path a branch list depends on degrading quietly.

const CLOUD = 'cloud-1';
const USER = 'user-1';

type Identity = {
  id: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
};

function makeService(identity: Identity | null) {
  const update = jest.fn().mockResolvedValue({});
  const prisma = {
    userIdentity: {
      findFirst: jest.fn().mockResolvedValue(identity),
      update,
    },
  } as unknown as PrismaService;

  // Reversible stand-in for AES: keeps the assertions readable while still
  // proving the service encrypts what it persists.
  const crypto = {
    encrypt: (v: string) => `enc(${v})`,
    decrypt: (v: string) => v.replace(/^enc\(|\)$/g, ''),
  } as unknown as CryptoService;

  const env: Record<string, string> = {
    ATLASSIAN_OAUTH_CLIENT_ID: 'client-id',
    ATLASSIAN_OAUTH_CLIENT_SECRET: 'client-secret',
    ATLASSIAN_AUTH_URL: 'https://auth.atlassian.test',
    ATLASSIAN_API_URL: 'https://api.atlassian.test',
  };
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService<never, true>;

  const service = new JiraApiService(prisma, crypto, config);
  return { service, prisma, update };
}

function issuesResponse(issues: Record<string, string>) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        issues: Object.entries(issues).map(([key, summary]) => ({
          key,
          fields: { summary },
        })),
      }),
  };
}

const liveIdentity = (): Identity => ({
  id: 'identity-1',
  accessTokenEnc: 'enc(live-token)',
  refreshTokenEnc: 'enc(refresh-token)',
  tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
});

describe('JiraApiService.fetchSummaries', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves keys through one JQL batch and uppercases what it stores', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(issuesResponse({ 'PROJ-1': 'Add login' }));
    global.fetch = fetchMock;

    const { service } = makeService(liveIdentity());
    const out = await service.fetchSummaries(USER, CLOUD, ['PROJ-1']);

    expect(out.get('PROJ-1')).toBe('Add login');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.atlassian.test/ex/jira/${CLOUD}/rest/api/3/search/jql`,
    );
    const body = JSON.parse(init.body as string) as {
      jql: string;
      fields: string[];
    };
    expect(body.jql).toBe('issue in (PROJ-1)');
    // Asking for more fields than the summary is wasted payload on every render.
    expect(body.fields).toEqual(['summary']);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer live-token',
    );
  });

  it('serves a second lookup from cache without calling Jira again', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(issuesResponse({ 'PROJ-1': 'Add login' }));
    global.fetch = fetchMock;

    const { service } = makeService(liveIdentity());
    await service.fetchSummaries(USER, CLOUD, ['PROJ-1']);
    const second = await service.fetchSummaries(USER, CLOUD, ['PROJ-1']);

    expect(second.get('PROJ-1')).toBe('Add login');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Pieman re-queried unresolvable keys on every render; a branch naming a
  // deleted ticket would hit Jira forever.
  it('caches a miss, so an unresolvable key is not re-queried', async () => {
    const fetchMock = jest.fn().mockResolvedValue(issuesResponse({}));
    global.fetch = fetchMock;

    const { service } = makeService(liveIdentity());
    await service.fetchSummaries(USER, CLOUD, ['GONE-9']);
    const second = await service.fetchSummaries(USER, CLOUD, ['GONE-9']);

    expect(second.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not serve one user the summaries another user resolved', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(issuesResponse({ 'PROJ-1': 'Add login' }));
    global.fetch = fetchMock;

    const { service } = makeService(liveIdentity());
    await service.fetchSummaries(USER, CLOUD, ['PROJ-1']);
    await service.fetchSummaries('someone-else', CLOUD, ['PROJ-1']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('splits a large key set across batches', async () => {
    const fetchMock = jest.fn().mockResolvedValue(issuesResponse({}));
    global.fetch = fetchMock;

    const keys = Array.from({ length: 250 }, (_, i) => `PROJ-${i + 1}`);
    const { service } = makeService(liveIdentity());
    await service.fetchSummaries(USER, CLOUD, keys);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns nothing, and asks nothing, when the user has no connection', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const { service } = makeService(null);
    const out = await service.fetchSummaries(USER, CLOUD, ['PROJ-1']);

    expect(out.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades to no titles when Jira rejects the search', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
    global.fetch = fetchMock;

    const { service } = makeService(liveIdentity());
    await expect(
      service.fetchSummaries(USER, CLOUD, ['PROJ-1']),
    ).resolves.toEqual(new Map());
  });

  it('degrades when the network throws outright', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    global.fetch = fetchMock;

    const { service } = makeService(liveIdentity());
    await expect(
      service.fetchSummaries(USER, CLOUD, ['PROJ-1']),
    ).resolves.toEqual(new Map());
  });

  // A failed search must not be recorded as "this key has no summary", or a
  // transient Jira outage would blank every label for the cache's lifetime.
  it('does not cache a failed search as a miss', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
      .mockResolvedValueOnce(issuesResponse({ 'PROJ-1': 'Add login' }));
    global.fetch = fetchMock;

    const { service } = makeService(liveIdentity());
    await service.fetchSummaries(USER, CLOUD, ['PROJ-1']);
    const second = await service.fetchSummaries(USER, CLOUD, ['PROJ-1']);

    expect(second.get('PROJ-1')).toBe('Add login');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('JiraApiService token refresh', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const expiredIdentity = (): Identity => ({
    id: 'identity-1',
    accessTokenEnc: 'enc(stale-token)',
    refreshTokenEnc: 'enc(refresh-token)',
    tokenExpiresAt: new Date(Date.now() - 1000),
  });

  it('refreshes an expired token and persists the rotated pair', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'fresh-token',
            refresh_token: 'next-refresh',
            expires_in: 3600,
          }),
      })
      .mockResolvedValueOnce(issuesResponse({ 'PROJ-1': 'Add login' }));
    global.fetch = fetchMock;

    const { service, update } = makeService(expiredIdentity());
    const out = await service.fetchSummaries(USER, CLOUD, ['PROJ-1']);

    expect(out.get('PROJ-1')).toBe('Add login');
    const [refreshUrl] = fetchMock.mock.calls[0] as [string];
    expect(refreshUrl).toBe('https://auth.atlassian.test/oauth/token');

    // Atlassian rotates refresh tokens — keeping the old one breaks the next
    // refresh, so both halves must be written back encrypted.
    const [{ data: written }] = update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(written.accessTokenEnc).toBe('enc(fresh-token)');
    expect(written.refreshTokenEnc).toBe('enc(next-refresh)');
    expect(written.tokenExpiresAt).toBeInstanceOf(Date);

    const [, searchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((searchInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer fresh-token',
    );
  });

  it('degrades when the refresh itself is rejected', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });
    global.fetch = fetchMock;

    const { service, update } = makeService(expiredIdentity());
    await expect(
      service.fetchSummaries(USER, CLOUD, ['PROJ-1']),
    ).resolves.toEqual(new Map());
    expect(update).not.toHaveBeenCalled();
  });

  it('gives up rather than refreshing when there is no refresh token', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const { service } = makeService({
      ...expiredIdentity(),
      refreshTokenEnc: null,
    });
    await expect(
      service.fetchSummaries(USER, CLOUD, ['PROJ-1']),
    ).resolves.toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('JiraApiService.listSites', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps accessible-resources into sites', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 'cloud-1', name: 'Acme', url: 'https://acme.atlassian.net' },
          { id: 'cloud-2', url: 'https://other.atlassian.net' },
          { name: 'no id or url' },
        ]),
    });
    global.fetch = fetchMock;

    const { service } = makeService(liveIdentity());
    const sites = await service.listSites(USER);

    expect(sites).toEqual([
      { cloudId: 'cloud-1', name: 'Acme', url: 'https://acme.atlassian.net' },
      {
        cloudId: 'cloud-2',
        name: 'https://other.atlassian.net',
        url: 'https://other.atlassian.net',
      },
    ]);
  });

  it('is empty when the account has no connection', async () => {
    const { service } = makeService(null);
    await expect(service.listSites(USER)).resolves.toEqual([]);
  });
});
