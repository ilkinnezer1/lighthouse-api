/**
 * Canonical `type` strings written to `event_outbox`.
 *
 * The Go worker writes its own stage / completion events directly via SQL
 * (e.g. `deployment.succeeded`, `deployment.failed`, `deployment.stage_*`).
 * Only events produced by the Nest side belong in this file.
 */
export const OUTBOX_EVENT_TYPES = {
  DeploymentQueued: 'deployment.queued',
} as const;

export type OutboxEventType =
  (typeof OUTBOX_EVENT_TYPES)[keyof typeof OUTBOX_EVENT_TYPES];
