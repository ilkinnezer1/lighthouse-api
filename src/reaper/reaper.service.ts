import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OUTBOX_EVENT_TYPES } from '../outbox/outbox.constants';
import { PrismaService } from '../prisma/prisma.service';
import {
  HEARTBEAT_THRESHOLD_MS,
  IN_FLIGHT_STATUSES,
  IMPORT_UPLOAD_THRESHOLD_MS,
  PROVISION_THRESHOLD_MS,
} from './reaper.constants';

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

  /**
   * Managed databases provision asynchronously but carry no heartbeat, so a row
   * still PROVISIONING long after creation means the worker never picked it up
   * or died mid-provision. Fail it (and emit the same event the worker would)
   * so the owner isn't left hanging on a row that will never go READY.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reapStuckDatabases(): Promise<void> {
    const cutoff = new Date(Date.now() - PROVISION_THRESHOLD_MS);
    const stale = await this.prisma.managedDatabase.findMany({
      where: { status: 'PROVISIONING', createdAt: { lt: cutoff } },
      select: { id: true },
    });
    if (stale.length === 0) return;

    for (const d of stale) {
      try {
        await this.prisma.$transaction(async (tx) => {
          // Guard on status so we don't clobber a worker write-back that
          // landed between the SELECT and here.
          const won = await tx.managedDatabase.updateMany({
            where: { id: d.id, status: 'PROVISIONING' },
            data: {
              status: 'FAILED',
              errorSummary: 'provisioning timed out — worker presumed dead',
            },
          });
          if (won.count === 0) return;
          await tx.eventOutbox.create({
            data: {
              type: OUTBOX_EVENT_TYPES.DatabaseProvisionFailed,
              userId: null,
              payload: { databaseId: d.id, reason: 'reaper' },
            },
          });
        });
        this.logger.warn(`reaped database ${d.id} as FAILED`);
      } catch (err) {
        this.logger.error(`failed to reap database ${d.id}`, err);
      }
    }
  }

  /** Same idea for snapshots stuck PENDING — pg_dump never reported back. */
  @Cron(CronExpression.EVERY_MINUTE)
  async reapStuckSnapshots(): Promise<void> {
    const cutoff = new Date(Date.now() - PROVISION_THRESHOLD_MS);
    const importCutoff = new Date(Date.now() - IMPORT_UPLOAD_THRESHOLD_MS);
    const stale = await this.prisma.databaseSnapshot.findMany({
      where: {
        status: 'PENDING',
        OR: [
          { origin: 'DUMP', createdAt: { lt: cutoff } },
          { origin: 'IMPORT', createdAt: { lt: importCutoff } },
        ],
      },
      select: { id: true, origin: true },
    });
    if (stale.length === 0) return;

    for (const s of stale) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const won = await tx.databaseSnapshot.updateMany({
            where: { id: s.id, status: 'PENDING' },
            data:
              s.origin === 'IMPORT'
                ? {
                    status: 'FAILED',
                    importStatus: 'FAILED',
                    errorSummary: 'upload timed out — never completed',
                  }
                : {
                    status: 'FAILED',
                    errorSummary: 'snapshot timed out — worker presumed dead',
                  },
          });
          if (won.count === 0) return;
          await tx.eventOutbox.create({
            data: {
              type: OUTBOX_EVENT_TYPES.SnapshotFailed,
              userId: null,
              payload: { snapshotId: s.id, reason: 'reaper' },
            },
          });
        });
        this.logger.warn(`reaped snapshot ${s.id} as FAILED`);
      } catch (err) {
        this.logger.error(`failed to reap snapshot ${s.id}`, err);
      }
    }
  }

  /**
   * And for volume backups, which had no sweep at all: a worker that died
   * mid-tar left the row PENDING forever, and the UI polls a PENDING backup
   * indefinitely waiting for an outcome that can no longer arrive.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reapStuckVolumeBackups(): Promise<void> {
    const cutoff = new Date(Date.now() - PROVISION_THRESHOLD_MS);
    const stale = await this.prisma.volumeBackup.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: { id: true },
    });
    if (stale.length === 0) return;

    for (const b of stale) {
      try {
        const won = await this.prisma.volumeBackup.updateMany({
          where: { id: b.id, status: 'PENDING' },
          data: {
            status: 'FAILED',
            errorSummary: 'backup timed out — worker presumed dead',
          },
        });
        if (won.count > 0) {
          this.logger.warn(`reaped volume backup ${b.id} as FAILED`);
        }
      } catch (err) {
        this.logger.error(`failed to reap volume backup ${b.id}`, err);
      }
    }
  }
}
