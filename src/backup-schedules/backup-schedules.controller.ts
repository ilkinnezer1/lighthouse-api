import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import type { Action } from '../common/authz';
import { PrismaService } from '../prisma/prisma.service';
import { BackupSchedulesService } from './backup-schedules.service';
import { CreateBackupScheduleDto } from './dto/create-backup-schedule.dto';
import { UpdateBackupScheduleDto } from './dto/update-backup-schedule.dto';

// Gated on the same `snapshots.*` actions as manual backups: arranging for a
// backup to happen later is the same permission as taking one now.
@Controller()
@UseGuards(JwtAuthGuard)
export class BackupSchedulesController {
  constructor(
    private readonly schedules: BackupSchedulesService,
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
  ) {}

  @Get('environments/:id/backup-schedules')
  async list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authorizeEnvironment(id, user, 'snapshots.read');
    return this.schedules.list(id);
  }

  @Post('environments/:id/backup-schedules')
  @HttpCode(HttpStatus.CREATED)
  @Audit('backups.schedule')
  async create(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateBackupScheduleDto,
    @CurrentUser() user: User,
  ) {
    await this.authorizeEnvironment(id, user, 'snapshots.create');
    return this.schedules.create(id, dto, user.id);
  }

  @Patch('backup-schedules/:scheduleId')
  @Audit('backups.schedule-update')
  async update(
    @Param('scheduleId', new ParseUUIDPipe()) scheduleId: string,
    @Body() dto: UpdateBackupScheduleDto,
    @CurrentUser() user: User,
  ) {
    const schedule = await this.schedules.findOrThrow(scheduleId);
    await this.authorizeEnvironment(
      schedule.environmentId,
      user,
      'snapshots.create',
    );
    return this.schedules.update(scheduleId, dto);
  }

  @Delete('backup-schedules/:scheduleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('backups.schedule-delete')
  async remove(
    @Param('scheduleId', new ParseUUIDPipe()) scheduleId: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    const schedule = await this.schedules.findOrThrow(scheduleId);
    // Deleting the schedule stops future backups but destroys nothing that
    // exists, so this is a create-level right rather than a delete-level one.
    await this.authorizeEnvironment(
      schedule.environmentId,
      user,
      'snapshots.create',
    );
    await this.schedules.remove(scheduleId);
  }

  private async authorizeEnvironment(
    id: string,
    user: User,
    action: Action,
  ): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id },
      select: {
        project: { select: { organizationId: true, deletedAt: true } },
      },
    });
    if (!env || env.project.deletedAt) {
      throw new NotFoundException('Environment not found');
    }
    await this.authz.ensureCan(user, action, env.project);
  }
}
