import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduledTasksRunner } from './scheduled-tasks.runner';
import { ScheduledTasksService } from './scheduled-tasks.service';

// A tick that finds nothing due is the common case, so the sweep is an indexed
// lookup on (enabled, nextRunAt) rather than parsing every cron expression.
const MAX_PER_TICK = 25;

@Injectable()
export class ScheduledTasksScheduler {
  private readonly logger = new Logger(ScheduledTasksScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: ScheduledTasksRunner,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    const now = new Date();

    const due = await this.prisma.scheduledTask.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now },
        // Preview environments are throwaway and short-lived — letting them
        // inherit schedules would mean every open PR spawns its own nightly
        // job against a disposable database.
        environment: { type: { not: 'PREVIEW' }, active: true },
      },
      orderBy: { nextRunAt: 'asc' },
      take: MAX_PER_TICK,
    });

    if (due.length === 0) return;

    for (const task of due) {
      // Advance the cursor BEFORE running. A long job must not be re-picked by
      // the next tick, and a crash mid-run should skip the slot rather than
      // replay it — catching up on missed slots would stampede after downtime.
      const nextRunAt = ScheduledTasksService.nextRun(
        task.schedule,
        task.timezone,
        now,
      );
      const claimed = await this.prisma.scheduledTask.updateMany({
        where: { id: task.id, nextRunAt: task.nextRunAt },
        data: { nextRunAt },
      });
      // Lost the race to another API instance — that instance owns this slot.
      if (claimed.count === 0) continue;

      void this.runner.run(task, 'SCHEDULE').catch((err: Error) => {
        this.logger.error(`task ${task.id} threw: ${err.message}`);
      });
    }
  }
}
