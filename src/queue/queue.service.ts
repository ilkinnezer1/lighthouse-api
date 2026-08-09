import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { InjectRedis } from '../redis/redis.constants';
import {
  BUILD_QUEUE_STREAM,
  DATABASE_JOB_TYPES,
  DATABASE_QUEUE_STREAM,
  FIELD_DATABASE_ID,
  FIELD_DEPLOYMENT_ID,
  FIELD_ENVIRONMENT_ID,
  FIELD_JOB_TYPE,
  FIELD_SNAPSHOT_ID,
  TEARDOWN_QUEUE_STREAM,
  VOLUME_BACKUP_JOB_TYPES,
  VOLUME_BACKUP_QUEUE_STREAM,
  FIELD_BACKUP_ID,
  FIELD_STORAGE_KEY,
  cancelChannel,
  type DatabaseJobType,
  type VolumeBackupJobType,
} from './queue.constants';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async enqueueBuild(deploymentId: string): Promise<string> {
    const entryId = await this.redis.xadd(
      BUILD_QUEUE_STREAM,
      '*',
      FIELD_DEPLOYMENT_ID,
      deploymentId,
    );

    if (!entryId) {
      throw new Error('XADD returned no entry ID');
    }
    this.logger.debug(`enqueued build ${deploymentId} as ${entryId}`);

    return entryId;
  }

  async enqueueTeardown(environmentId: string): Promise<string> {
    const entryId = await this.redis.xadd(
      TEARDOWN_QUEUE_STREAM,
      '*',
      FIELD_ENVIRONMENT_ID,
      environmentId,
    );

    if (!entryId) {
      throw new Error('XADD returned no entry ID');
    }
    this.logger.debug(`enqueued teardown ${environmentId} as ${entryId}`);

    return entryId;
  }

  async publishCancel(deploymentId: string): Promise<number> {
    const subs = await this.redis.publish(cancelChannel(deploymentId), '1');
    this.logger.debug(
      `cancel ${deploymentId} delivered to ${subs} subscriber(s)`,
    );
    return subs;
  }

  enqueueDatabaseProvision(databaseId: string): Promise<string> {
    return this.enqueueDatabaseJob(DATABASE_JOB_TYPES.Provision, databaseId);
  }

  enqueueDatabaseTeardown(databaseId: string): Promise<string> {
    return this.enqueueDatabaseJob(DATABASE_JOB_TYPES.Teardown, databaseId);
  }

  enqueueSnapshot(databaseId: string, snapshotId: string): Promise<string> {
    return this.enqueueDatabaseJob(
      DATABASE_JOB_TYPES.Snapshot,
      databaseId,
      snapshotId,
    );
  }

  enqueueSnapshotRestore(
    databaseId: string,
    snapshotId: string,
  ): Promise<string> {
    return this.enqueueDatabaseJob(
      DATABASE_JOB_TYPES.Restore,
      databaseId,
      snapshotId,
    );
  }

  // Carries the storage key because the row is already gone by the time the
  // worker picks this up — the same shape as enqueueVolumeBackupDelete.
  enqueueSnapshotDelete(
    databaseId: string,
    snapshotId: string,
    storageKey: string | null,
  ): Promise<string> {
    return this.enqueueDatabaseJob(
      DATABASE_JOB_TYPES.SnapshotDelete,
      databaseId,
      snapshotId,
      storageKey,
    );
  }

  enqueueVolumeBackup(backupId: string): Promise<string> {
    return this.enqueueVolumeBackupJob(VOLUME_BACKUP_JOB_TYPES.Backup, backupId);
  }

  enqueueVolumeRestore(backupId: string): Promise<string> {
    return this.enqueueVolumeBackupJob(VOLUME_BACKUP_JOB_TYPES.Restore, backupId);
  }

  // The archive key travels with the job so the API can drop the row straight
  // away; re-reading it in the worker would race that delete.
  enqueueVolumeBackupDelete(
    backupId: string,
    storageKey: string | null,
  ): Promise<string> {
    return this.enqueueVolumeBackupJob(
      VOLUME_BACKUP_JOB_TYPES.Delete,
      backupId,
      storageKey,
    );
  }

  private async enqueueVolumeBackupJob(
    type: VolumeBackupJobType,
    backupId: string,
    storageKey?: string | null,
  ): Promise<string> {
    const fields: string[] = [FIELD_JOB_TYPE, type, FIELD_BACKUP_ID, backupId];
    if (storageKey) {
      fields.push(FIELD_STORAGE_KEY, storageKey);
    }
    const entryId = await this.redis.xadd(
      VOLUME_BACKUP_QUEUE_STREAM,
      '*',
      ...fields,
    );
    if (!entryId) {
      throw new Error('XADD returned no entry ID');
    }
    this.logger.debug(`enqueued ${type} ${backupId} as ${entryId}`);
    return entryId;
  }

  private async enqueueDatabaseJob(
    type: DatabaseJobType,
    databaseId: string,
    snapshotId?: string,
    storageKey?: string | null,
  ): Promise<string> {
    const fields: string[] = [
      FIELD_JOB_TYPE,
      type,
      FIELD_DATABASE_ID,
      databaseId,
    ];
    if (snapshotId) {
      fields.push(FIELD_SNAPSHOT_ID, snapshotId);
    }
    if (storageKey) {
      fields.push(FIELD_STORAGE_KEY, storageKey);
    }
    const entryId = await this.redis.xadd(DATABASE_QUEUE_STREAM, '*', ...fields);

    if (!entryId) {
      throw new Error('XADD returned no entry ID');
    }
    this.logger.debug(
      `enqueued database job ${type} db=${databaseId}` +
        (snapshotId ? ` snap=${snapshotId}` : '') +
        ` as ${entryId}`,
    );
    return entryId;
  }
}
