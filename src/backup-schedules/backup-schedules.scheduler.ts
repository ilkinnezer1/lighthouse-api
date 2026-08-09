import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduledTasksService } from '../scheduled-tasks/scheduled-tasks.service';
import { BackupSchedulesService } from './backup-schedules.service';

const MAX_PER_TICK = 25;

@Injectable()
export class BackupSchedulesScheduler {
  private readonly logger = new Logger(BackupSchedulesScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: BackupSchedulesService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    const now = new Date();

    const due = await this.prisma.backupSchedule.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now },
        // Preview environments are throwaway; backing them up on a cron would
        // accumulate archives for databases that vanish with the PR.
        environment: { type: { not: 'PREVIEW' }, active: true },
      },
      orderBy: { nextRunAt: 'asc' },
      take: MAX_PER_TICK,
    });

    if (due.length === 0) return;

    for (const schedule of due) {
      // Advance the cursor BEFORE running, and only if it still holds the value
      // this tick read: another API instance racing the same slot loses the
      // update and skips, so a backup is queued once rather than twice.
      const nextRunAt = ScheduledTasksService.nextRun(
        schedule.schedule,
        schedule.timezone,
        now,
      );
      const claimed = await this.prisma.backupSchedule.updateMany({
        where: { id: schedule.id, nextRunAt: schedule.nextRunAt },
        data: { nextRunAt },
      });
      if (claimed.count === 0) continue;

      void this.schedules.run(schedule).catch((err: Error) => {
        this.logger.error(
          `backup schedule ${schedule.id} threw: ${err.message}`,
        );
      });
    }
  }

  /**
   * Retention, swept independently of the backups themselves so a backup that
   * has only just become READY is pruned on the next tick rather than an hour
   * later, and so lowering keepLast takes effect straight away.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async pruneRetention(): Promise<void> {
    const schedules = await this.prisma.backupSchedule.findMany({
      where: { keepLast: { gt: 0 } },
    });
    for (const schedule of schedules) {
      try {
        await this.schedules.prune(schedule);
      } catch (err) {
        this.logger.error(
          `pruning schedule ${schedule.id} failed: ${(err as Error).message}`,
        );
      }
    }
  }
}
