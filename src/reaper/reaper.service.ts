import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OUTBOX_EVENT_TYPES } from '../outbox/outbox.constants';
import { PrismaService } from '../prisma/prisma.service';
import { HEARTBEAT_THRESHOLD_MS, IN_FLIGHT_STATUSES } from './reaper.constants';

@Injectable()
export class ReaperService {
  private readonly logger = new Logger(ReaperService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - HEARTBEAT_THRESHOLD_MS);

    // `lastHeartbeatAt: { lt: cutoff }` deliberately skips NULL rows —
    // those haven't been picked up by the worker yet. Queue-stuck detection
    // belongs to the worker's bootstrap, not here.
    const stale = await this.prisma.deployment.findMany({
      where: {
        status: { in: IN_FLIGHT_STATUSES },
        lastHeartbeatAt: { lt: cutoff },
      },
      select: { id: true, cancelRequestedAt: true },
    });

    if (stale.length === 0) return;

    for (const d of stale) {
      const isCancel = d.cancelRequestedAt != null;
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.deployment.update({
            where: { id: d.id },
            data: {
              status: isCancel ? 'CANCELLED' : 'FAILED',
              finishedAt: new Date(),
              errorSummary: isCancel
                ? 'cancelled (worker did not finish)'
                : 'stale heartbeat — worker presumed dead',
            },
          });
          await tx.eventOutbox.create({
            data: {
              type: isCancel
                ? OUTBOX_EVENT_TYPES.DeploymentCancelled
                : OUTBOX_EVENT_TYPES.DeploymentFailed,
              userId: null,
              payload: { deploymentId: d.id, reason: 'reaper' },
            },
          });
        });
        this.logger.warn(
          `reaped deployment ${d.id} as ${isCancel ? 'CANCELLED' : 'FAILED'}`,
        );
      } catch (err) {
        this.logger.error(`failed to reap deployment ${d.id}`, err);
      }
    }
  }
}
