import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OUTBOX_EVENT_TYPES } from '../outbox/outbox.constants';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { CreateDatabaseDto } from './dto/create-database.dto';

/**
 * Columns safe to return over the API. Deliberately omits `connSecretEnc` —
 * the encrypted connection string never leaves the box except to the worker.
 */
const PUBLIC_SELECT = {
  id: true,
  environmentId: true,
  type: true,
  version: true,
  name: true,
  status: true,
  ownsContainer: true,
  host: true,
  port: true,
  errorSummary: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ManagedDatabaseSelect;

@Injectable()
export class DatabasesService {
  private readonly logger = new Logger(DatabasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  create(environmentId: string, userId: string, dto: CreateDatabaseDto) {
    return dto.mode === 'create-empty'
      ? this.createEmpty(environmentId, userId, dto)
      : this.attachExisting(environmentId, dto);
  }

  /**
   * Mode 2: insert a PROVISIONING row and hand the worker a job to spawn a
   * dedicated container. The worker writes back host/port/connSecretEnc and
   * flips status to READY (or FAILED).
   */
  private async createEmpty(
    environmentId: string,
    userId: string,
    dto: CreateDatabaseDto,
  ) {
    const created = await this.prisma.$transaction(async (tx) => {
      const db = await tx.managedDatabase.create({
        data: {
          environmentId,
          type: dto.type!,
          version: dto.version!,
          name: dto.name!,
          status: 'PROVISIONING',
          ownsContainer: true,
        },
        select: PUBLIC_SELECT,
      });
      await tx.eventOutbox.create({
        data: {
          type: OUTBOX_EVENT_TYPES.DatabaseProvisionQueued,
          userId,
          payload: {
            databaseId: db.id,
            environmentId,
            type: db.type,
          },
        },
      });
      return db;
    });

    try {
      await this.queue.enqueueDatabaseProvision(created.id);
    } catch (err) {
      this.logger.error(
        `enqueue provision failed for database ${created.id}; row left PROVISIONING for reaper`,
        err,
      );
    }

    return created;
  }

  /**
   * Mode 1: a new env-owned row that reuses an existing READY DB's connection.
   * No worker job — the connection is already live. `ownsContainer = false`
   * so deleting this row never tears down the shared container.
   */
  private async attachExisting(environmentId: string, dto: CreateDatabaseDto) {
    const source = await this.prisma.managedDatabase.findUnique({
      where: { id: dto.databaseId! },
      select: {
        type: true,
        version: true,
        name: true,
        status: true,
        host: true,
        port: true,
        connSecretEnc: true,
      },
    });
    if (!source) {
      throw new NotFoundException('Source database not found');
    }
    if (source.status !== 'READY') {
      throw new ConflictException('Source database is not READY');
    }

    return this.prisma.managedDatabase.create({
      data: {
        environmentId,
        type: source.type,
        version: source.version,
        name: source.name,
        status: 'READY',
        ownsContainer: false,
        host: source.host,
        port: source.port,
        connSecretEnc: source.connSecretEnc,
      },
      select: PUBLIC_SELECT,
    });
  }

  listByEnvironment(environmentId: string) {
    return this.prisma.managedDatabase.findMany({
      where: { environmentId },
      orderBy: { createdAt: 'desc' },
      select: PUBLIC_SELECT,
    });
  }

  /**
   * Public fields plus the environment → project → owner chain so the
   * controller can authorize. Never includes `connSecretEnc`.
   */
  findByIdWithOwner(id: string) {
    return this.prisma.managedDatabase.findUnique({
      where: { id },
      select: {
        ...PUBLIC_SELECT,
        environment: {
          select: {
            project: { select: { ownerId: true, deletedAt: true } },
          },
        },
      },
    });
  }

  /**
   * Hard-deletes the row (cascading its snapshots). Only rows that own a
   * dedicated container enqueue a teardown job; attached rows just disappear,
   * leaving the shared container untouched. Worker also reaps the row's
   * snapshot blobs from MinIO during teardown.
   */
  async remove(id: string): Promise<void> {
    const db = await this.prisma.managedDatabase.findUnique({
      where: { id },
      select: { id: true, ownsContainer: true },
    });
    if (!db) {
      throw new NotFoundException();
    }

    await this.prisma.$transaction(async (tx) => {
      if (db.ownsContainer) {
        await tx.eventOutbox.create({
          data: {
            type: OUTBOX_EVENT_TYPES.DatabaseTeardownQueued,
            userId: null,
            payload: { databaseId: id },
          },
        });
      }
      await tx.managedDatabase.delete({ where: { id } });
    });

    if (db.ownsContainer) {
      try {
        await this.queue.enqueueDatabaseTeardown(id);
      } catch (err) {
        this.logger.error(`enqueue teardown failed for database ${id}`, err);
      }
    }
  }
}
