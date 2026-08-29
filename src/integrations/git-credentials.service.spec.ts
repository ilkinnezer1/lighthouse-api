import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { CryptoService } from '../crypto/crypto.service';
import type { PrismaService } from '../prisma/prisma.service';
import { GitCredentialsService } from './git-credentials.service';

const TOKEN = 'ghp_ARealLookingToken1234567890';
const USER = 'user-1';
const CREATED_AT = new Date('2026-08-29T12:00:00.000Z');

function githubReply(
  status: number,
  body: unknown = {},
  scopeHeader: string | null = 'repo, read:org',
) {
  const headers = new Headers();
  if (scopeHeader !== null) headers.set('x-oauth-scopes', scopeHeader);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: () => Promise.resolve(body),
  } as unknown as globalThis.Response;
}

interface Harness {
  service: GitCredentialsService;
  created: () => Record<string, unknown> | null;
  fetchMock: jest.Mock;
}

function harness(
  opts: {
    reply?: globalThis.Response;
    fetchRejects?: boolean;
    existing?: { id: string } | null;
    deleteCount?: number;
    memberships?: { role: string; allowMemberGitCredentials: boolean }[];
  } = {},
): Harness {
  let created: Record<string, unknown> | null = null;

  const prisma = {
    gitCredential: {
      findFirst: () => Promise.resolve(opts.existing ?? null),
      findMany: () => Promise.resolve([]),
      create: ({ data }: { data: Record<string, unknown> }) => {
        created = data;
        return Promise.resolve({
          id: 'cred-1',
          label: data.label,
          login: data.login,
          fingerprint: data.fingerprint,
          scopes: data.scopes,
          createdAt: CREATED_AT,
          user: {
            id: USER,
            username: 'aysel',
            displayName: null,
            email: 'a@e.com',
          },
        });
      },
      deleteMany: () => Promise.resolve({ count: opts.deleteCount ?? 1 }),
    },
    orgMembership: {
      findMany: () =>
        Promise.resolve(
          (opts.memberships ?? []).map((m) => ({
            role: m.role,
            organization: {
              allowMemberGitCredentials: m.allowMemberGitCredentials,
            },
          })),
        ),
    },
  } as unknown as PrismaService;

  const crypto = {
    encrypt: (plain: string) => `enc(${plain})`,
    hashToken: () => 'a1b2c3d4e5f6a7b8c9d0',
  } as unknown as CryptoService;

  const fetchMock = jest.fn(() =>
    opts.fetchRejects
      ? Promise.reject(new Error('ECONNREFUSED'))
      : Promise.resolve(opts.reply ?? githubReply(200, { login: 'aysel' })),
  );
  global.fetch = fetchMock;

  return {
    service: new GitCredentialsService(prisma, crypto),
    created: () => created,
    fetchMock,
  };
}

afterEach(() => jest.restoreAllMocks());

