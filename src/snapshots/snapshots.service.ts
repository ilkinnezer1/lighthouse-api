import { Readable } from 'node:stream';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Env } from '../config/env';
import { OUTBOX_EVENT_TYPES } from '../outbox/outbox.constants';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

const SNAP_SELECT = {
  id: true,
  databaseId: true,
  status: true,
  storageKey: true,
  sizeBytes: true,
  errorSummary: true,
  label: true,
  isBaseline: true,
  origin: true,
  fileName: true,
  importStatus: true,
  createdAt: true,
} satisfies Prisma.DatabaseSnapshotSelect;

type SnapshotRow = Prisma.DatabaseSnapshotGetPayload<{
  select: typeof SNAP_SELECT;
}>;

/**
 * `sizeBytes` is a BigInt column; Express's JSON serializer can't handle
 * BigInt, so render it as a decimal string (null stays null).
 */
function toDto(s: SnapshotRow) {
  return {
    ...s,
    sizeBytes: s.sizeBytes === null ? null : s.sizeBytes.toString(),
  };
}

export type SnapshotDto = ReturnType<typeof toDto>;

export interface DumpUpload {
  body: Readable;
  contentLength: number;
  fileName: string;
  /** Aborted, with a human reason, when the browser upload breaks off. */
  signal: AbortSignal;
}

class ImportUploadError extends Error {
  constructor(
    readonly summary: string,
    readonly response: HttpException,
  ) {
    super(summary);
  }
}

