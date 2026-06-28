import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { ZodType } from 'zod';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import { Action } from '../common/authz';
import { PrismaService } from '../prisma/prisma.service';
import {
  DeleteManagedFileSchema,
  FileContentQuerySchema,
  PutManagedFileSchema,
} from './dto/managed-file.schema';
import { ManagedFilesService } from './managed-files.service';

@Controller('environments/:id/files')
@UseGuards(JwtAuthGuard)
export class ManagedFilesController {
  constructor(
    private readonly files: ManagedFilesService,
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
  ) {}

  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authorize(id, user, 'environments.read');
    return { files: await this.files.list(id) };
  }

  @Get('tree')
  async tree(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.authorize(id, user, 'environments.read');
    return this.files.tree(id);
  }

  @Get('content')
  async content(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: unknown,
    @CurrentUser() user: User,
  ) {
    await this.authorize(id, user, 'environments.read');
    const { path } = parse(FileContentQuerySchema, query);
    return this.files.content(id, path);
  }

  @Put()
  @Audit('environments.file')
  async upsert(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CurrentUser() user: User,
  ) {
    await this.authorize(id, user, 'environments.update');
    const { path, content } = parse(PutManagedFileSchema, body);
    return this.files.upsert(id, path, content);
  }

  @Delete()
  @Audit('environments.file')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: unknown,
    @CurrentUser() user: User,
  ) {
    await this.authorize(id, user, 'environments.update');
    const { path } = parse(DeleteManagedFileSchema, query);
    await this.files.remove(id, path);
    return { ok: true };
  }

  private async authorize(
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

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Invalid managed file',
      issues: result.error.issues,
    });
  }
  return result.data;
}
