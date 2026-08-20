import { ConflictException } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { AuthzService } from '../authz/authz.service';
import type { PrismaService } from '../prisma/prisma.service';
import { EnvironmentLocksService } from './environment-locks.service';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const ENV_ID = '11111111-1111-4111-8111-111111111111';

const AYSEL = {
  id: 'aysel-id',
  username: 'aysel',
  displayName: 'Aysel',
  email: 'aysel@example.com',
};
const RUSLAN = {
  id: 'ruslan-id',
  username: 'ruslan',
  displayName: null,
  email: 'ruslan@example.com',
};

const asUser = (u: typeof AYSEL) => u as unknown as User;

const project = { project: { organizationId: 'org-1' } };
const unlocked = {
  lockedByUserId: null,
  lockedBy: null,
  lockedAt: null,
  lockExpiresAt: null,
  lockReason: null,
};
const AYSEL_LOCK = {
  lockedBy: AYSEL,
  lockedAt: '2026-08-20T11:00:00.000Z',
  expiresAt: '2026-08-20T15:00:00.000Z',
  reason: 'regression pass',
};
const heldByAysel = {
  lockedByUserId: AYSEL.id,
  lockedBy: AYSEL,
  lockedAt: new Date('2026-08-20T11:00:00.000Z'),
  lockExpiresAt: new Date('2026-08-20T15:00:00.000Z'),
  lockReason: 'regression pass',
};

interface UpdateManyArgs {
  where: { id: string; OR?: unknown[]; lockedByUserId?: string };
  data: {
    lockedByUserId: string | null;
    lockedAt: Date | null;
    lockExpiresAt: Date | null;
    lockReason: string | null;
  };
}

