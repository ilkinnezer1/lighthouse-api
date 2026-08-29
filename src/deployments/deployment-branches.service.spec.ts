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
}

function harness(opts: { workerThrows?: boolean } = {}): Harness {
  let sent: Record<string, unknown> | null = null;

  const prisma = {
    environment: {
      findUnique: () =>
        Promise.resolve({
          branch: 'main',
          project: {
            id: PROJECT_ID,
            repoUrl: REPO_URL,
            providerRepoFullName: 'acme/app',
            organizationId: 'org-1',
          },
        }),
    },
  } as unknown as PrismaService;

  const github = {
    listBranches: () =>
      Promise.resolve([
        { name: 'main', sha: 'sha-main' },
        { name: 'feature/x', sha: 'sha-x' },
      ]),
  } as unknown as GithubApiService;

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
