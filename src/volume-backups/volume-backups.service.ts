import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { VolumeBackup } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { BuildConfigSchema } from '../projects/dto/build-config.schema';

// Wire shape: BigInt doesn't survive JSON.stringify, so size is narrowed to a
// number here rather than blowing up in the serializer.
export interface VolumeBackupView {
  id: string;
  environmentId: string;
  volumeName: string;
  status: VolumeBackup['status'];
  sizeBytes: number | null;
  errorSummary: string | null;
  label: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

@Injectable()
export class VolumeBackupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async list(environmentId: string): Promise<VolumeBackupView[]> {
    const rows = await this.prisma.volumeBackup.findMany({
      where: { environmentId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toView);
  }

  /**
   * Queue a backup of one declared volume.
   *
   * The volume name is checked against the project's `buildConfig.volumes`
   * rather than against Docker: the worker is the only process allowed near the
   * socket, so the API validates the declaration and lets the worker report a
   * volume that doesn't exist on disk yet.
   */
  async create(
    environmentId: string,
    volumeName: string,
    label?: string,
    automatic = false,
  ): Promise<VolumeBackupView> {
    await this.assertDeclared(environmentId, volumeName);

    const backup = await this.prisma.volumeBackup.create({
      data: {
        environmentId,
        volumeName,
        label: label?.trim() || null,
        automatic,
      },
    });
    await this.queue.enqueueVolumeBackup(backup.id);
    return toView(backup);
  }

  async restore(backupId: string): Promise<void> {
    const backup = await this.findOrThrow(backupId);
    if (backup.status !== 'READY') {
      throw new ConflictException(
        `Backup is ${backup.status.toLowerCase()} — only a READY backup can be restored`,
      );
    }
    await this.queue.enqueueVolumeRestore(backup.id);
  }

  /**
   * Drop the row and ask the worker to remove the archive. The row goes first so
   * the UI reflects the delete immediately; the object is chased asynchronously,
   * which is why the key travels on the job.
   */
  async remove(backupId: string): Promise<void> {
    const backup = await this.findOrThrow(backupId);
    await this.prisma.volumeBackup.delete({ where: { id: backupId } });
    await this.queue.enqueueVolumeBackupDelete(backup.id, backup.storageKey);
  }

  async findOrThrow(backupId: string): Promise<VolumeBackup> {
    const backup = await this.prisma.volumeBackup.findUnique({
      where: { id: backupId },
    });
    if (!backup) {
      throw new NotFoundException('Backup not found');
    }
    return backup;
  }

  /** Shared with backup schedules, so a schedule can't be saved against a
   * volume the project never declares. */
  async assertDeclared(
    environmentId: string,
    volumeName: string,
  ): Promise<void> {
    const declared = await this.declaredVolumes(environmentId);
    if (!declared.includes(volumeName)) {
      throw new BadRequestException(
        declared.length === 0
          ? 'This project declares no volumes; add one in build settings first'
          : `Unknown volume "${volumeName}". Declared: ${declared.join(', ')}`,
      );
    }
  }

  private async declaredVolumes(environmentId: string): Promise<string[]> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      select: { project: { select: { buildConfig: true } } },
    });
    if (!env) {
      throw new NotFoundException('Environment not found');
    }
    const parsed = BuildConfigSchema.safeParse(env.project.buildConfig);
    if (!parsed.success) {
      return [];
    }
    return (parsed.data.volumes ?? []).map((v) => v.name);
  }
}

function toView(row: VolumeBackup): VolumeBackupView {
  return {
    id: row.id,
    environmentId: row.environmentId,
    volumeName: row.volumeName,
    status: row.status,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    errorSummary: row.errorSummary,
    label: row.label,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
