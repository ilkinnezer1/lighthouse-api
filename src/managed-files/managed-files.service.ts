import {
  BadGatewayException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Env } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

export interface ManagedFileView {
  path: string;
  content: string;
  updatedAt: string;
}

export interface FileTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  overridden: boolean;
}

export interface FileTreeView {
  entries: FileTreeEntry[];
  truncated?: boolean;
  // The deployment left no source on disk to browse — an image deploy skips the
  // clone entirely, and an old workdir may have been reaped. Not an error.
  noSource?: boolean;
}

export interface FileContentView {
  path: string;
  content: string;
  overridden: boolean;
  binary: boolean;
  truncated: boolean;
}

interface WorkerTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
}

interface WorkerTreeResponse {
  entries: WorkerTreeEntry[];
  truncated?: boolean;
}

interface WorkerContentResponse {
  path: string;
  content: string;
  binary: boolean;
  truncated: boolean;
}

@Injectable()
export class ManagedFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(environmentId: string): Promise<ManagedFileView[]> {
    const rows = await this.prisma.managedFile.findMany({
      where: { environmentId },
      orderBy: { path: 'asc' },
    });
    return rows.map((row) => ({
      path: row.path,
      content: this.crypto.decrypt(row.contentEnc),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async upsert(
    environmentId: string,
    path: string,
    content: string,
  ): Promise<ManagedFileView> {
    const contentEnc = this.crypto.encrypt(content);
    const row = await this.prisma.managedFile.upsert({
      where: { environmentId_path: { environmentId, path } },
      create: { environmentId, path, contentEnc },
      update: { contentEnc },
    });
    return {
      path: row.path,
      content,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async remove(environmentId: string, path: string): Promise<void> {
    try {
      await this.prisma.managedFile.delete({
        where: { environmentId_path: { environmentId, path } },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException(`No managed file "${path}"`);
      }
      throw err;
    }
  }

  async tree(environmentId: string): Promise<FileTreeView> {
    const deploymentId = await this.latestSucceededDeploymentId(environmentId);
    if (!deploymentId) {
      return { entries: [] };
    }

    let worker: WorkerTreeResponse;
    try {
      worker = await this.fetchWorker<WorkerTreeResponse>(
        `/deployments/${deploymentId}/files/tree`,
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        return { entries: [], noSource: true };
      }
      throw err;
    }

    const overrides = new Set(
      (
        await this.prisma.managedFile.findMany({
          where: { environmentId },
          select: { path: true },
        })
      ).map((row) => row.path),
    );

    const entries: FileTreeEntry[] = worker.entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type,
      size: entry.size,
      overridden: entry.type === 'file' && overrides.has(entry.path),
    }));

    return { entries, truncated: worker.truncated };
  }

  async content(
    environmentId: string,
    path: string,
  ): Promise<FileContentView> {
    const override = await this.prisma.managedFile.findUnique({
      where: { environmentId_path: { environmentId, path } },
    });
    if (override) {
      return {
        path,
        content: this.crypto.decrypt(override.contentEnc),
        overridden: true,
        binary: false,
        truncated: false,
      };
    }

    const deploymentId = await this.latestSucceededDeploymentId(environmentId);
    if (!deploymentId) {
      throw new NotFoundException('No successful deployment yet');
    }

    const worker = await this.fetchWorker<WorkerContentResponse>(
      `/deployments/${deploymentId}/files/content?path=${encodeURIComponent(path)}`,
    );

    return {
      path: worker.path,
      content: worker.content,
      overridden: false,
      binary: worker.binary,
      truncated: worker.truncated,
    };
  }

  private async latestSucceededDeploymentId(
    environmentId: string,
  ): Promise<string | null> {
    const deployment = await this.prisma.deployment.findFirst({
      where: { environmentId, status: 'SUCCEEDED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return deployment?.id ?? null;
  }

  private async fetchWorker<T>(path: string): Promise<T> {
    const base = this.config.get('WORKER_HTTP_URL', { infer: true });
    let resp: globalThis.Response;
    try {
      resp = await fetch(`${base}${path}`);
    } catch {
      throw new BadGatewayException('Worker unreachable');
    }
    if (resp.status === 404) {
      throw new NotFoundException('File not found');
    }
    if (!resp.ok) {
      throw new BadGatewayException('Worker file request failed');
    }
    return (await resp.json()) as T;
  }
}
