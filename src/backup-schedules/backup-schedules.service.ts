import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { BackupSchedule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduledTasksService } from '../scheduled-tasks/scheduled-tasks.service';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { VolumeBackupsService } from '../volume-backups/volume-backups.service';
import { CreateBackupScheduleDto } from './dto/create-backup-schedule.dto';
import { UpdateBackupScheduleDto } from './dto/update-backup-schedule.dto';

@Injectable()
export class BackupSchedulesService {
  private readonly logger = new Logger(BackupSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshots: SnapshotsService,
    private readonly volumeBackups: VolumeBackupsService,
  ) {}

  async list(environmentId: string) {
    return this.prisma.backupSchedule.findMany({
      where: { environmentId },
      orderBy: { createdAt: 'asc' },
      include: { database: { select: { name: true, type: true } } },
    });
  }

  async create(
    environmentId: string,
    dto: CreateBackupScheduleDto,
    userId: string,
  ) {
    await this.assertTarget(environmentId, dto);

    const timezone = dto.timezone ?? 'UTC';
    return this.prisma.backupSchedule.create({
      data: {
        environmentId,
        kind: dto.kind,
        databaseId: dto.kind === 'DATABASE' ? dto.databaseId! : null,
        volumeName: dto.kind === 'VOLUME' ? dto.volumeName! : null,
        schedule: dto.schedule,
        timezone,
        keepLast: dto.keepLast ?? 7,
        enabled: dto.enabled ?? true,
        createdById: userId,
        nextRunAt: ScheduledTasksService.nextRun(dto.schedule, timezone),
      },
    });
  }

  async update(id: string, dto: UpdateBackupScheduleDto) {
    const existing = await this.findOrThrow(id);

    const schedule = dto.schedule ?? existing.schedule;
    const timezone = dto.timezone ?? existing.timezone;
    const enabled = dto.enabled ?? existing.enabled;

    // Recompute the cursor whenever the cadence or the clock it is read against
    // changes, otherwise the old slot survives the edit. A disabled schedule
    // gets no cursor at all, so re-enabling never fires a backlog of misses.
    const cadenceChanged =
      schedule !== existing.schedule || timezone !== existing.timezone;
    const nextRunAt = !enabled
      ? null
      : cadenceChanged || existing.nextRunAt === null
        ? ScheduledTasksService.nextRun(schedule, timezone)
        : existing.nextRunAt;

    return this.prisma.backupSchedule.update({
      where: { id },
      data: {
        schedule,
        timezone,
        enabled,
        keepLast: dto.keepLast ?? existing.keepLast,
        nextRunAt,
      },
    });
  }

  async remove(id: string): Promise<void> {
    await this.findOrThrow(id);
    await this.prisma.backupSchedule.delete({ where: { id } });
  }

  async findOrThrow(id: string): Promise<BackupSchedule> {
    const found = await this.prisma.backupSchedule.findUnique({
      where: { id },
    });
    if (!found) throw new NotFoundException('Backup schedule not found');
    return found;
  }

  /**
   * Queue one scheduled backup through the same service the manual button uses,
   * so scheduling adds no second execution path and no new worker surface.
   */
  async run(schedule: BackupSchedule): Promise<void> {
    if (schedule.kind === 'DATABASE') {
      const db = await this.prisma.managedDatabase.findUnique({
        where: { id: schedule.databaseId! },
        select: { status: true },
      });
      // A database that is provisioning or torn down is not an error worth
      // failing on — the next slot will find it ready.
      if (!db || db.status !== 'READY') {
        this.logger.warn(`schedule ${schedule.id} skipped: database not READY`);
        return;
      }
      await this.snapshots.create(
        schedule.databaseId!,
        schedule.createdById,
        true,
      );
    } else {
      await this.volumeBackups.create(
        schedule.environmentId,
        schedule.volumeName!,
        undefined,
        true,
      );
    }

    await this.prisma.backupSchedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date() },
    });
  }

  /**
   * Drop automatic backups beyond keepLast, newest first.
   *
   * Only automatic ones, and never the baseline: a snapshot someone took and
   * named is theirs to delete, and the baseline is the state "Reset data"
   * returns to — pruning either would be a silent data loss dressed up as
   * retention.
   *
   * Runs as its own sweep rather than at the end of a run. A backup is still
   * PENDING when its job is queued, so pruning there counts one fewer than
   * exists and settles at keepLast + 1; sweeping separately also applies a
   * lowered keepLast immediately instead of at the next scheduled backup.
   */
  async prune(schedule: BackupSchedule): Promise<void> {
    if (schedule.keepLast <= 0) return;

    if (schedule.kind === 'DATABASE') {
      const extra = await this.prisma.databaseSnapshot.findMany({
        where: {
          databaseId: schedule.databaseId!,
          status: 'READY',
          automatic: true,
          isBaseline: false,
        },
        orderBy: { createdAt: 'desc' },
        skip: schedule.keepLast,
        select: { id: true },
      });
      for (const s of extra) {
        await this.snapshots.remove(s.id, schedule.createdById);
      }
      if (extra.length > 0) {
        this.logger.log(
          `pruned ${extra.length} snapshot(s) for schedule ${schedule.id}`,
        );
      }
      return;
    }

    const extra = await this.prisma.volumeBackup.findMany({
      where: {
        environmentId: schedule.environmentId,
        volumeName: schedule.volumeName!,
        status: 'READY',
        automatic: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: schedule.keepLast,
      select: { id: true },
    });
    for (const b of extra) {
      await this.volumeBackups.remove(b.id);
    }
    if (extra.length > 0) {
      this.logger.log(
        `pruned ${extra.length} volume backup(s) for schedule ${schedule.id}`,
      );
    }
  }

  private async assertTarget(
    environmentId: string,
    dto: CreateBackupScheduleDto,
  ): Promise<void> {
    if (dto.kind === 'DATABASE') {
      if (!dto.databaseId) {
        throw new BadRequestException(
          'databaseId is required for kind=DATABASE',
        );
      }
      const db = await this.prisma.managedDatabase.findUnique({
        where: { id: dto.databaseId },
        select: { environmentId: true },
      });
      // Checked against this environment, not merely existence: the caller was
      // authorized for this environment and nothing else.
      if (!db || db.environmentId !== environmentId) {
        throw new NotFoundException('Database not found in this environment');
      }
      return;
    }

    if (!dto.volumeName) {
      throw new BadRequestException('volumeName is required for kind=VOLUME');
    }
    await this.volumeBackups.assertDeclared(environmentId, dto.volumeName);
  }
}
