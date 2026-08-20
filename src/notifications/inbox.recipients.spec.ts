import {
  draftsFor,
  type DatabaseFacts,
  type DeploymentFacts,
  type FindingFacts,
  type LockFacts,
} from './inbox.recipients';
import {
  INBOX_ONLY_EVENTS,
  NOTIFICATION_EVENTS,
} from './notifications.constants';

const HOLDER = 'aysel-id';
const DEPLOYER = 'ruslan-id';

const PLACE = {
  projectId: 'project-1',
  projectName: 'Nina Care',
  environmentId: 'env-1',
  environmentName: 'production',
};

const deployment = (over: Partial<DeploymentFacts> = {}): DeploymentFacts => ({
  ...PLACE,
  deploymentId: 'deploy-1',
  triggeredByUserId: DEPLOYER,
  commitSha: 'abc1234def5678',
  commitMessage: 'Fix the checkout total\n\nlong body nobody wants',
  failure: null,
  ...over,
});

const lock = (over: Partial<LockFacts> = {}): LockFacts => ({
  ...PLACE,
  lockedByUserId: HOLDER,
  overriddenByUserId: null,
  overriddenByName: null,
  reason: 'regression pass',
  commitSha: 'abc1234def5678',
  commitMessage: 'Fix the checkout total',
  deploymentId: null,
  ...over,
});

const QA = 'aysel-qa-id';

const finding = (over: Partial<FindingFacts> = {}): FindingFacts => ({
  ...PLACE,
  findingId: 'finding-1',
  title: 'Checkout total is wrong for multi-currency carts',
  status: 'OPEN',
  deploymentId: 'deploy-1',
  commitSha: 'abc1234def5678',
  deployedByUserId: DEPLOYER,
  reportedByUserId: QA,
  reportedByName: 'Aysel',
  resolvedByUserId: null,
  resolvedByName: null,
  fixedInCommitSha: null,
  ...over,
});

const database = (over: Partial<DatabaseFacts> = {}): DatabaseFacts => ({
  ...PLACE,
  databaseId: 'db-1',
  databaseName: 'nina-care-pg',
  ownerUserId: DEPLOYER,
  failure: 'provisioning timed out',
  ...over,
});

