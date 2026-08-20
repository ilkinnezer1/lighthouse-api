import { FindingStatus } from '@prisma/client';

/**
 * What a status change writes. Pure, so the one rule that makes findings worth
 * anything — *which build fixed it* — is decided in a place that can be read
 * and tested without a database in the way.
 */
export interface StatusPatch {
  status: FindingStatus;
  fixedByDeploymentId: string | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
}

export interface TransitionInput {
  current: FindingStatus;
  next: FindingStatus;
  actorUserId: string;
  /**
   * The environment's latest SUCCEEDED deployment at this moment — the build
   * FIXED pins to. The client never names it: a client-supplied id is a claim,
   * this is a fact the server can see.
   */
  latestSucceededDeploymentId: string | null;
  now: Date;
}

/**
 * `null` means there is nothing to write — the finding is already in that
 * state. Callers use that to stay silent rather than re-stamping the resolver
 * and re-notifying on every duplicate click.
 */
export function resolveTransition(input: TransitionInput): StatusPatch | null {
  const { current, next, actorUserId, now } = input;
  if (current === next) return null;

  // Reopening drops the whole resolution, fixing build included: a finding that
  // is open again was not fixed by that build, whatever was recorded before.
  if (next === FindingStatus.OPEN) {
    return {
      status: FindingStatus.OPEN,
      fixedByDeploymentId: null,
      resolvedByUserId: null,
      resolvedAt: null,
    };
  }

  return {
    status: next,
    // CANNOT_REPRODUCE is a resolution, not a fix — there is no build to point
    // at, and pointing at one would invent a commit range that fixed nothing.
    fixedByDeploymentId:
      next === FindingStatus.FIXED ? input.latestSucceededDeploymentId : null,
    resolvedByUserId: actorUserId,
    resolvedAt: now,
  };
}

/** Whether a patch closed the finding — the trigger for telling the reporter. */
export function isResolution(patch: StatusPatch): boolean {
  return patch.status !== FindingStatus.OPEN;
}
