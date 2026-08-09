import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
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
