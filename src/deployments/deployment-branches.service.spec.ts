import { BadRequestException } from '@nestjs/common';
import type { GithubApiService } from '../github/github-api.service';
import type { BranchLabelsService } from '../jira/branch-labels.service';
import type { PrismaService } from '../prisma/prisma.service';
import { DeploymentBranchesService } from './deployment-branches.service';
import type { WorkerProxyService } from './worker-proxy.service';

const ENV_ID = 'env-1';
const PROJECT_ID = 'project-1';
const REPO_URL = 'https://github.com/acme/app.git';

interface Harness {
  service: DeploymentBranchesService;
  sentBody: () => Record<string, unknown> | null;
  workerJson: jest.Mock;
  listBranches: jest.Mock;
}

function harness(
  opts: { workerThrows?: boolean; linked?: boolean } = {},
): Harness {
  let sent: Record<string, unknown> | null = null;

  const prisma = {
    environment: {
      findUnique: () =>
        Promise.resolve({
          branch: 'main',
          project: {
            id: PROJECT_ID,
            repoUrl: REPO_URL,
            providerRepoFullName: opts.linked === false ? null : 'acme/app',
            organizationId: 'org-1',
            defaultBranch: 'main',
          },
        }),
    },
  } as unknown as PrismaService;

  const listBranches = jest.fn(() =>
    Promise.resolve([
      { name: 'main', sha: 'sha-main' },
      { name: 'feature/x', sha: 'sha-x' },
    ]),
  );
  const github = { listBranches } as unknown as GithubApiService;

  const branchLabels = {
    forBranches: () => Promise.resolve(new Map()),
  } as unknown as BranchLabelsService;

  const workerJson = jest.fn((_path: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string) as Record<string, unknown>;
    return opts.workerThrows
      ? Promise.reject(new Error('worker down'))
      : Promise.resolve({ mergeable: true });
  });
  const worker = { json: workerJson } as unknown as WorkerProxyService;

  return {
    service: new DeploymentBranchesService(
      prisma,
      github,
      branchLabels,
      worker,
    ),
    sentBody: () => sent,
    workerJson,
    listBranches,
  };
}

describe('checkMerge worker request', () => {
  const check = (h: Harness) =>
    h.service.checkMerge(ENV_ID, 'main', ['feature/x']);

  // The worker resolves the git credential from the project's ORGANIZATION.
  // It still returns 200 for the old `userId` body, so getting this wrong does
  // not fail loudly — a private repo just silently answers `mergeable: null`.
  it('identifies the project, not the requesting user', async () => {
    const h = harness();
    await check(h);

    expect(h.sentBody()).toMatchObject({ projectId: PROJECT_ID });
    expect(h.sentBody()).not.toHaveProperty('userId');
  });

  it('sends the full body the worker expects', async () => {
    const h = harness();
    await check(h);

    expect(h.sentBody()).toEqual({
      repoUrl: REPO_URL,
      projectId: PROJECT_ID,
      source: { name: 'main', sha: 'sha-main' },
      merges: [{ name: 'feature/x', sha: 'sha-x' }],
    });
  });

  it('posts to /merge-check as JSON', async () => {
    const h = harness();
    await check(h);

    const [path, init] = h.workerJson.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/merge-check');
    expect(init.method).toBe('POST');
  });

  it('answers without calling the worker when nothing is merged', async () => {
    const h = harness();
    await expect(h.service.checkMerge(ENV_ID, 'main', [])).resolves.toEqual({
      mergeable: true,
    });
    expect(h.workerJson).not.toHaveBeenCalled();
  });

  // "Could not tell" must never be rendered as "no conflicts".
  it('degrades to mergeable: null when the worker fails', async () => {
    const h = harness({ workerThrows: true });
    await expect(check(h)).resolves.toEqual({ mergeable: null });
  });
});

describe('resolve', () => {
  it('pins a GitHub-linked branch set to SHAs', async () => {
    const h = harness();
    await expect(
      h.service.resolve(ENV_ID, 'feature/x', ['main']),
    ).resolves.toEqual([
      { role: 'SOURCE', name: 'feature/x', sha: 'sha-x', ordinal: 0 },
      { role: 'MERGE', name: 'main', sha: 'sha-main', ordinal: 1 },
    ]);
  });

  describe('when the project is not linked to GitHub', () => {
    it("takes the plain path for the environment's branch", async () => {
      const h = harness({ linked: false });
      await expect(h.service.resolve(ENV_ID, 'main', [])).resolves.toEqual([]);
      expect(h.listBranches).not.toHaveBeenCalled();
    });

    it('deploys another branch by name, unpinned', async () => {
      const h = harness({ linked: false });
      await expect(
        h.service.resolve(ENV_ID, 'feature/x', undefined),
      ).resolves.toEqual([
        { role: 'SOURCE', name: 'feature/x', sha: null, ordinal: 0 },
      ]);
      expect(h.listBranches).not.toHaveBeenCalled();
    });

    it.each(['--upload-pack=x', 'a..b', 'a b', '.hidden', 'x.lock', 'x/'])(
      'rejects the unsafe branch name %p',
      async (name) => {
        const h = harness({ linked: false });
        await expect(h.service.resolve(ENV_ID, name, [])).rejects.toThrow(
          BadRequestException,
        );
      },
    );

    it('rejects merges with a message naming the requirement', async () => {
      const h = harness({ linked: false });
      await expect(
        h.service.resolve(ENV_ID, 'main', ['feature/x']),
      ).rejects.toThrow('Merging branches needs a GitHub-linked repository');
    });

    it('lets the merge check pass a lone branch', async () => {
      const h = harness({ linked: false });
      await expect(
        h.service.checkMerge(ENV_ID, 'feature/x', []),
      ).resolves.toEqual({ mergeable: true });
      expect(h.workerJson).not.toHaveBeenCalled();
    });
  });
});
