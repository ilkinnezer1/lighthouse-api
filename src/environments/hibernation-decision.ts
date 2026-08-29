/**
 * The whole idle policy, decided without a database in the way.
 *
 * Two halves, both pure: what a poll writes back to the activity columns, and
 * whether the environment may be put to sleep. Erring toward "awake" costs
 * memory; erring toward "asleep" takes someone's environment down under them,
 * so every ambiguous reading resolves awake.
 */

/** Columns to write. Absent keys are deliberately left as they are. */
export interface ActivityPatch {
  lastRequestCount?: number;
  lastActivityAt?: Date;
}

export type ActivityReason =
  /** No `lastActivityAt` yet — start the idle clock, don't measure against it. */
  | 'clock-start'
  /** Traefik has no series for this environment; not a reading, and not zero. */
  | 'no-observation'
  /** First count since the clock started: a baseline, not evidence of when. */
  | 'first-observation'
  | 'traffic'
  /** Observed below stored — Traefik or the container restarted. */
  | 'counter-reset'
  | 'silence';

export interface ActivityInput {
  lastRequestCount: number | null;
  /** `null` = the series was absent, which is NOT a count of zero. */
  observedRequestCount: number | null;
  lastActivityAt: Date | null;
  now: Date;
}

export interface ActivityOutcome {
  reason: ActivityReason;
  /** `null` when there is nothing to write. */
  patch: ActivityPatch | null;
  /** `lastActivityAt` as it stands after this poll; `null` only if unknowable. */
  activeAt: Date | null;
}

export function resolveActivity(input: ActivityInput): ActivityOutcome {
  const { lastRequestCount, observedRequestCount, lastActivityAt, now } = input;

  // Nothing to measure idleness against. Stamping now starts the clock, and it
  // can only happen once, so it cannot be what keeps an environment awake.
  if (!lastActivityAt) {
    return {
      reason: 'clock-start',
      patch: {
        lastActivityAt: now,
        ...(observedRequestCount === null
          ? {}
          : { lastRequestCount: observedRequestCount }),
      },
      activeAt: now,
    };
  }

  // A container that is stopped, or was never visited since Traefik started,
  // has no series at all. Silence and absence both leave the clock running —
  // treating absence as 0 would read as a reset and refresh it on every poll.
  if (observedRequestCount === null) {
    return { reason: 'no-observation', patch: null, activeAt: lastActivityAt };
  }

  if (lastRequestCount === null) {
    return {
      reason: 'first-observation',
      // Count only: those requests happened at an unknown time, quite possibly
      // before anyone asked for hibernation. Stamping would invent activity.
      patch: { lastRequestCount: observedRequestCount },
      activeAt: lastActivityAt,
    };
  }

  // Never a delta across a reset. A counter that came back lower did so by
  // restarting, and Traefik's restarted counter reads 1 because a request
  // arrived — so this is activity, not silence.
  if (observedRequestCount < lastRequestCount) {
    return {
      reason: 'counter-reset',
      patch: { lastRequestCount: observedRequestCount, lastActivityAt: now },
      activeAt: now,
    };
  }

  if (observedRequestCount > lastRequestCount) {
    return {
      reason: 'traffic',
      patch: { lastRequestCount: observedRequestCount, lastActivityAt: now },
      activeAt: now,
    };
  }

  return { reason: 'silence', patch: null, activeAt: lastActivityAt };
}

/** Facts that outrank the traffic measurement, in the order they are reported. */
export interface HibernationVetoes {
  enabled: boolean;
  /** A live lock (evaluated the lazy way environment-lock.ts already does). */
  locked: boolean;
  /** Any deployment of this environment in a non-terminal status. */
  deploymentInFlight: boolean;
  /** A current SUCCEEDED deployment with running containers to stop. */
  hasRunningDeployment: boolean;
}

export type HibernationVeto =
  | 'disabled'
  | 'locked'
  | 'deploy-in-flight'
  | 'nothing-running'
  | 'not-idle';

export interface IdleInput extends ActivityInput {
  idleTimeoutMinutes: number;
  vetoes: HibernationVetoes;
}

export interface IdleDecision {
  reason: ActivityReason;
  patch: ActivityPatch | null;
  hibernate: boolean;
  /** Why it stays awake, for the log line. `null` exactly when hibernating. */
  veto: HibernationVeto | null;
}

const MINUTE_MS = 60_000;

/**
 * One environment, one poll: what to write and whether to stop its containers.
 *
 * The activity patch is returned whatever the vetoes say — a locked or
 * mid-deploy environment still had its traffic measured, and throwing that
 * away would restart its idle clock the moment the veto lifts.
 */
export function decideHibernation(input: IdleInput): IdleDecision {
  const { reason, patch, activeAt } = resolveActivity(input);
  const { vetoes } = input;

  const veto = firstVeto(vetoes, activeAt, input.idleTimeoutMinutes, input.now);
  return { reason, patch, hibernate: veto === null, veto };
}

function firstVeto(
  vetoes: HibernationVetoes,
  activeAt: Date | null,
  idleTimeoutMinutes: number,
  now: Date,
): HibernationVeto | null {
  if (!vetoes.enabled) return 'disabled';
  if (vetoes.locked) return 'locked';
  if (vetoes.deploymentInFlight) return 'deploy-in-flight';
  if (!vetoes.hasRunningDeployment) return 'nothing-running';
  if (!activeAt) return 'not-idle';
  const idleFor = now.getTime() - activeAt.getTime();
  return idleFor > idleTimeoutMinutes * MINUTE_MS ? null : 'not-idle';
}