describe('EnvironmentLocksService', () => {
  let prisma: {
    environment: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let authz: { ensureCan: jest.Mock };
  let service: EnvironmentLocksService;
  let writes: UpdateManyArgs[];
  let writeResult: { count: number };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    writes = [];
    writeResult = { count: 1 };
    prisma = {
      environment: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn((args: UpdateManyArgs) => {
          writes.push(args);
          return Promise.resolve(writeResult);
        }),
      },
    };
    authz = { ensureCan: jest.fn().mockResolvedValue(undefined) };
    service = new EnvironmentLocksService(
      prisma as unknown as PrismaService,
      authz as unknown as AuthzService,
    );
  });

  afterEach(() => jest.useRealTimers());

  describe('acquire', () => {
    it('claims with a conditional write that only matches a free, expired or own lock', async () => {
      prisma.environment.findFirst.mockResolvedValue({
        ...project,
        ...unlocked,
      });

      const lock = await service.acquire(ENV_ID, asUser(AYSEL), {
        reason: 'regression pass',
      });

      const { where, data } = writes[0];
      expect(where.id).toBe(ENV_ID);
      expect(where.OR).toEqual([
        { lockedByUserId: null },
        { lockExpiresAt: null },
        { lockExpiresAt: { lte: NOW } },
        { lockedByUserId: AYSEL.id },
      ]);
      expect(data.lockedByUserId).toBe(AYSEL.id);
      expect(lock).toEqual({
        lockedBy: AYSEL,
        lockedAt: NOW.toISOString(),
        expiresAt: '2026-08-20T16:00:00.000Z',
        reason: 'regression pass',
      });
    });

    it('409s without writing when somebody else already holds it', async () => {
      prisma.environment.findFirst.mockResolvedValue({
        ...project,
        ...heldByAysel,
      });

      await expect(
        service.acquire(ENV_ID, asUser(RUSLAN), {}),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.environment.updateMany).not.toHaveBeenCalled();
    });

    // The race the conditional write exists to close: both readers saw it free.
    it('409s with the real holder when the conditional write loses the race', async () => {
      prisma.environment.findFirst.mockResolvedValue({
        ...project,
        ...unlocked,
      });
      writeResult = { count: 0 };
      prisma.environment.findUnique.mockResolvedValue(heldByAysel);

      await expect(
        service.acquire(ENV_ID, asUser(RUSLAN), {}),
      ).rejects.toMatchObject({
        response: {
          statusCode: 409,
          message: 'Environment is locked',
          code: 'ENVIRONMENT_LOCKED',
          lock: AYSEL_LOCK,
        },
      });
    });

    it('extends its own live lock, keeping lockedAt and the existing reason', async () => {
      prisma.environment.findFirst.mockResolvedValue({
        ...project,
        ...heldByAysel,
      });

      const lock = await service.acquire(ENV_ID, asUser(AYSEL), { hours: 1 });

      expect(lock.lockedAt).toBe('2026-08-20T11:00:00.000Z');
      expect(lock.expiresAt).toBe('2026-08-20T13:00:00.000Z');
      expect(lock.reason).toBe('regression pass');
    });

    it('treats an expired lock as free and starts a fresh claim', async () => {
      prisma.environment.findFirst.mockResolvedValue({
        ...project,
        ...heldByAysel,
        lockExpiresAt: new Date('2026-08-20T09:00:00.000Z'),
      });

      const lock = await service.acquire(ENV_ID, asUser(RUSLAN), {});

      expect(lock.lockedBy).toEqual(RUSLAN);
      expect(lock.lockedAt).toBe(NOW.toISOString());
      expect(lock.reason).toBeNull();
    });
  });

  describe('release', () => {
    it('scopes the clear to the holder it observed', async () => {
      prisma.environment.findFirst.mockResolvedValue({
        ...project,
        ...heldByAysel,
      });

      const result = await service.release(ENV_ID, asUser(AYSEL));

      expect(writes[0].where).toEqual({
        id: ENV_ID,
        lockedByUserId: AYSEL.id,
      });
      expect(result.forced).toBe(false);
      expect(result.released?.lockedBy).toEqual(AYSEL);
    });

    it('reports a release of somebody else’s lock as forced', async () => {
      prisma.environment.findFirst.mockResolvedValue({
        ...project,
        ...heldByAysel,
      });

      const result = await service.release(ENV_ID, asUser(RUSLAN));

      expect(result).toEqual({ released: AYSEL_LOCK, forced: true });
    });

    it('is a no-op when the lock already expired', async () => {
      prisma.environment.findFirst.mockResolvedValue({
        ...project,
        ...heldByAysel,
        lockExpiresAt: new Date('2026-08-20T09:00:00.000Z'),
      });

      expect(await service.release(ENV_ID, asUser(AYSEL))).toEqual({
        released: null,
        forced: false,
      });
      expect(prisma.environment.updateMany).not.toHaveBeenCalled();
    });

    it('does not clobber a lock somebody else took in the meantime', async () => {
      prisma.environment.findFirst.mockResolvedValue({
        ...project,
        ...heldByAysel,
      });
      writeResult = { count: 0 };

      expect(await service.release(ENV_ID, asUser(RUSLAN))).toEqual({
        released: null,
        forced: false,
      });
    });
  });

  describe('deploy gate', () => {
    it('throws the 409 for a lock held by someone else', async () => {
      prisma.environment.findUnique.mockResolvedValue(heldByAysel);

      await expect(
        service.assertDeployable(ENV_ID, RUSLAN.id, false),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('returns the overridden lock when the caller asked to override', async () => {
      prisma.environment.findUnique.mockResolvedValue(heldByAysel);

      const overridden = await service.assertDeployable(
        ENV_ID,
        RUSLAN.id,
        true,
      );
      expect(overridden?.lockedBy).toEqual(AYSEL);
    });

    it('never blocks the holder on their own environment', async () => {
      prisma.environment.findUnique.mockResolvedValue(heldByAysel);

      expect(
        await service.assertDeployable(ENV_ID, AYSEL.id, false),
      ).toBeNull();
    });

    // A webhook is nobody, so it gets no holder exemption.
    it('reports a live lock to automation regardless of who holds it', async () => {
      prisma.environment.findUnique.mockResolvedValue(heldByAysel);

      expect((await service.liveLock(ENV_ID))?.lockedBy).toEqual(AYSEL);
    });
  });
});
