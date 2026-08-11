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
import { CreateVolumeBackupDto } from './dto/create-volume-backup.dto';
import { UpdateVolumeBackupDto } from './dto/update-volume-backup.dto';
import { VolumeBackupsService } from './volume-backups.service';

// Backups of persistent volumes. Gated on the existing `snapshots.*` actions
// rather than a new capability: these are the same operation on a different
// storage engine, and a second vocabulary for "may back up" would be a second
// source of truth for the same permission.
@Controller()
@UseGuards(JwtAuthGuard)
export class VolumeBackupsController {
  constructor(
    private readonly backups: VolumeBackupsService,
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
  ) {}

  @Get('environments/:id/volume-backups')
  async list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authorizeEnvironment(id, user, 'snapshots.read');
    return this.backups.list(id);
  }

  @Post('environments/:id/volume-backups')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('volumes.backup')
  async create(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateVolumeBackupDto,
    @CurrentUser() user: User,
  ) {
    await this.authorizeEnvironment(id, user, 'snapshots.create');
    return this.backups.create(id, dto.volumeName, dto.label);
  }

  // Destructive: replaces the volume's contents and briefly stops whatever is
  // using it, so it needs restore rights, not merely create.
  @Post('volume-backups/:backupId/restore')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('volumes.restore')
  async restore(
    @Param('backupId', new ParseUUIDPipe()) backupId: string,
    @CurrentUser() user: User,
  ): Promise<{ status: string }> {
    const backup = await this.backups.findOrThrow(backupId);
    await this.authorizeEnvironment(
      backup.environmentId,
      user,
      'snapshots.restore',
    );
    await this.backups.restore(backupId);
    return { status: 'restoring' };
  }

  // Name a backup, or promote it to the environment's reset point.
  @Patch('volume-backups/:backupId')
  @Audit('volumes.backup-update')
  async update(
    @Param('backupId', new ParseUUIDPipe()) backupId: string,
    @Body() dto: UpdateVolumeBackupDto,
    @CurrentUser() user: User,
  ) {
    const backup = await this.backups.findOrThrow(backupId);
    await this.authorizeEnvironment(
      backup.environmentId,
      user,
      'snapshots.create',
    );
    return this.backups.setMeta(backupId, dto);
  }

  @Delete('volume-backups/:backupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('volumes.backup-delete')
  async remove(
    @Param('backupId', new ParseUUIDPipe()) backupId: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    const backup = await this.backups.findOrThrow(backupId);
    await this.authorizeEnvironment(
      backup.environmentId,
      user,
      'snapshots.delete',
    );
    await this.backups.remove(backupId);
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
