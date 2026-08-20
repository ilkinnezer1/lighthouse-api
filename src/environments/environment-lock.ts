import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { USER_REF_SELECT, type UserRef } from '../common/user-ref';

export const DEFAULT_LOCK_HOURS = 4;
export const MIN_LOCK_HOURS = 0.25;
export const MAX_LOCK_HOURS = 72;

export const ENVIRONMENT_LOCKED_CODE = 'ENVIRONMENT_LOCKED';

export type LockHolder = UserRef;

export interface EnvironmentLock {
  lockedBy: LockHolder;
  lockedAt: string;
  expiresAt: string;
  reason: string | null;
}

export interface LockColumns {
  lockedByUserId: string | null;
  lockedAt: Date | null;
  lockExpiresAt: Date | null;
  lockReason: string | null;
  lockedBy: LockHolder | null;
}

export const LOCK_SELECT = {
  lockedByUserId: true,
  lockedAt: true,
  lockExpiresAt: true,
  lockReason: true,
  lockedBy: { select: USER_REF_SELECT },
} satisfies Prisma.EnvironmentSelect;

/**
 * The single source of truth for "is this environment locked right now".
 *
 * Expiry is lazy — nothing sweeps the lock columns — so a row whose
 * `lockExpiresAt` has passed is not a lock, and serializes as `null`. Every
 * read path and the deploy gate go through here, so a client can never be
 * handed a dead lock and no deploy can race a reaper.
 */
export function lockState(
  env: LockColumns,
  now: Date = new Date(),
): EnvironmentLock | null {
  if (!env.lockedByUserId || !env.lockedBy || !env.lockedAt) return null;
  if (!env.lockExpiresAt || env.lockExpiresAt.getTime() <= now.getTime()) {
    return null;
  }
  return {
    lockedBy: env.lockedBy,
    lockedAt: env.lockedAt.toISOString(),
    expiresAt: env.lockExpiresAt.toISOString(),
    reason: env.lockReason,
  };
}

/** A live lock held by somebody other than `userId` — the deploy gate. */
export function lockHeldAgainst(
  env: LockColumns,
  userId: string,
  now: Date = new Date(),
): EnvironmentLock | null {
  const live = lockState(env, now);
  return live && live.lockedBy.id !== userId ? live : null;
}

export function environmentLockedConflict(
  lock: EnvironmentLock,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: 'Environment is locked',
    code: ENVIRONMENT_LOCKED_CODE,
    lock,
  });
}

/**
 * Strips the raw lock columns off a row and replaces them with the serialized
 * `lock`. The only place lock state is shaped for the wire — the board feed,
 * the project detail payload and the 409 body all go through here, so the
 * three cannot drift apart.
 */
export function withLock<T extends LockColumns>(
  row: T,
  now: Date = new Date(),
): Omit<T, keyof LockColumns> & { lock: EnvironmentLock | null } {
  const {
    lockedByUserId,
    lockedAt,
    lockExpiresAt,
    lockReason,
    lockedBy,
    ...rest
  } = row;
  return {
    ...rest,
    lock: lockState(
      { lockedByUserId, lockedAt, lockExpiresAt, lockReason, lockedBy },
      now,
    ),
  };
}
