import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { AuthzService } from '../authz/authz.service';
import { OUTBOX_EVENT_TYPES } from '../outbox/outbox.constants';
import { PrismaService } from '../prisma/prisma.service';
import type { LockEnvironmentDto } from './dto/lock-environment.dto';
import {
  DEFAULT_LOCK_HOURS,
  LOCK_SELECT,
  environmentLockedConflict,
  lockHeldAgainst,
  lockState,
  type EnvironmentLock,
  type LockColumns,
} from './environment-lock';

const HOUR_MS = 60 * 60 * 1000;

// A lost race normally means somebody holds it (409). Retries cover only the
// narrow case where the winner released again before we could read them back.
const MAX_CLAIM_ATTEMPTS = 2;

export interface ReleaseResult {
  released: EnvironmentLock | null;
  forced: boolean;
}

@Injectable()
export class EnvironmentLocksService {
  private readonly logger = new Logger(EnvironmentLocksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
  ) {}

  async acquire(
    environmentId: string,
    user: User,
    dto: LockEnvironmentDto,
  ): Promise<EnvironmentLock> {
    let env: LockColumns = await this.authorize(environmentId, user);

    for (let attempt = 0; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
      const now = new Date();
      const current = lockState(env, now);
      if (current && current.lockedBy.id !== user.id) {
        throw environmentLockedConflict(current);
      }

      const lockedAt = current ? new Date(current.lockedAt) : now;
      const reason = dto.reason ?? current?.reason ?? null;
      const expiresAt = new Date(
        now.getTime() + (dto.hours ?? DEFAULT_LOCK_HOURS) * HOUR_MS,
      );

      // Conditional write, not read-then-write: two testers clicking Lock in
      // the same moment must not both come away believing they hold it.
      const claimed = await this.prisma.environment.updateMany({
        where: {
          id: environmentId,
          OR: [
            { lockedByUserId: null },
            { lockExpiresAt: null },
            { lockExpiresAt: { lte: now } },
            { lockedByUserId: user.id },
          ],
        },
        data: {
          lockedByUserId: user.id,
          lockedAt,
          lockExpiresAt: expiresAt,
          lockReason: reason,
        },
      });

      if (claimed.count > 0) {
        return {
          lockedBy: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            email: user.email,
          },
          lockedAt: lockedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          reason,
        };
      }

      const fresh = await this.readLockColumns(environmentId);
      if (!fresh) throw new NotFoundException('Environment not found');
      env = fresh;
    }

    throw new ConflictException(
      'Could not acquire the environment lock, please retry',
    );
  }

  async release(environmentId: string, user: User): Promise<ReleaseResult> {
    const env = await this.authorize(environmentId, user);

    const current = lockState(env);
    if (!current) return { released: null, forced: false };

    const cleared = await this.prisma.environment.updateMany({
      where: { id: environmentId, lockedByUserId: current.lockedBy.id },
      data: {
        lockedByUserId: null,
        lockedAt: null,
        lockExpiresAt: null,
        lockReason: null,
      },
    });
    if (cleared.count === 0) return { released: null, forced: false };

    return { released: current, forced: current.lockedBy.id !== user.id };
  }

  /**
   * Gate for a human-triggered deploy. Returns the lock that was overridden so
   * the caller can record it, null when the environment was free to deploy to.
   */
  async assertDeployable(
    environmentId: string,
    userId: string,
    overrideLock: boolean,
  ): Promise<EnvironmentLock | null> {
    const held = await this.lockHeldAgainst(environmentId, userId);
    if (!held) return null;
    if (!overrideLock) throw environmentLockedConflict(held);
    return held;
  }

  /**
   * Tells the holder their lock was walked through. Until now the override was
   * only an `auditContext` flag, and an audit row is not something the person
   * who locked the environment will ever go and read.
   *
   * Deliberately after the deployment exists, so the notification can link to
   * what was actually shipped rather than just to the environment.
   */
  async announceOverride(
    environmentId: string,
    overridden: EnvironmentLock | null,
    actorUserId: string,
    deploymentId: string,
  ): Promise<void> {
    if (!overridden) return;
    try {
      await this.prisma.eventOutbox.create({
        data: {
          type: OUTBOX_EVENT_TYPES.LockOverridden,
          userId: overridden.lockedBy.id,
          payload: {
            environmentId,
            deploymentId,
            lockedByUserId: overridden.lockedBy.id,
            overriddenByUserId: actorUserId,
            expiresAt: overridden.expiresAt,
            reason: overridden.reason,
          },
        },
      });
    } catch (err) {
      // Never fail a deploy that already happened over a notification.
      this.logger.error(
        `lock-override event for environment ${environmentId} failed`,
        err,
      );
    }
  }

  async lockHeldAgainst(
    environmentId: string,
    userId: string,
  ): Promise<EnvironmentLock | null> {
    const env = await this.readLockColumns(environmentId);
    return env ? lockHeldAgainst(env, userId) : null;
  }

  /**
   * Any live lock, ignoring who holds it. Automated deploys use this rather
   * than `lockHeldAgainst`: a webhook is nobody, so it gets no holder
   * exemption — the point of locking a shared environment is that a push
   * stops redeploying it.
   */
  async liveLock(environmentId: string): Promise<EnvironmentLock | null> {
    const env = await this.readLockColumns(environmentId);
    return env ? lockState(env) : null;
  }

  private readLockColumns(environmentId: string) {
    return this.prisma.environment.findUnique({
      where: { id: environmentId },
      select: LOCK_SELECT,
    });
  }

  private async authorize(environmentId: string, user: User) {
    const env = await this.prisma.environment.findFirst({
      where: { id: environmentId, project: { deletedAt: null } },
      select: {
        project: { select: { organizationId: true } },
        ...LOCK_SELECT,
      },
    });
    if (!env) throw new NotFoundException('Environment not found');
    await this.authz.ensureCan(user, 'environments.update', env.project);
    return env;
  }
}