describe('draftsFor', () => {
  describe('deployment outcomes', () => {
    it('addresses the person who triggered the deploy, and only them', () => {
      const drafts = draftsFor({
        event: NOTIFICATION_EVENTS.DeployFailed,
        deployment: deployment({ failure: 'stage build: exit 1' }),
      });

      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toEqual({
        userId: DEPLOYER,
        kind: 'deploy.failed',
        title: 'Deploy failed — Nina Care / production',
        body: 'stage build: exit 1',
        link: '/deployments/deploy-1',
        context: {
          projectId: 'project-1',
          projectName: 'Nina Care',
          environmentId: 'env-1',
          environmentName: 'production',
          deploymentId: 'deploy-1',
          commitSha: 'abc1234def5678',
        },
      });
    });

    // The rule the whole feature rests on: no name, no row.
    it.each([
      NOTIFICATION_EVENTS.DeploySucceeded,
      NOTIFICATION_EVENTS.DeployFailed,
      NOTIFICATION_EVENTS.DeployCancelled,
    ])('writes nothing for %s when nobody triggered it', (event) => {
      expect(
        draftsFor({
          event,
          deployment: deployment({ triggeredByUserId: null }),
        }),
      ).toEqual([]);
    });

    it('carries the canonical event through as the kind', () => {
      const succeeded = draftsFor({
        event: NOTIFICATION_EVENTS.DeploySucceeded,
        deployment: deployment(),
      });
      const cancelled = draftsFor({
        event: NOTIFICATION_EVENTS.DeployCancelled,
        deployment: deployment(),
      });

      expect(succeeded[0].kind).toBe('deploy.succeeded');
      expect(succeeded[0].title).toBe(
        'Deploy succeeded — Nina Care / production',
      );
      expect(cancelled[0].kind).toBe('deploy.cancelled');
      expect(cancelled[0].title).toBe(
        'Deploy cancelled — Nina Care / production',
      );
    });

    it('summarises the commit for a non-failure, short sha and first line only', () => {
      const [draft] = draftsFor({
        event: NOTIFICATION_EVENTS.DeploySucceeded,
        deployment: deployment(),
      });

      expect(draft.body).toBe('abc1234 Fix the checkout total');
    });

    it('omits commitSha from the context when the deploy has no commit', () => {
      const [draft] = draftsFor({
        event: NOTIFICATION_EVENTS.DeploySucceeded,
        deployment: deployment({ commitSha: null, commitMessage: null }),
      });

      expect(draft.body).toBeNull();
      expect(draft.context).not.toHaveProperty('commitSha');
    });
  });

  describe('a push refused by a lock', () => {
    // The holder is the one who can act on it; the pusher is unresolvable.
    it('addresses the lock holder and links to the environment', () => {
      const drafts = draftsFor({
        event: NOTIFICATION_EVENTS.DeploySkippedLocked,
        lock: lock(),
      });

      expect(drafts).toHaveLength(1);
      expect(drafts[0].userId).toBe(HOLDER);
      expect(drafts[0].kind).toBe('deploy.skipped_locked');
      expect(drafts[0].title).toBe(
        'Push not deployed — Nina Care / production is locked',
      );
      expect(drafts[0].body).toBe(
        'abc1234 Fix the checkout total was not deployed because you hold the lock (regression pass).',
      );
      expect(drafts[0].link).toBe('/projects/project-1/env/env-1');
    });

    it('writes nothing when the lock has no holder', () => {
      expect(
        draftsFor({
          event: NOTIFICATION_EVENTS.DeploySkippedLocked,
          lock: lock({ lockedByUserId: null }),
        }),
      ).toEqual([]);
    });
  });

  describe('a lock somebody overrode', () => {
    it('addresses the holder and links to what was shipped anyway', () => {
      const drafts = draftsFor({
        event: NOTIFICATION_EVENTS.LockOverridden,
        lock: lock({
          overriddenByUserId: DEPLOYER,
          overriddenByName: 'Ruslan',
          deploymentId: 'deploy-9',
        }),
      });

      expect(drafts).toHaveLength(1);
      expect(drafts[0].userId).toBe(HOLDER);
      expect(drafts[0].kind).toBe('lock.overridden');
      expect(drafts[0].title).toBe('Lock overridden — Nina Care / production');
      expect(drafts[0].body).toBe(
        'Ruslan deployed to production while you held the lock.',
      );
      expect(drafts[0].link).toBe('/deployments/deploy-9');
      expect(drafts[0].context.deploymentId).toBe('deploy-9');
    });

    // The deploy gate exempts the holder, so this should be unreachable —
    // but telling somebody they overrode themselves is the worst kind of noise.
    it('never tells the holder they overrode their own lock', () => {
      expect(
        draftsFor({
          event: NOTIFICATION_EVENTS.LockOverridden,
          lock: lock({ overriddenByUserId: HOLDER, deploymentId: 'deploy-9' }),
        }),
      ).toEqual([]);
    });

    it('writes nothing when the lock has no holder', () => {
      expect(
        draftsFor({
          event: NOTIFICATION_EVENTS.LockOverridden,
          lock: lock({ lockedByUserId: null, overriddenByUserId: DEPLOYER }),
        }),
      ).toEqual([]);
    });

    it('falls back to the environment when no deployment is known', () => {
      const [draft] = draftsFor({
        event: NOTIFICATION_EVENTS.LockOverridden,
        lock: lock({ overriddenByUserId: DEPLOYER }),
      });

      expect(draft.link).toBe('/projects/project-1/env/env-1');
      expect(draft.body).toBe(
        'Somebody deployed to production while you held the lock.',
      );
    });
  });

  describe('managed databases', () => {
    it('addresses the resolved owner and links to the database', () => {
      const drafts = draftsFor({
        event: NOTIFICATION_EVENTS.DatabaseProvisionFailed,
        database: database(),
      });

      expect(drafts).toHaveLength(1);
      expect(drafts[0].userId).toBe(DEPLOYER);
      expect(drafts[0].kind).toBe('database.provision_failed');
      expect(drafts[0].title).toBe(
        'Database provisioning failed — nina-care-pg',
      );
      expect(drafts[0].link).toBe(
        '/projects/project-1/env/env-1/databases/db-1',
      );
      expect(drafts[0].context).not.toHaveProperty('deploymentId');
    });

    it('titles a snapshot failure as its own thing', () => {
      const [draft] = draftsFor({
        event: NOTIFICATION_EVENTS.SnapshotFailed,
        database: database({ failure: 'pg_dump exited 1' }),
      });

      expect(draft.kind).toBe('database.snapshot_failed');
      expect(draft.title).toBe('Snapshot failed — nina-care-pg');
      expect(draft.body).toBe('pg_dump exited 1');
    });

    it('writes nothing when no owner can be resolved', () => {
      expect(
        draftsFor({
          event: NOTIFICATION_EVENTS.SnapshotFailed,
          database: database({ ownerUserId: null }),
        }),
      ).toEqual([]);
    });
  });

  // Every route through the resolver is one person or nobody. Anything that
  // returned a second recipient would be the org-wide fan-out this replaces.
  it('never addresses more than one person', () => {
    const all = [
      draftsFor({
        event: NOTIFICATION_EVENTS.DeploySucceeded,
        deployment: deployment(),
      }),
      draftsFor({
        event: NOTIFICATION_EVENTS.DeployFailed,
        deployment: deployment(),
      }),
      draftsFor({
        event: NOTIFICATION_EVENTS.DeployCancelled,
        deployment: deployment(),
      }),
      draftsFor({
        event: NOTIFICATION_EVENTS.DeploySkippedLocked,
        lock: lock(),
      }),
      draftsFor({
        event: NOTIFICATION_EVENTS.LockOverridden,
        lock: lock({ overriddenByUserId: DEPLOYER }),
      }),
      draftsFor({
        event: NOTIFICATION_EVENTS.DatabaseProvisionFailed,
        database: database(),
      }),
      draftsFor({
        event: NOTIFICATION_EVENTS.SnapshotFailed,
        database: database(),
      }),
    ];

    for (const drafts of all) {
      expect(drafts).toHaveLength(1);
      expect(new Set(drafts.map((d) => d.userId)).size).toBe(1);
    }
  });

  it('keeps every link relative so the SPA can route it', () => {
    const links = [
      ...draftsFor({
        event: NOTIFICATION_EVENTS.DeployFailed,
        deployment: deployment(),
      }),
      ...draftsFor({
        event: NOTIFICATION_EVENTS.DeploySkippedLocked,
        lock: lock(),
      }),
      ...draftsFor({
        event: NOTIFICATION_EVENTS.LockOverridden,
        lock: lock({ overriddenByUserId: DEPLOYER, deploymentId: 'deploy-9' }),
      }),
      ...draftsFor({
        event: NOTIFICATION_EVENTS.SnapshotFailed,
        database: database(),
      }),
    ].map((d) => d.link);

    for (const link of links) {
      expect(link?.startsWith('/')).toBe(true);
      expect(link).not.toMatch(/^https?:/);
    }
  });

  describe('findings', () => {
    it('tells the person whose build it is, and nobody else', () => {
      const drafts = draftsFor({
        event: INBOX_ONLY_EVENTS.FindingCreated,
        finding: finding(),
      });

      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toEqual({
        userId: DEPLOYER,
        kind: 'finding.created',
        title: 'New finding — Nina Care / production',
        body: 'Checkout total is wrong for multi-currency carts — reported by Aysel on abc1234',
        link: '/deployments/deploy-1?finding=finding-1',
        context: {
          projectId: 'project-1',
          projectName: 'Nina Care',
          environmentId: 'env-1',
          environmentName: 'production',
          deploymentId: 'deploy-1',
          findingId: 'finding-1',
          commitSha: 'abc1234def5678',
        },
      });
    });

    it('says nothing when you file against your own deploy', () => {
      expect(
        draftsFor({
          event: INBOX_ONLY_EVENTS.FindingCreated,
          finding: finding({ reportedByUserId: DEPLOYER }),
        }),
      ).toEqual([]);
    });

    // Webhook deploys can land with no triggering user at all; there is nobody
    // to address, so it stays a channel concern rather than going to everyone.
    it('says nothing when the build has no owner', () => {
      expect(
        draftsFor({
          event: INBOX_ONLY_EVENTS.FindingCreated,
          finding: finding({ deployedByUserId: null }),
        }),
      ).toEqual([]);
    });

    it('tells the reporter which build fixed it', () => {
      const drafts = draftsFor({
        event: INBOX_ONLY_EVENTS.FindingResolved,
        finding: finding({
          status: 'FIXED',
          resolvedByUserId: DEPLOYER,
          resolvedByName: 'Ruslan',
          fixedInCommitSha: 'def5678abc1234',
        }),
      });

      expect(drafts).toHaveLength(1);
      expect(drafts[0].userId).toBe(QA);
      expect(drafts[0].title).toBe('Finding fixed — Nina Care / production');
      expect(drafts[0].body).toBe(
        'Checkout total is wrong for multi-currency carts — Ruslan marked it fixed in def5678',
      );
    });

    it('distinguishes a cannot-reproduce from a fix', () => {
      const drafts = draftsFor({
        event: INBOX_ONLY_EVENTS.FindingResolved,
        finding: finding({
          status: 'CANNOT_REPRODUCE',
          resolvedByUserId: DEPLOYER,
          resolvedByName: 'Ruslan',
        }),
      });

      expect(drafts[0].title).toBe('Finding closed — Nina Care / production');
      expect(drafts[0].body).toContain('could not reproduce it');
    });

    it('says nothing when you close your own finding', () => {
      expect(
        draftsFor({
          event: INBOX_ONLY_EVENTS.FindingResolved,
          finding: finding({ status: 'FIXED', resolvedByUserId: QA }),
        }),
      ).toEqual([]);
    });

    it('says nothing when the reporter is gone', () => {
      expect(
        draftsFor({
          event: INBOX_ONLY_EVENTS.FindingResolved,
          finding: finding({
            status: 'FIXED',
            reportedByUserId: null,
            resolvedByUserId: DEPLOYER,
          }),
        }),
      ).toEqual([]);
    });
  });
});