@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Insert a PENDING snapshot row and hand the worker a `pg_dump → MinIO` job.
   * The worker writes back storageKey/sizeBytes and flips status to READY.
   */
  async create(databaseId: string, userId: string, automatic = false) {
    const snap = await this.prisma.$transaction(async (tx) => {
      const s = await tx.databaseSnapshot.create({
        data: { databaseId, status: 'PENDING', automatic },
        select: SNAP_SELECT,
      });
      await tx.eventOutbox.create({
        data: {
          type: OUTBOX_EVENT_TYPES.SnapshotQueued,
          userId,
          payload: { snapshotId: s.id, databaseId },
        },
      });
      return s;
    });

    try {
      await this.queue.enqueueSnapshot(databaseId, snap.id);
    } catch (err) {
      this.logger.error(
        `enqueue snapshot failed for ${snap.id}; row left PENDING`,
        err,
      );
    }

    return toDto(snap);
  }

  async listByDatabase(databaseId: string) {
    const rows = await this.prisma.databaseSnapshot.findMany({
      where: { databaseId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: SNAP_SELECT,
    });
    return rows.map(toDto);
  }

  /**
   * Snapshot fields plus the database → environment → project → owner chain so
   * the controller can authorize.
   */
  findByIdWithOwner(id: string) {
    return this.prisma.databaseSnapshot.findUnique({
      where: { id },
      select: {
        ...SNAP_SELECT,
        database: {
          select: {
            id: true,
            status: true,
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
   * In-place rollback (7a): worker restores the snapshot blob back into the
   * same database it came from. Snapshot must be READY (blob exists).
   */
  /**
   * Name a snapshot, and optionally make it the database's baseline — the state
   * `resetEnvironment` returns to. At most one baseline per database, so
   * promoting one demotes the previous in the same transaction.
   */
  async setMeta(
    snapshotId: string,
    databaseId: string,
    meta: { label?: string | null; isBaseline?: boolean },
  ) {
    // `sizeBytes` is BigInt, which Express cannot serialize — every read path
    // has to go back through toDto, including this one.
    if (meta.isBaseline === true) {
      const [, updated] = await this.prisma.$transaction([
        this.prisma.databaseSnapshot.updateMany({
          where: { databaseId, isBaseline: true, NOT: { id: snapshotId } },
          data: { isBaseline: false },
        }),
        this.prisma.databaseSnapshot.update({
          where: { id: snapshotId },
          data: meta,
          select: SNAP_SELECT,
        }),
      ]);
      return toDto(updated);
    }
    const updated = await this.prisma.databaseSnapshot.update({
      where: { id: snapshotId },
      data: meta,
      select: SNAP_SELECT,
    });
    return toDto(updated);
  }

  /**
   * Restore every database *and volume* in the environment to its baseline — the
   * "give me a clean environment" button. Anything without a baseline, or not
   * READY, is reported back rather than silently ignored, so a partial reset
   * never looks like a complete one.
   *
   * Volumes are here because leaving them out made the button lie. Since volumes
   * began persisting across redeploys, an environment's state lives as much in
   * uploaded files and SQLite data as in its databases; resetting only the
   * databases handed back a "clean" environment still carrying the last test's
   * data, which surfaces later as a mysterious failure.
   */
  async resetEnvironment(environmentId: string, userId: string) {
    const databases = await this.prisma.managedDatabase.findMany({
      where: { environmentId },
      select: {
        id: true,
        name: true,
        status: true,
        snapshots: {
          where: { isBaseline: true },
          select: { id: true, status: true, label: true },
          take: 1,
        },
      },
    });

    const restored: { database: string; snapshotId: string }[] = [];
    const skipped: { database: string; reason: string }[] = [];

    for (const db of databases) {
      const baseline = db.snapshots[0];
      if (!baseline) {
        skipped.push({ database: db.name, reason: 'no baseline snapshot' });
        continue;
      }
      if (baseline.status !== 'READY') {
        skipped.push({ database: db.name, reason: 'baseline is not READY' });
        continue;
      }
      if (db.status !== 'READY') {
        skipped.push({ database: db.name, reason: 'database is not READY' });
        continue;
      }
      await this.restore(baseline.id, db.id, userId);
      restored.push({ database: db.name, snapshotId: baseline.id });
    }

    const volumes = await this.resetVolumes(environmentId);

    return { restored, skipped, ...volumes };
  }

  /**
   * The volume half of a reset. A volume restore stops whatever is using the
   * volume and starts it again, so this costs a short outage — the same trade a
   * single volume restore already makes, and the reason it is worth saying out
   * loud in the UI rather than burying.
   */
  private async resetVolumes(environmentId: string) {
    const baselines = await this.prisma.volumeBackup.findMany({
      where: { environmentId, isBaseline: true },
      select: { id: true, volumeName: true, status: true },
      orderBy: { volumeName: 'asc' },
    });

    const volumesRestored: { volume: string; backupId: string }[] = [];
    const volumesSkipped: { volume: string; reason: string }[] = [];

    for (const baseline of baselines) {
      if (baseline.status !== 'READY') {
        volumesSkipped.push({
          volume: baseline.volumeName,
          reason: 'baseline is not READY',
        });
        continue;
      }
      try {
        await this.queue.enqueueVolumeRestore(baseline.id);
        volumesRestored.push({
          volume: baseline.volumeName,
          backupId: baseline.id,
        });
      } catch (err) {
        // One volume failing to enqueue must not abandon the rest of the reset.
        this.logger.error(
          `enqueue volume restore failed for ${baseline.id}`,
          err,
        );
        volumesSkipped.push({
          volume: baseline.volumeName,
          reason: 'could not be queued',
        });
      }
    }

    return { volumesRestored, volumesSkipped };
  }

  async restore(snapshotId: string, databaseId: string, userId: string) {
    await this.prisma.databaseSnapshot.updateMany({
      where: { id: snapshotId, origin: 'IMPORT' },
      data: { importStatus: 'RESTORING', errorSummary: null },
    });
    await this.prisma.eventOutbox.create({
      data: {
        type: OUTBOX_EVENT_TYPES.SnapshotRestoreQueued,
        userId,
        payload: { snapshotId, databaseId },
      },
    });
    await this.queue.enqueueSnapshotRestore(databaseId, snapshotId);
  }

  /**
   * Import a user's dump: an IMPORT snapshot whose blob the worker streams to
   * MinIO straight from the browser's request, then the ordinary restore job.
   * Resolves once the blob is stored and the restore is queued.
   */
  async importDump(
    databaseId: string,
    userId: string,
    upload: DumpUpload,
  ): Promise<SnapshotDto> {
    const snap = await this.beginImport(databaseId, userId, upload.fileName);

    try {
      await this.uploadToWorker(databaseId, snap.id, upload);
    } catch (err) {
      const failure =
        err instanceof ImportUploadError
          ? err
          : new ImportUploadError(
              'upload failed',
              new BadGatewayException('Import upload failed'),
            );
      await this.failImport(snap.id, databaseId, userId, failure.summary);
      throw failure.response;
    }

    try {
      await this.restore(snap.id, databaseId, userId);
    } catch (err) {
      this.logger.error(`enqueue import restore failed for ${snap.id}`, err);
      await this.prisma.databaseSnapshot.update({
        where: { id: snap.id },
        data: {
          importStatus: 'FAILED',
          errorSummary: 'dump stored, but the restore could not be queued',
        },
      });
      throw new ServiceUnavailableException(
        'Dump stored, but the restore could not be queued',
      );
    }

    const row = await this.prisma.databaseSnapshot.findUniqueOrThrow({
      where: { id: snap.id },
      select: SNAP_SELECT,
    });
    return toDto(row);
  }

  // The row lock serialises concurrent imports into one database, so the
  // in-flight check and the insert cannot interleave.
  private beginImport(databaseId: string, userId: string, fileName: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM managed_databases WHERE id = ${databaseId}::uuid FOR UPDATE`;
      const inFlight = await tx.databaseSnapshot.findFirst({
        where: { databaseId, importStatus: { in: ['UPLOADING', 'RESTORING'] } },
        select: { id: true },
      });
      if (inFlight) {
        throw new ConflictException(
          'An import is already in progress for this database',
        );
      }
      const s = await tx.databaseSnapshot.create({
        data: {
          databaseId,
          status: 'PENDING',
          origin: 'IMPORT',
          importStatus: 'UPLOADING',
          fileName,
        },
        select: SNAP_SELECT,
      });
      await tx.eventOutbox.create({
        data: {
          type: OUTBOX_EVENT_TYPES.SnapshotImportQueued,
          userId,
          payload: { snapshotId: s.id, databaseId, fileName },
        },
      });
      return s;
    });
  }

  private async uploadToWorker(
    databaseId: string,
    snapshotId: string,
    upload: DumpUpload,
  ): Promise<void> {
    const base = this.config.get('WORKER_HTTP_URL', { infer: true });
    const init: RequestInit & { duplex: 'half' } = {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(upload.contentLength),
        'X-Import-Filename': encodeURIComponent(upload.fileName),
      },
      body: Readable.toWeb(upload.body) as ReadableStream<Uint8Array>,
      duplex: 'half',
      signal: upload.signal,
    };

    let resp: globalThis.Response;
    try {
      resp = await fetch(
        `${base}/databases/${databaseId}/snapshots/${snapshotId}/upload`,
        init,
      );
    } catch {
      if (upload.signal.aborted) {
        const reason = String(upload.signal.reason);
        throw new ImportUploadError(reason, new BadRequestException(reason));
      }
      throw new ImportUploadError(
        'upload interrupted or worker unreachable',
        new BadGatewayException('Worker unreachable'),
      );
    }
    if (resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      return;
    }

    const detail = await this.workerError(resp);
    const summary = detail ?? `worker rejected the upload (${resp.status})`;
    const message = detail ?? 'Import upload failed';
    switch (resp.status) {
      case 400:
        throw new ImportUploadError(summary, new BadRequestException(message));
      case 409:
        throw new ImportUploadError(summary, new ConflictException(message));
      case 413:
        throw new ImportUploadError(
          summary,
          new PayloadTooLargeException(message),
        );
      default:
        throw new ImportUploadError(summary, new BadGatewayException(message));
    }
  }

  private async workerError(resp: globalThis.Response): Promise<string | null> {
    try {
      const body = (await resp.json()) as { error?: unknown };
      return typeof body.error === 'string' && body.error ? body.error : null;
    } catch {
      return null;
    }
  }

  // The worker also marks the row on its own failures; writing it here covers
  // the cases it never sees, like an unreachable worker or a dropped client.
  private async failImport(
    snapshotId: string,
    databaseId: string,
    userId: string,
    errorSummary: string,
  ): Promise<void> {
    try {
      await this.prisma.$transaction([
        this.prisma.databaseSnapshot.update({
          where: { id: snapshotId },
          data: { status: 'FAILED', importStatus: 'FAILED', errorSummary },
        }),
        this.prisma.eventOutbox.create({
          data: {
            type: OUTBOX_EVENT_TYPES.SnapshotFailed,
            userId,
            payload: { snapshotId, databaseId, reason: 'import_upload' },
          },
        }),
      ]);
    } catch (err) {
      this.logger.error(`failed to mark import ${snapshotId} FAILED`, err);
    }
  }

  /**
   * Remove a snapshot: drop the row, then have the worker chase the blob. A
   * snapshot that never materialized (PENDING, no storageKey) has no blob to
   * chase.
   */
  async remove(snapshotId: string, userId: string): Promise<void> {
    const snap = await this.prisma.databaseSnapshot.findUnique({
      where: { id: snapshotId },
      select: { id: true, databaseId: true, storageKey: true },
    });
    if (!snap) {
      throw new NotFoundException();
    }

    // The row goes first, and the key travels on the job. The worker never
    // deleted the row, so leaving it for the worker left every deleted snapshot
    // in the list forever; re-reading it there would also race this delete.
    await this.prisma.$transaction([
      this.prisma.databaseSnapshot.delete({ where: { id: snapshotId } }),
      this.prisma.eventOutbox.create({
        data: {
          type: OUTBOX_EVENT_TYPES.SnapshotDeleteQueued,
          userId,
          payload: { snapshotId, databaseId: snap.databaseId },
        },
      }),
    ]);

    if (snap.storageKey === null) return;

    try {
      await this.queue.enqueueSnapshotDelete(
        snap.databaseId,
        snapshotId,
        snap.storageKey,
      );
    } catch (err) {
      this.logger.error(
        `enqueue snapshot delete failed for ${snapshotId}`,
        err,
      );
    }
  }
}
