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
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ensureCan } from '../common/authz';
import { PrismaService } from '../prisma/prisma.service';
import { DatabasesService } from './databases.service';
import { CreateDatabaseDto } from './dto/create-database.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class DatabasesController {
  constructor(
    private readonly databases: DatabasesService,
    private readonly prisma: PrismaService,
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
      select: { project: { select: { ownerId: true, deletedAt: true } } },
    });
    if (!env || env.project.deletedAt) {
      throw new NotFoundException('Environment not found');
    }
    ensureCan(user, 'databases.create', env.project);

    // Reusing a connection requires owning the source DB too.
    if (dto.mode === 'attach-existing') {
      const source = await this.databases.findByIdWithOwner(dto.databaseId!);
      if (!source || source.environment.project.deletedAt) {
        throw new NotFoundException('Source database not found');
      }
      ensureCan(user, 'databases.create', source.environment.project);
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
      select: { project: { select: { ownerId: true, deletedAt: true } } },
    });
    if (!env || env.project.deletedAt) {
      throw new NotFoundException('Environment not found');
    }
    ensureCan(user, 'databases.read', env.project);
    return this.databases.listByEnvironment(envId);
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
    ensureCan(user, 'databases.read', environment.project);
    return rest;
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
    ensureCan(user, 'databases.delete', db.environment.project);
    await this.databases.remove(id);
  }
}
