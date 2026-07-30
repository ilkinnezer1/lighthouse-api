import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Body,
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
import { DatabasesService } from '../databases/databases.service';
import { UpdateSnapshotDto } from './dto/update-snapshot.dto';
import { PrismaService } from '../prisma/prisma.service';
import { SnapshotsService } from './snapshots.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class SnapshotsController {
  constructor(
    private readonly snapshots: SnapshotsService,
    private readonly databases: DatabasesService,
    private readonly authz: AuthzService,
    private readonly prisma: PrismaService,
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
    await this.authz.ensureCan(
      user,
      'snapshots.create',
      db.environment.project,
    );
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
    await this.authz.ensureCan(user, 'snapshots.read', db.environment.project);
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
    await this.authz.ensureCan(
      user,
      'snapshots.restore',
      snap.database.environment.project,
    );
    if (snap.status !== 'READY') {
      throw new ConflictException('Snapshot is not READY');
    }
    if (snap.database.status !== 'READY') {
      throw new ConflictException('Target database is not READY');
    }
    await this.snapshots.restore(id, snap.databaseId, user.id);
  }

  // Name a snapshot, or promote it to the environment's reset point.
  @Patch('snapshots/:id')
  @Audit('snapshots.update')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSnapshotDto,
    @CurrentUser() user: User,
  ) {
    const snap = await this.snapshots.findByIdWithOwner(id);
    if (!snap || snap.database.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    await this.authz.ensureCan(
      user,
      'snapshots.create',
      snap.database.environment.project,
    );
    if (dto.isBaseline === true && snap.status !== 'READY') {
      throw new ConflictException('Only a READY snapshot can be the baseline');
    }
    return this.snapshots.setMeta(id, snap.databaseId, dto);
  }

  // One click back to a known-good state — the QA reset button.
  @Post('environments/:envId/reset')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('environments.reset')
  async reset(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @CurrentUser() user: User,
  ) {
    const env = await this.prisma.environment.findUnique({
      where: { id: envId },
      select: { id: true, project: true },
    });
    if (!env || env.project.deletedAt) throw new NotFoundException();
    await this.authz.ensureCan(user, 'snapshots.restore', env.project);
    return this.snapshots.resetEnvironment(envId, user.id);
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
    await this.authz.ensureCan(
      user,
      'snapshots.delete',
      snap.database.environment.project,
    );
    await this.snapshots.remove(id, user.id);
  }
}
