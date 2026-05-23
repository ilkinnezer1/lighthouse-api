import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ensureCan } from '../common/authz';
import { DatabasesService } from '../databases/databases.service';
import { SnapshotsService } from './snapshots.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class SnapshotsController {
  constructor(
    private readonly snapshots: SnapshotsService,
    private readonly databases: DatabasesService,
  ) {}

  @Post('databases/:id/snapshots')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('snapshots.create')
  async create(
    @Param('id', new ParseUUIDPipe()) databaseId: string,
    @CurrentUser() user: User,
  ) {
    const db = await this.databases.findByIdWithOwner(databaseId);
    if (!db || db.environment.project.deletedAt) {
      throw new NotFoundException('Database not found');
    }
    ensureCan(user, 'snapshots.create', db.environment.project);
    if (db.type !== 'POSTGRES') {
      throw new BadRequestException(
        'Snapshots are only supported for POSTGRES databases',
      );
    }
    if (db.status !== 'READY') {
      throw new ConflictException('Database is not READY');
    }
    return this.snapshots.create(databaseId, user.id);
  }

  @Get('databases/:id/snapshots')
  async list(
    @Param('id', new ParseUUIDPipe()) databaseId: string,
    @CurrentUser() user: User,
  ) {
    const db = await this.databases.findByIdWithOwner(databaseId);
    if (!db || db.environment.project.deletedAt) {
      throw new NotFoundException('Database not found');
    }
    ensureCan(user, 'snapshots.read', db.environment.project);
    return this.snapshots.listByDatabase(databaseId);
  }

  @Post('snapshots/:id/restore')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('snapshots.restore')
  async restore(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    const snap = await this.snapshots.findByIdWithOwner(id);
    if (!snap || snap.database.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    ensureCan(user, 'snapshots.restore', snap.database.environment.project);
    if (snap.status !== 'READY') {
      throw new ConflictException('Snapshot is not READY');
    }
    if (snap.database.status !== 'READY') {
      throw new ConflictException('Target database is not READY');
    }
    await this.snapshots.restore(id, snap.databaseId, user.id);
  }

  @Delete('snapshots/:id')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('snapshots.delete')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    const snap = await this.snapshots.findByIdWithOwner(id);
    if (!snap || snap.database.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    ensureCan(user, 'snapshots.delete', snap.database.environment.project);
    await this.snapshots.remove(id, user.id);
  }
}