describe('create', () => {
  describe('validating the token before storing it', () => {
    // Storing an unverified token defers the failure to clone time, where it
    // surfaces as a git error on a deploy and tells nobody why.
    it('checks it against GitHub /user', async () => {
      const h = harness();
      await h.service.create(USER, { token: TOKEN });

      expect(h.fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = h.fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.github.com/user');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${TOKEN}`,
      );
    });

    it('rejects a token GitHub 401s with a 400 that says so', async () => {
      const h = harness({ reply: githubReply(401) });
      await expect(h.service.create(USER, { token: TOKEN })).rejects.toThrow(
        BadRequestException,
      );
      expect(h.created()).toBeNull();
    });

    // A 403 is usually rate limiting or SSO enforcement — calling that "a bad
    // token" sends someone off to regenerate a credential that was fine.
    it('blames GitHub, not the token, for a non-401 failure', async () => {
      const h = harness({ reply: githubReply(403) });
      await expect(h.service.create(USER, { token: TOKEN })).rejects.toThrow(
        BadGatewayException,
      );
    });

    it('does not store anything when GitHub is unreachable', async () => {
      const h = harness({ fetchRejects: true });
      await expect(h.service.create(USER, { token: TOKEN })).rejects.toThrow(
        BadGatewayException,
      );
      expect(h.created()).toBeNull();
    });

    it.each([
      ['empty', ''],
      ['whitespace only', '   '],
      ['containing a space', 'ghp_abc def ghi'],
    ])('rejects a %s token without calling GitHub', async (_l, token) => {
      const h = harness();
      await expect(h.service.create(USER, { token })).rejects.toThrow(
        BadRequestException,
      );
      expect(h.fetchMock).not.toHaveBeenCalled();
    });

    it('accepts a token pasted with a trailing newline', async () => {
      const h = harness();
      await h.service.create(USER, { token: `${TOKEN}\n` });
      expect(h.created()?.secretEnc).toBe(`enc(${TOKEN})`);
    });
  });

  describe('what it writes', () => {
    it('encrypts the token and stores the captured identity', async () => {
      const h = harness();
      const view = await h.service.create(USER, {
        token: TOKEN,
        label: '  laptop  ',
      });

      expect(h.created()).toMatchObject({
        userId: USER,
        kind: 'PAT',
        label: 'laptop',
        secretEnc: `enc(${TOKEN})`,
        login: 'aysel',
        scopes: ['repo', 'read:org'],
      });
      expect(view.hasRepoScope).toBe(true);
      expect(view.createdAt).toBe('2026-08-29T12:00:00.000Z');
    });

    it('stores a short fingerprint, never the token', async () => {
      const h = harness();
      const view = await h.service.create(USER, { token: TOKEN });

      expect(view.fingerprint).toBe('a1b2c3d4e5f6');
      expect(view.fingerprint).not.toContain(TOKEN);
    });

    // The audit interceptor records the response body verbatim.
    it('returns nothing that could reconstruct the token', async () => {
      const h = harness();
      const view = await h.service.create(USER, { token: TOKEN });

      expect(JSON.stringify(view)).not.toContain(TOKEN);
      expect(Object.keys(view).sort()).toEqual([
        'addedBy',
        'createdAt',
        'fingerprint',
        'hasRepoScope',
        'id',
        'label',
        'login',
        'scopes',
      ]);
    });

    it('normalizes a blank label to null', async () => {
      const h = harness();
      await h.service.create(USER, { token: TOKEN, label: '   ' });
      expect(h.created()?.label).toBeNull();
    });

    // A fine-grained PAT sends no x-oauth-scopes header at all.
    it('records unknown scopes rather than claiming none', async () => {
      const h = harness({
        reply: githubReply(200, { login: 'aysel' }, null),
      });
      const view = await h.service.create(USER, { token: TOKEN });

      expect(view.scopes).toEqual([]);
      expect(view.hasRepoScope).toBeNull();
    });

    it('flags a classic token that cannot read private repos', async () => {
      const h = harness({
        reply: githubReply(200, { login: 'aysel' }, 'public_repo, gist'),
      });
      const view = await h.service.create(USER, { token: TOKEN });

      expect(view.hasRepoScope).toBe(false);
    });
  });

  it('refuses a token that is already stored', async () => {
    const h = harness({ existing: { id: 'cred-0' } });
    await expect(h.service.create(USER, { token: TOKEN })).rejects.toThrow(
      ConflictException,
    );
    expect(h.created()).toBeNull();
  });
});

describe('remove', () => {
  it('deletes scoped to the caller', async () => {
    const h = harness({ deleteCount: 1 });
    await expect(h.service.remove(USER, 'cred-1')).resolves.toBeUndefined();
  });

  // Someone else's credential is a 404, not a 403 — the scoping is in the same
  // statement that deletes, so there is no check to forget.
  it('404s when the row is not the caller’s', async () => {
    const h = harness({ deleteCount: 0 });
    await expect(h.service.remove(USER, 'cred-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('the member toggle', () => {
  const membership = (role: string, allow: boolean) => ({
    role,
    allowMemberGitCredentials: allow,
  });

  it('lets a member add one when their org permits it', async () => {
    const h = harness({ memberships: [membership('MEMBER', true)] });
    await expect(
      h.service.create(USER, { token: TOKEN }),
    ).resolves.toBeDefined();
  });

  it.each(['MEMBER', 'VIEWER'])(
    'refuses a %s of an org that disabled it, before touching GitHub',
    async (role) => {
      const h = harness({ memberships: [membership(role, false)] });
      await expect(h.service.create(USER, { token: TOKEN })).rejects.toThrow(
        ForbiddenException,
      );
      // No token is validated and none is stored — the refusal is first.
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.created()).toBeNull();
    },
  );

  it.each(['OWNER', 'ADMIN'])('never blocks an %s', async (role) => {
    const h = harness({ memberships: [membership(role, false)] });
    await expect(
      h.service.create(USER, { token: TOKEN }),
    ).resolves.toBeDefined();
  });

  it('says an administrator disabled it', async () => {
    const h = harness({ memberships: [membership('MEMBER', false)] });
    await expect(h.service.create(USER, { token: TOKEN })).rejects.toThrow(
      /administrator has disabled personal GitHub credentials/,
    );
  });

  // An org credential is added BY an admin FOR the org; the member policy is
  // about personal credentials and must not gate it.
  it('does not gate the organization route', async () => {
    const h = harness({ memberships: [membership('MEMBER', false)] });
    await expect(
      h.service.createForOrg('org-1', USER, { token: TOKEN }),
    ).resolves.toBeDefined();
    expect(h.created()).toMatchObject({
      organizationId: 'org-1',
      userId: USER,
    });
  });
});
