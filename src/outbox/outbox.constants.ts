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
 */
export const OUTBOX_EVENT_TYPES = {
  DeploymentQueued: 'deployment.queued',
  DeploymentFailed: 'deployment.failed',
  DeploymentCancelled: 'deployment.cancelled',
} as const;

export type OutboxEventType =
  (typeof OUTBOX_EVENT_TYPES)[keyof typeof OUTBOX_EVENT_TYPES];
