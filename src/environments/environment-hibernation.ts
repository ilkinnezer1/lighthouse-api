import type { Prisma } from '@prisma/client';

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 240;
export const MIN_IDLE_TIMEOUT_MINUTES = 1;
export const MAX_IDLE_TIMEOUT_MINUTES = 10_080; // a week

/**
 * Hibernation as the browser sees it.
 *
 * Always present, unlike `lock`: the toggle and the timeout have to render
 * whether or not the environment is asleep. `sleeping` is the state — the
 * environment's URL 404s from Traefik while it holds, because the route is
 * gone with the containers rather than broken.
 */
export interface EnvironmentHibernation {
  enabled: boolean;
  idleTimeoutMinutes: number;
  sleeping: boolean;
  hibernatedAt: string | null;
  lastActivityAt: string | null;
}

export interface HibernationColumns {
  hibernationEnabled: boolean;
  idleTimeoutMinutes: number;
  lastActivityAt: Date | null;
  hibernatedAt: Date | null;
}

export const HIBERNATION_SELECT = {
  hibernationEnabled: true,
  idleTimeoutMinutes: true,
  lastActivityAt: true,
  hibernatedAt: true,
} satisfies Prisma.EnvironmentSelect;

/** The single source of truth for "is this environment asleep right now". */
export function hibernationState(
  env: HibernationColumns,
): EnvironmentHibernation {
  return {
    enabled: env.hibernationEnabled,
    idleTimeoutMinutes: env.idleTimeoutMinutes,
    sleeping: env.hibernatedAt !== null,
    hibernatedAt: env.hibernatedAt?.toISOString() ?? null,
    lastActivityAt: env.lastActivityAt?.toISOString() ?? null,
  };
}

/**
 * Strips the raw hibernation columns off a row and replaces them with the
 * serialized `hibernation`, exactly as `withLock` does — the board feed and the
 * project payload both go through here, so the environment page (which has no
 * `GET /environments/:id` to fall back on) cannot end up rendering a sleeping
 * environment as permanently awake.
 *
 * Stripping is not cosmetic: `lastRequestCount` is a BigInt column, which
 * Express's JSON serializer throws on. It is a measurement detail with no
 * reader on the wire, so it is dropped here rather than stringified.
 */
export function withHibernation<
  T extends HibernationColumns & { lastRequestCount?: bigint | null },
>(
  row: T,
): Omit<T, keyof HibernationColumns | 'lastRequestCount'> & {
  hibernation: EnvironmentHibernation;
} {
  const {
    hibernationEnabled,
    idleTimeoutMinutes,
    lastActivityAt,
    hibernatedAt,
    lastRequestCount: _lastRequestCount,
    ...rest
  } = row;
  return {
    ...rest,
    hibernation: hibernationState({
      hibernationEnabled,
      idleTimeoutMinutes,
      lastActivityAt,
      hibernatedAt,
    }),
  };
}
