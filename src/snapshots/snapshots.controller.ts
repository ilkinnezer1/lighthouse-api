import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Body,
  Param,
  ParseUUIDPipe,
  Patch,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import type { Env } from '../config/env';
import { DatabasesService } from '../databases/databases.service';
import { UpdateSnapshotDto } from './dto/update-snapshot.dto';
import { PrismaService } from '../prisma/prisma.service';
import { SnapshotsService } from './snapshots.service';
import {
  hasImportExtension,
  importExtensions,
  parseContentLength,
  parseImportFileName,
} from './util/import-file';

export const IMPORT_IDLE_TIMEOUT_MS = 60_000;

@Controller()
@UseGuards(JwtAuthGuard)
export class SnapshotsController {
  constructor(
    private readonly snapshots: SnapshotsService,
    private readonly databases: DatabasesService,
    private readonly authz: AuthzService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // The body is the raw dump, streamed to the worker as it arrives. No body
  // parser matches application/octet-stream, so nothing has read it yet.
  @Post('databases/:id/imports')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('databases.import')
  async importDump(
    @Param('id', new ParseUUIDPipe()) databaseId: string,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') rawLength: string | undefined,
    @Headers('x-import-filename') rawFileName: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user: User,
  ) {
    // Whatever the outcome, never let Node drain an unread multi-GB body to
    // keep the connection alive.
    res.setHeader('Connection', 'close');

    const db = await this.databases.findByIdWithOwner(databaseId);
    if (!db || db.environment.project.deletedAt) {
      throw new NotFoundException('Database not found');
    }
    await this.authz.ensureCan(
      user,
      'snapshots.restore',
      db.environment.project,
    );

    if (
      contentType?.split(';')[0].trim().toLowerCase() !==
      'application/octet-stream'
    ) {
      throw new UnsupportedMediaTypeException(
        'Send the dump as application/octet-stream',
      );
    }
    const contentLength = parseContentLength(rawLength);
    if (contentLength === null) {
      throw new HttpException(
        'Content-Length is required',
        HttpStatus.LENGTH_REQUIRED,
      );
    }
    const maxBytes = this.config.get('DB_IMPORT_MAX_BYTES', { infer: true });
    if (contentLength > maxBytes) {
      throw new PayloadTooLargeException(
        `Dump exceeds the ${maxBytes}-byte import limit`,
      );
    }
    if (contentLength === 0) {
      throw new BadRequestException('Dump is empty');
    }

    const extensions = importExtensions(db.type);
    if (extensions.length === 0) {
      throw new BadRequestException(
        `Importing is only supported for MYSQL and POSTGRES databases`,
      );
    }
    const fileName = parseImportFileName(rawFileName);
    if (!fileName) {
      throw new BadRequestException(
        'X-Import-Filename must be the URL-encoded file name',
      );
    }
    if (!hasImportExtension(db.type, fileName)) {
      throw new BadRequestException(
        `A ${db.type} import must be one of: ${extensions.join(', ')}`,
      );
    }
    if (db.status !== 'READY') {
      throw new ConflictException('Database is not READY');
    }

    const aborted = new AbortController();
    // 'error' fires before 'close' and before fetch sees the broken body, so
    // the reason is recorded by the time the upload rejects.
    const onBroken = () => {
      if (!req.complete && !aborted.signal.aborted) {
        aborted.abort('upload aborted by the client');
      }
    };
    req.once('error', onBroken);
    req.once('close', onBroken);
    // requestTimeout is off server-wide (see main.ts), so this is what bounds
    // a body that stops arriving.
    req.setTimeout(IMPORT_IDLE_TIMEOUT_MS, () => {
      aborted.abort(
        `upload stalled: no data for ${IMPORT_IDLE_TIMEOUT_MS / 1000} s`,
      );
      req.destroy();
    });
    req.once('end', () => req.setTimeout(0));
    try {
      return await this.snapshots.importDump(databaseId, user.id, {
        body: req,
        contentLength,
        fileName,
        signal: aborted.signal,
      });
    } finally {
      req.off('error', onBroken);
      req.off('close', onBroken);
    }
  }

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
