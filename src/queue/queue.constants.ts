/**
 * Redis Stream key. Worker's consumer group reads from here.
 */
export const BUILD_QUEUE_STREAM = 'jobs:build';
export const TEARDOWN_QUEUE_STREAM = 'jobs:teardown';

/**
 * Managed-database work. A single stream; the `type` field discriminates the
 * job (provision / teardown / snapshot / restore / snapshot_delete). Kept
 * separate from `jobs:build` because provisioning has different timeouts and
 * concurrency caps than a build.
 */
export const DATABASE_QUEUE_STREAM = 'jobs:database';

/**
 * Stream entry field carrying the deployment ID. Go reads this field.
 */
export const FIELD_DEPLOYMENT_ID = 'deploymentId';
export const FIELD_ENVIRONMENT_ID = 'environmentId';
export const FIELD_DATABASE_ID = 'databaseId';
export const FIELD_SNAPSHOT_ID = 'snapshotId';
export const FIELD_JOB_TYPE = 'type';

/**
 * `type` field values on `jobs:database` entries. Must match the worker's
 * Go-side switch.
 */
export const DATABASE_JOB_TYPES = {
  Provision: 'provision',
  Teardown: 'teardown',
  Snapshot: 'snapshot',
  Restore: 'restore',
  SnapshotDelete: 'snapshot_delete',
} as const;
export type DatabaseJobType =
  (typeof DATABASE_JOB_TYPES)[keyof typeof DATABASE_JOB_TYPES];

export const cancelChannel = (deploymentId: string): string => {
  return `cancel:deploy:${deploymentId}`;
};

/**
 * Volume-backup work. Its own stream rather than a `jobs:database` job type,
 * because those entries are keyed on `databaseId` and the worker's database
 * router rejects an entry without one — a volume backup is keyed on an
 * environment and a volume name instead.
 */
export const VOLUME_BACKUP_QUEUE_STREAM = 'jobs:volume-backup';

export const FIELD_BACKUP_ID = 'backupId';
export const FIELD_STORAGE_KEY = 'storageKey';

/**
 * `type` field values on `jobs:volume-backup` entries. Must match the worker's
 * Go-side switch in internal/volumebackup/router.go.
 */
export const VOLUME_BACKUP_JOB_TYPES = {
  Backup: 'volume_backup',
  Restore: 'volume_restore',
  Delete: 'volume_backup_delete',
} as const;
export type VolumeBackupJobType =
  (typeof VOLUME_BACKUP_JOB_TYPES)[keyof typeof VOLUME_BACKUP_JOB_TYPES];
