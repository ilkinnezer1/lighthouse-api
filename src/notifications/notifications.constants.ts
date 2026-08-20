/**
 * Canonical event names a notification channel can subscribe to.
 *
 * `event_outbox` carries two naming schemes: the Go worker writes `deploy.*`
 * (`deploy.succeeded`, `deploy.failed`, `deploy.cancelled`) while Nest writes
 * `deployment.*` (`deployment.queued`, `deployment.failed`,
 * `deployment.cancelled`). They are NOT interchangeable — there is not a single
 * `deployment.failed` row in a database whose worker has failed 17 deploys.
 *
 * The WS gateway never noticed because `relayOutbox` forwards every event
 * without inspecting its type. A notifier does inspect the type, so it maps
 * both schemes onto the canonical names below rather than trusting either.
 */
export const NOTIFICATION_EVENTS = {
  DeploySucceeded: 'deploy.succeeded',
  DeployFailed: 'deploy.failed',
  DeployCancelled: 'deploy.cancelled',
  DeploySkippedLocked: 'deploy.skipped_locked',
  LockOverridden: 'lock.overridden',
  DatabaseProvisionFailed: 'database.provision_failed',
  SnapshotFailed: 'database.snapshot_failed',
} as const;

export type NotificationEvent =
  (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

export const ALL_NOTIFICATION_EVENTS = Object.values(
  NOTIFICATION_EVENTS,
) as NotificationEvent[];

/**
 * Kinds the inbox writes directly instead of draining from `event_outbox`.
 *
 * A findings mutation happens inside a Nest request with the recipient already
 * known, so there is no event to emit and nothing to retry. They are
 * deliberately kept out of ALL_NOTIFICATION_EVENTS: that list is the enum a
 * channel's `events` array validates against, and no dispatcher will ever see
 * these — offering them as a Slack subscription would be a checkbox that lies.
 */
export const INBOX_ONLY_EVENTS = {
  FindingCreated: 'finding.created',
  FindingResolved: 'finding.resolved',
} as const;

export type InboxOnlyEvent =
  (typeof INBOX_ONLY_EVENTS)[keyof typeof INBOX_ONLY_EVENTS];

/** Everything the in-app inbox can carry: outbox events plus the direct kinds. */
export type InboxKind = NotificationEvent | InboxOnlyEvent;

/** Raw outbox `type` → canonical event. Unmapped types are ignored. */
const CANONICAL_BY_RAW_TYPE: Record<string, NotificationEvent> = {
  'deploy.succeeded': NOTIFICATION_EVENTS.DeploySucceeded,
  'deploy.failed': NOTIFICATION_EVENTS.DeployFailed,
  'deploy.cancelled': NOTIFICATION_EVENTS.DeployCancelled,
  // Nest-emitted equivalents (reaper, cancel-before-pickup).
  'deployment.failed': NOTIFICATION_EVENTS.DeployFailed,
  'deployment.cancelled': NOTIFICATION_EVENTS.DeployCancelled,
  'deployment.skipped_locked': NOTIFICATION_EVENTS.DeploySkippedLocked,
  // Nest-only from birth, so its raw type is already the canonical name.
  'lock.overridden': NOTIFICATION_EVENTS.LockOverridden,
  'database.provision_failed': NOTIFICATION_EVENTS.DatabaseProvisionFailed,
  'database.snapshot_failed': NOTIFICATION_EVENTS.SnapshotFailed,
};

export function canonicalEvent(rawType: string): NotificationEvent | null {
  return CANONICAL_BY_RAW_TYPE[rawType] ?? null;
}

// Retry schedule for a failed send. Index = attempt number already made.
export const RETRY_BACKOFF_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
] as const;

export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;
