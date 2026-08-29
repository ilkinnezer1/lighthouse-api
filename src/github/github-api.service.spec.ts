import { HttpException } from '@nestjs/common';
import type { CryptoService } from '../crypto/crypto.service';
import type { PrismaService } from '../prisma/prisma.service';
import { GithubApiService } from './github-api.service';

const OWNER = 'user-1';

interface HarnessOpts {
  oauth?: string | null;
  pat?: string | null;
  /** The organization row `resolveOrgGitAuth` reads. */
  org?: {
    isPersonal: boolean;
    ownerId?: string;
    orgCredential?: string | null;
  } | null;
  /** The personal credential of a personal org's owner. */
  ownerPat?: string | null;
}

function harness(opts: HarnessOpts) {
  // Both the repo browser's PAT lookup and the personal-org owner fallback ask
  // the same question — a user's own credential — so one stub answers both.
  const personalPat = opts.ownerPat ?? opts.pat;
  const gitCredentialFindFirst = jest.fn(() =>
    Promise.resolve(
      personalPat
        ? { id: 'c-personal', secretEnc: `enc(${personalPat})` }
        : null,
    ),
  );

  const prisma = {
    userIdentity: {
      findFirst: () =>
        Promise.resolve(
          opts.oauth ? { accessTokenEnc: `enc(${opts.oauth})` } : null,
        ),
    },
    organization: {
      findUnique: () =>
        Promise.resolve(
          opts.org
            ? {
                isPersonal: opts.org.isPersonal,
                memberships: opts.org.ownerId
                  ? [{ userId: opts.org.ownerId }]
                  : [],
                gitCredentials: opts.org.orgCredential
                  ? [
                      {
                        id: 'c-org',
                        secretEnc: `enc(${opts.org.orgCredential})`,
                      },
                    ]
                  : [],
              }
            : null,
        ),
    },
    gitCredential: { findFirst: gitCredentialFindFirst },
  } as unknown as PrismaService;

  const crypto = {
    decrypt: (payload: string) => payload.replace(/^enc\(|\)$/g, ''),
  } as unknown as CryptoService;

  const fetchMock = jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    } as unknown as globalThis.Response),
  );
  global.fetch = fetchMock;

  return {
    service: new GithubApiService(prisma, crypto),
    fetchMock,
    gitCredentialFindFirst,
  };
}

const authOf = (fetchMock: jest.Mock) =>
  (
    (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >
  ).Authorization;

afterEach(() => jest.restoreAllMocks());

// Repo listing was the one GitHub call that never looked at `git_credentials`,
// so a user who pasted a PAT could clone private repos while the Integrations
// page still said "not connected".
describe('listRepos authentication', () => {
  it('uses the OAuth token when there is one', async () => {
    const h = harness({ oauth: 'oauth-token' });
    await h.service.listRepos(OWNER, {});
    expect(authOf(h.fetchMock)).toBe('Bearer oauth-token');
  });

  it('falls back to a stored PAT when OAuth is absent', async () => {
    const h = harness({ pat: 'pat-token' });
    await h.service.listRepos(OWNER, {});
    expect(authOf(h.fetchMock)).toBe('Bearer pat-token');
  });

  // OAuth first: it is the narrower, revocable grant.
  it('prefers OAuth when both exist', async () => {
    const h = harness({ oauth: 'oauth-token', pat: 'pat-token' });
    await h.service.listRepos(OWNER, {});
    expect(authOf(h.fetchMock)).toBe('Bearer oauth-token');
  });

  it('still throws 428 when neither exists', async () => {
    const h = harness({});
    await expect(h.service.listRepos(OWNER, {})).rejects.toThrow(HttpException);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('getOwnerLogin', () => {
  it('resolves the login from a PAT alone', async () => {
    const h = harness({ pat: 'pat-token' });
    h.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ login: 'aysel' }),
    } as unknown as globalThis.Response);

    await expect(h.service.getOwnerLogin(OWNER)).resolves.toBe('aysel');
    expect(authOf(h.fetchMock)).toBe('Bearer pat-token');
  });

  it('is null when the owner has no token of either kind', async () => {
    const h = harness({});
    await expect(h.service.getOwnerLogin(OWNER)).resolves.toBeNull();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

// The isolation guarantee, at the service level: org work resolves by the
// PROJECT'S ORGANIZATION, never by whoever created the project.
describe('resolveOrgGitAuth', () => {
  it('uses the organization’s own credential', async () => {
    const h = harness({
      org: { isPersonal: false, orgCredential: 'org-token' },
    });
    await expect(h.service.resolveOrgGitAuth('org-1')).resolves.toEqual({
      token: 'org-token',
      source: 'organization',
    });
  });

  // Every user gets a personal org at signup; solo use stays frictionless.
  it('falls back to the owner’s own credential in a personal org', async () => {
    const h = harness({
      org: { isPersonal: true, ownerId: 'user-1' },
      ownerPat: 'personal-token',
    });
    await expect(h.service.resolveOrgGitAuth('org-1')).resolves.toEqual({
      token: 'personal-token',
      source: 'personal-org-owner',
    });
  });

  // The bug this replaces: a member's personal token silently becoming the
  // company's deploy credential.
  it('refuses in a shared org, and never even reads a personal credential', async () => {
    const h = harness({
      org: { isPersonal: false, ownerId: 'user-1' },
      ownerPat: 'personal-token',
    });

    await expect(h.service.resolveOrgGitAuth('org-1')).resolves.toEqual({
      token: null,
      source: 'none',
    });
    // Not just "did not use it" — the shared-org path never looks it up.
    expect(h.gitCredentialFindFirst).not.toHaveBeenCalled();
  });

  it('is none for an organization that does not exist', async () => {
    const h = harness({ org: null });
    await expect(h.service.resolveOrgGitAuth('org-1')).resolves.toEqual({
      token: null,
      source: 'none',
    });
  });
});

describe('org work refuses rather than borrowing', () => {
  // An unconfigured shared org gets an actionable 428, not a generic upstream
  // failure that reads as "GitHub is broken".
  it('surfaces a private-repo 404 as a missing org credential', async () => {
    const h = harness({ org: { isPersonal: false } });
    h.fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: () => Promise.resolve({}),
    } as unknown as globalThis.Response);

    await expect(h.service.listBranches('org-1', 'acme/app')).rejects.toThrow(
      /No organization GitHub credential configured/,
    );
  });

  // A public repo in an org that never configured a credential still works —
  // an unauthenticated read borrows nobody's token, so refusing it would be a
  // regression with no isolation benefit.
  it('still lists branches of a public repo unauthenticated', async () => {
    const h = harness({ org: { isPersonal: false } });
    h.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ name: 'main', commit: { sha: 'abc' } }]),
    } as unknown as globalThis.Response);

    await expect(h.service.listBranches('org-1', 'acme/app')).resolves.toEqual([
      { name: 'main', sha: 'abc' },
    ]);
    const [, init] = h.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });
});
