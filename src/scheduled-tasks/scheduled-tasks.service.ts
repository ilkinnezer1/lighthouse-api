import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CronExpressionParser } from 'cron-parser';
import type { ScheduledTask } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateScheduledTaskDto } from './dto/create-scheduled-task.dto';
import type { UpdateScheduledTaskDto } from './dto/update-scheduled-task.dto';

const RUN_HISTORY_LIMIT = 50;

@Injectable()
export class ScheduledTasksService {
  constructor(private readonly prisma: PrismaService) {}

  static nextRun(
    schedule: string,
    timezone: string,
    after: Date = new Date(),
  ): Date {
    return CronExpressionParser.parse(schedule, {
      tz: timezone,
      currentDate: after,
    })
      .next()
      .toDate();
  }

  // Scoped to one org (the caller's resolved active/personal org); membership is
  // validated by the controller via AuthzService.resolveScopeOrgId.
  async listForOrg(
    organizationId: string,
    opts: { projectId?: string; enabled?: boolean } = {},
  ) {
    return this.prisma.scheduledTask.findMany({
      where: {
        enabled: opts.enabled,
        environment: {
          project: {
            deletedAt: null,
            id: opts.projectId,
            organizationId,
          },
        },
      },
      orderBy: [{ enabled: 'desc' }, { nextRunAt: 'asc' }, { name: 'asc' }],
      include: {
        environment: {
          select: {
            id: true,
            name: true,
            project: { select: { id: true, name: true } },
          },
        },
        runs: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            status: true,
            exitCode: true,
            startedAt: true,
            finishedAt: true,
            errorSummary: true,
          },
        },
      },
    });
  }

  async list(environmentId: string) {
    return this.prisma.scheduledTask.findMany({
      where: { environmentId },
      orderBy: { name: 'asc' },
      include: {
        runs: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            status: true,
            exitCode: true,
            startedAt: true,
            finishedAt: true,
            errorSummary: true,
          },
        },
      },
    });
  }

  async create(environmentId: string, dto: CreateScheduledTaskDto) {
    const timezone = dto.timezone ?? 'UTC';
    const enabled = dto.enabled ?? true;

    const duplicate = await this.prisma.scheduledTask.findFirst({
      where: { environmentId, name: dto.name },
      select: { id: true },
    });
    if (duplicate) {
      throw new BadRequestException(
        `A task named "${dto.name}" already exists in this environment`,
      );
    }

    return this.prisma.scheduledTask.create({
      data: {
        environmentId,
        name: dto.name,
        service: dto.service,
        command: dto.command,
        schedule: dto.schedule,
        timezone,
        enabled,
        timeoutSec: dto.timeoutSec ?? 900,
        overlap: dto.overlap ?? 'SKIP',
        nextRunAt: enabled
          ? ScheduledTasksService.nextRun(dto.schedule, timezone)
          : null,
      },
    });
  }

  async update(id: string, dto: UpdateScheduledTaskDto) {
    const existing = await this.findOrThrow(id);

    const schedule = dto.schedule ?? existing.schedule;
    const timezone = dto.timezone ?? existing.timezone;
    const enabled = dto.enabled ?? existing.enabled;

    return this.prisma.scheduledTask.update({
      where: { id },
      data: {
        ...dto,
        // Recomputed on every write: a changed cron, zone, or enabled flag all
        // invalidate the precomputed due-time the sweep reads.
        nextRunAt: enabled
          ? ScheduledTasksService.nextRun(schedule, timezone)
          : null,
      },
    });
  }

  async remove(id: string) {
    await this.findOrThrow(id);
    await this.prisma.scheduledTask.delete({ where: { id } });
  }

  async runs(id: string) {
    await this.findOrThrow(id);
    return this.prisma.taskRun.findMany({
      where: { taskId: id },
      orderBy: { startedAt: 'desc' },
      take: RUN_HISTORY_LIMIT,
    });
  }

  async findOrThrow(id: string): Promise<ScheduledTask> {
    const task = await this.prisma.scheduledTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Scheduled task not found');
    return task;
  }

  async environmentOf(id: string) {
    const task = await this.prisma.scheduledTask.findUnique({
      where: { id },
      select: {
        environment: {
          select: { id: true, type: true, project: true },
        },
      },
    });
    if (!task) throw new NotFoundException('Scheduled task not found');
    return task.environment;
  }
}
