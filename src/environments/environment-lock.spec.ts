import { ConflictException } from '@nestjs/common';
import {
  environmentLockedConflict,
  lockHeldAgainst,
  lockState,
  withLock,
  type LockColumns,
} from './environment-lock';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const HOLDER = {
  id: 'holder-uuid',
  username: 'aysel',
  displayName: 'Aysel',
  email: 'aysel@example.com',
};

function held(overrides: Partial<LockColumns> = {}): LockColumns {
  return {
    lockedByUserId: HOLDER.id,
    lockedBy: HOLDER,
    lockedAt: new Date('2026-08-20T11:00:00.000Z'),
    lockExpiresAt: new Date('2026-08-20T15:00:00.000Z'),
    lockReason: 'regression pass',
    ...overrides,
  };
}

const unlocked: LockColumns = {
  lockedByUserId: null,
  lockedBy: null,
  lockedAt: null,
  lockExpiresAt: null,
  lockReason: null,
};

describe('lockState', () => {
  it('is null when no lock was ever taken', () => {
    expect(lockState(unlocked, NOW)).toBeNull();
  });

  it('serializes a live lock with ISO timestamps', () => {
    expect(lockState(held(), NOW)).toEqual({
      lockedBy: HOLDER,
      lockedAt: '2026-08-20T11:00:00.000Z',
      expiresAt: '2026-08-20T15:00:00.000Z',
      reason: 'regression pass',
    });
  });

  it('is null once the lock has expired', () => {
    const expired = held({
      lockExpiresAt: new Date('2026-08-20T11:59:59.999Z'),
    });
    expect(lockState(expired, NOW)).toBeNull();
  });

  it('is null exactly at the expiry instant', () => {
    expect(lockState(held({ lockExpiresAt: NOW }), NOW)).toBeNull();
  });

  it('is still live one millisecond before expiry', () => {
    const lock = held({ lockExpiresAt: new Date(NOW.getTime() + 1) });
    expect(lockState(lock, NOW)).not.toBeNull();
  });

  it('is null when the holder row is missing', () => {
    expect(lockState(held({ lockedBy: null }), NOW)).toBeNull();
  });

  it('is null when no expiry was recorded — a lock nobody can clear is not one', () => {
    expect(lockState(held({ lockExpiresAt: null }), NOW)).toBeNull();
  });

  it('keeps a null reason null', () => {
    expect(lockState(held({ lockReason: null }), NOW)?.reason).toBeNull();
  });
});

describe('lockHeldAgainst', () => {
  it('blocks a live lock held by somebody else', () => {
    expect(lockHeldAgainst(held(), 'other-user', NOW)).not.toBeNull();
  });

  it('never blocks the holder against their own lock', () => {
    expect(lockHeldAgainst(held(), HOLDER.id, NOW)).toBeNull();
  });

  it('does not block on an expired lock', () => {
    const expired = held({ lockExpiresAt: new Date('2026-08-20T09:00:00Z') });
    expect(lockHeldAgainst(expired, 'other-user', NOW)).toBeNull();
  });

  it('does not block when there is no lock', () => {
    expect(lockHeldAgainst(unlocked, 'other-user', NOW)).toBeNull();
  });
});

describe('withLock', () => {
  it('replaces the raw columns with the serialized lock', () => {
    const row = { id: 'env-1', name: 'production', ...held() };
    const shaped = withLock(row, NOW);

    expect(shaped).toEqual({
      id: 'env-1',
      name: 'production',
      lock: lockState(held(), NOW),
    });
    expect(shaped).not.toHaveProperty('lockedByUserId');
    expect(shaped).not.toHaveProperty('lockExpiresAt');
  });

  it('emits lock: null for an expired lock rather than leaking a dead one', () => {
    const row = {
      id: 'env-1',
      ...held({ lockExpiresAt: new Date('2026-08-20T09:00:00Z') }),
    };
    expect(withLock(row, NOW)).toEqual({ id: 'env-1', lock: null });
  });
});

describe('environmentLockedConflict', () => {
  it('carries the agreed 409 body', () => {
    const lock = lockState(held(), NOW)!;
    const err = environmentLockedConflict(lock);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual({
      statusCode: 409,
      message: 'Environment is locked',
      code: 'ENVIRONMENT_LOCKED',
      lock,
    });
  });
});
