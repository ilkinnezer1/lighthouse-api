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
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import { PrismaService } from '../prisma/prisma.service';
import { DatabasesService } from './databases.service';
import { CreateDatabaseDto } from './dto/create-database.dto';
import { ListDatabasesDto } from './dto/list-databases.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class DatabasesController {
  constructor(
    private readonly databases: DatabasesService,
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
  ) {}

  @Post('environments/:envId/databases')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('databases.create')
  async create(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @Body() dto: CreateDatabaseDto,
    @CurrentUser() user: User,
  ) {
    const env = await this.prisma.environment.findUnique({
      where: { id: envId },
      select: {
        project: { select: { organizationId: true, deletedAt: true } },
      },
    });
    if (!env || env.project.deletedAt) {
      throw new NotFoundException('Environment not found');
    }
    await this.authz.ensureCan(user, 'databases.create', env.project);

    // Modes that seed from / reuse an existing resource also require owning it.
    if (dto.mode === 'attach-existing') {
      const source = await this.databases.findByIdWithOwner(dto.databaseId!);
      if (!source || source.environment.project.deletedAt) {
        throw new NotFoundException('Source database not found');
      }
      await this.authz.ensureCan(
        user,
        'databases.create',
        source.environment.project,
      );
    } else if (dto.mode === 'copy') {
      const source = await this.databases.findByIdWithOwner(
        dto.sourceDatabaseId!,
      );
      if (!source || source.environment.project.deletedAt) {
        throw new NotFoundException('Source database not found');
      }
      await this.authz.ensureCan(
        user,
        'databases.read',
        source.environment.project,
      );
    } else if (dto.mode === 'create-from-snapshot') {
      const snap = await this.databases.findSnapshotWithOwner(dto.snapshotId!);
      if (!snap || snap.database.environment.project.deletedAt) {
        throw new NotFoundException('Snapshot not found');
      }
      await this.authz.ensureCan(
        user,
        'snapshots.read',
        snap.database.environment.project,
      );
    }

    return this.databases.create(envId, user.id, dto);
  }

  @Get('environments/:envId/databases')
  async list(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @CurrentUser() user: User,
  ) {
    const env = await this.prisma.environment.findUnique({
      where: { id: envId },
      select: {
        project: { select: { organizationId: true, deletedAt: true } },
      },
    });
    if (!env || env.project.deletedAt) {
      throw new NotFoundException('Environment not found');
    }
    await this.authz.ensureCan(user, 'databases.read', env.project);
    return this.databases.listByEnvironment(envId);
  }

  @Get('databases')
  async listAll(@Query() query: ListDatabasesDto, @CurrentUser() user: User) {
    const orgId = await this.authz.resolveScopeOrgId(user, query.orgId);
    return this.databases.listForOrg(orgId, query);
  }

  @Get('databases/:id')
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    const db = await this.databases.findByIdWithOwner(id);
    if (!db) {
      throw new NotFoundException();
    }
    // Peel off the owner chain (used only for authz) so it never leaks into
    // the response.
    const { environment, ...rest } = db;
    if (environment.project.deletedAt) {
      throw new NotFoundException();
    }
    await this.authz.ensureCan(user, 'databases.read', environment.project);
    const [withState] = await this.databases.withContainerState([rest]);
    return withState;
  }

  @Delete('databases/:id')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('databases.delete')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    const db = await this.databases.findByIdWithOwner(id);
    if (!db || db.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    await this.authz.ensureCan(
      user,
      'databases.delete',
      db.environment.project,
    );
    await this.databases.remove(id, user.id);
  }
}
