import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseStatus, DatabaseType, Prisma } from '@prisma/client';
import { OUTBOX_EVENT_TYPES } from '../outbox/outbox.constants';
import { PrismaService } from '../prisma/prisma.service';
import { BuildConfigSchema } from '../projects/dto/build-config.schema';
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
    switch (dto.mode) {
      case 'create-empty':
        return this.createEmpty(environmentId, userId, dto);
      case 'copy':
        return this.copyFrom(environmentId, userId, dto);
      case 'create-from-snapshot':
        return this.createFromSnapshot(environmentId, userId, dto);
      case 'attach-existing':
        return this.attachExisting(environmentId, dto);
    }
  }

  /** Translate the (environmentId, name) unique violation into a 409. */
  private async withUniqueName<T>(
    op: () => Promise<T>,
    name: string,
  ): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          `A database named "${name}" already exists in this environment`,
        );
      }
      throw err;
    }
  }

  /**
   * Shared path for every mode that provisions its own container (create-empty,
   * copy, create-from-snapshot): insert a PROVISIONING row, emit the queued
   * event, enqueue one provision job. The worker reads `seedFrom*` / `runMigrate`
   * off the row to decide how to seed and whether to migrate, then writes back
   * host/port/connSecretEnc and flips status to READY (or FAILED).
   */
  private async provisionNew(
    environmentId: string,
    userId: string,
    data: {
      type: DatabaseType;
      version: string;
      name: string;
      seedFromDatabaseId?: string;
      seedFromSnapshotId?: string;
      runMigrate?: boolean;
    },
  ) {
    const created = await this.withUniqueName(
      () =>
        this.prisma.$transaction(async (tx) => {
          const db = await tx.managedDatabase.create({
            data: {
              environmentId,
              status: 'PROVISIONING',
              ownsContainer: true,
              ...data,
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
        }),
      data.name,
    );

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

  /** Mode 2 (and mode 5 when runMigrate is set): empty container. */
  private async createEmpty(
    environmentId: string,
    userId: string,
    dto: CreateDatabaseDto,
  ) {
    const runMigrate = dto.runMigrate ?? false;
    if (runMigrate) {
      await this.assertMigrateConfigured(environmentId);
    }
    return this.provisionNew(environmentId, userId, {
      type: dto.type!,
      version: dto.version!,
      name: dto.name!,
      runMigrate,
    });
  }

  /**
   * Mode 3: clone a live DB. type/version come from the source (no cross-engine
   * copies); the worker does pg_dump | pg_restore from `seedFromDatabaseId`.
   */
  private async copyFrom(
    environmentId: string,
    userId: string,
    dto: CreateDatabaseDto,
  ) {
    const source = await this.prisma.managedDatabase.findUnique({
      where: { id: dto.sourceDatabaseId! },
      select: { type: true, version: true, status: true },
    });
    if (!source) {
      throw new NotFoundException('Source database not found');
    }
    if (source.type !== DatabaseType.POSTGRES) {
      throw new BadRequestException(
        'Copy is only supported for POSTGRES databases',
      );
    }
    if (source.status !== 'READY') {
      throw new ConflictException('Source database is not READY');
    }
    return this.provisionNew(environmentId, userId, {
      type: source.type,
      version: source.version,
      name: dto.name!,
      seedFromDatabaseId: dto.sourceDatabaseId!,
    });
  }

  /**
   * Mode 4: provision a new container and seed it from a snapshot's MinIO blob
   * (the snapshot may belong to a DB in another environment). type/version come
   * from the snapshot's source database.
   */
  private async createFromSnapshot(
    environmentId: string,
    userId: string,
    dto: CreateDatabaseDto,
  ) {
    const snap = await this.prisma.databaseSnapshot.findUnique({
      where: { id: dto.snapshotId! },
      select: {
        status: true,
        storageKey: true,
        database: { select: { type: true, version: true } },
      },
    });
    if (!snap) {
      throw new NotFoundException('Snapshot not found');
    }
    // Every engine can snapshot and restore in place; only seeding a *new*
    // container from a snapshot is Postgres-only, because just provisionPostgres
    // consumes seedFromSnapshotId.
    if (snap.database.type !== DatabaseType.POSTGRES) {
      throw new BadRequestException(
        `Creating a database from a snapshot is only supported for POSTGRES; restore a ${snap.database.type} snapshot into an existing database instead`,
      );
    }
    if (snap.status !== 'READY' || !snap.storageKey) {
      throw new ConflictException('Snapshot is not READY');
    }
    return this.provisionNew(environmentId, userId, {
      type: snap.database.type,
      version: snap.database.version,
      name: dto.name!,
      seedFromSnapshotId: dto.snapshotId!,
    });
  }

  /** Mode 5 guard: the project must actually define a migrate command. */
  private async assertMigrateConfigured(environmentId: string): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      select: { project: { select: { buildConfig: true } } },
    });
    const parsed = BuildConfigSchema.safeParse(env?.project.buildConfig ?? {});
    const dbMigrate = parsed.success ? parsed.data.dbMigrate : undefined;
    if (!dbMigrate || dbMigrate.length === 0) {
      throw new BadRequestException(
        'runMigrate requires buildConfig.dbMigrate to be set on the project',
      );
    }
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

    return this.withUniqueName(
      () =>
        this.prisma.managedDatabase.create({
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
        }),
      source.name,
    );
  }

  listByEnvironment(environmentId: string) {
    return this.prisma.managedDatabase.findMany({
      where: { environmentId },
      orderBy: { createdAt: 'desc' },
      select: PUBLIC_SELECT,
    });
  }

  // Scoped to one org (the caller's resolved active/personal org); membership is
  // validated by the controller via AuthzService.resolveScopeOrgId.
  async listForOrg(
    organizationId: string,
    opts: {
      limit?: number;
      cursor?: string;
      status?: DatabaseStatus;
      type?: DatabaseType;
      projectId?: string;
    } = {},
  ) {
    const limit = opts.limit ?? 20;
    const where: Prisma.ManagedDatabaseWhereInput = {
      status: opts.status,
      type: opts.type,
      environment: {
        project: {
          deletedAt: null,
          id: opts.projectId,
          organizationId,
        },
      },
    };

    const rows = await this.prisma.managedDatabase.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        ...PUBLIC_SELECT,
        environment: {
          select: {
            id: true,
            name: true,
            project: {
              select: {
                id: true,
                name: true,
                subdomain: true,
                owner: { select: { username: true } },
              },
            },
          },
        },
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * Public fields plus the environment → project → org chain so the controller
   * can authorize. Never includes `connSecretEnc`.
   */
  findByIdWithOwner(id: string) {
    return this.prisma.managedDatabase.findUnique({
      where: { id },
      select: {
        ...PUBLIC_SELECT,
        environment: {
          select: {
            project: { select: { organizationId: true, deletedAt: true } },
          },
        },
      },
    });
  }

  /**
   * Org chain for a snapshot (snapshot → database → environment → project), for
   * authorizing create-from-snapshot. Lives here rather than in
   * SnapshotsService to avoid a circular module dependency.
   */
  findSnapshotWithOwner(snapshotId: string) {
    return this.prisma.databaseSnapshot.findUnique({
      where: { id: snapshotId },
      select: {
        status: true,
        database: {
          select: {
            environment: {
              select: {
                project: { select: { organizationId: true, deletedAt: true } },
              },
            },
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
  async remove(id: string, userId: string): Promise<void> {
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
            userId,
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
