/**
 * Canonical `type` strings written to `event_outbox`.
 *
 * The Go worker writes its own stage / completion events directly via SQL
 * (e.g. `deployment.succeeded`, `deployment.failed`, `deployment.stage_*`).
 * Only events produced by the Nest side belong in this file.
 *
 * `DeploymentFailed` and `DeploymentCancelled` share `type` strings with
 * worker-emitted events on purpose — downstream consumers don't care which
 * process wrote the row, only what happened. The Nest side emits them from
 * the reaper (worker presumed dead) and from cancel-before-pickup.
 *
 * Managed-database lifecycle: Nest emits the `*_queued` intent events below
 * when it inserts a row and hands work to the worker, plus
 * `DatabaseProvisionFailed` / `SnapshotFailed` from the reaper when the worker
 * is presumed dead — these share `type` strings with worker-emitted failures,
 * exactly like `Deployment*` above. The worker writes the success completions
 * (`database.provisioned`, `database.snapshot_ready`,
 * `database.snapshot_restored`, ...) directly via SQL, so those stay out of
 * this file.
 */
export const OUTBOX_EVENT_TYPES = {
  DeploymentQueued: 'deployment.queued',
  DeploymentFailed: 'deployment.failed',
  DeploymentCancelled: 'deployment.cancelled',

  DatabaseProvisionQueued: 'database.provision_queued',
  DatabaseTeardownQueued: 'database.teardown_queued',
  SnapshotQueued: 'database.snapshot_queued',
  SnapshotRestoreQueued: 'database.snapshot_restore_queued',
  SnapshotDeleteQueued: 'database.snapshot_delete_queued',

  // Shared with worker-emitted failures; Nest writes them from the reaper.
  DatabaseProvisionFailed: 'database.provision_failed',
  SnapshotFailed: 'database.snapshot_failed',
} as const;

export type OutboxEventType =
  (typeof OUTBOX_EVENT_TYPES)[keyof typeof OUTBOX_EVENT_TYPES];
