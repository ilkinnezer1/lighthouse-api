import type { PrismaService } from '../prisma/prisma.service';
import { BranchLabelsService } from './branch-labels.service';
import type { JiraApiService } from './jira-api.service';

const ORG = 'org-1';
const USER = 'user-1';
const SITE = {
  atlassianCloudId: 'cloud-1',
  atlassianSiteUrl: 'https://acme.atlassian.net',
};

function makeService(
  org: {
    atlassianCloudId: string | null;
    atlassianSiteUrl: string | null;
  } | null,
  summaries: Record<string, string> = {},
) {
  const prisma = {
    organization: { findUnique: jest.fn().mockResolvedValue(org) },
  } as unknown as PrismaService;

  const fetchSummaries = jest
    .fn()
    .mockResolvedValue(new Map(Object.entries(summaries)));
  const jira = { fetchSummaries } as unknown as JiraApiService;

  return { service: new BranchLabelsService(prisma, jira), fetchSummaries };
}

describe('BranchLabelsService.labelBranches', () => {
  it('labels a branch whose ticket Jira knows', async () => {
    const { service } = makeService(SITE, { 'PROJ-12': 'Add login' });

    const labels = await service.labelBranches(USER, ORG, [
      'feature/PROJ-12-add-login',
    ]);

    expect(labels.get('feature/PROJ-12-add-login')).toEqual({
      issueKey: 'PROJ-12',
      issueTitle: 'Add login',
      issueUrl: 'https://acme.atlassian.net/browse/PROJ-12',
    });
  });

  // The key pattern cannot help matching ordinary names like `branch-1` or
  // `release-2`. Labelling those would replace a real branch name with an
  // invented ticket, so Jira's answer is what decides.
  it('leaves a branch alone when Jira does not recognize the key', async () => {
    const { service } = makeService(SITE, {});

    const labels = await service.labelBranches(USER, ORG, [
      'branch-1',
      'release-2',
    ]);

    expect(labels.size).toBe(0);
  });

  it('labels only the branches Jira confirmed, not the rest of the batch', async () => {
    const { service } = makeService(SITE, { 'PROJ-12': 'Add login' });

    const labels = await service.labelBranches(USER, ORG, [
      'feature/PROJ-12-add-login',
      'feature/PROJ-99-unknown',
      'branch-1',
      'main',
    ]);

    expect([...labels.keys()]).toEqual(['feature/PROJ-12-add-login']);
  });

  it('asks Jira nothing when no branch names a ticket', async () => {
    const { service, fetchSummaries } = makeService(SITE, {});

    const labels = await service.labelBranches(USER, ORG, ['main', 'develop']);

    expect(labels.size).toBe(0);
    expect(fetchSummaries).not.toHaveBeenCalled();
  });

  it('asks Jira nothing when the org has chosen no site', async () => {
    const { service, fetchSummaries } = makeService(
      { atlassianCloudId: null, atlassianSiteUrl: null },
      {},
    );

    const labels = await service.labelBranches(USER, ORG, [
      'feature/PROJ-12-add-login',
    ]);

    expect(labels.size).toBe(0);
    expect(fetchSummaries).not.toHaveBeenCalled();
  });

  it('dedupes the keys it asks about', async () => {
    const { service, fetchSummaries } = makeService(SITE, {
      'PROJ-12': 'Add login',
    });

    await service.labelBranches(USER, ORG, [
      'feature/PROJ-12-add-login',
      'hotfix/proj-12-again',
    ]);

    expect(fetchSummaries).toHaveBeenCalledWith(USER, 'cloud-1', ['PROJ-12']);
  });

  it('labels every branch that shares one ticket', async () => {
    const { service } = makeService(SITE, { 'PROJ-12': 'Add login' });

    const labels = await service.labelBranches(USER, ORG, [
      'feature/PROJ-12-add-login',
      'hotfix/proj-12-again',
    ]);

    expect(labels.size).toBe(2);
    expect(labels.get('hotfix/proj-12-again')?.issueTitle).toBe('Add login');
  });
});
