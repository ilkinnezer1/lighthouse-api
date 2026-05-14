import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Environment, Project } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseGithubFullName } from './util/repo-url';

export type ProjectWithEnvironments = Project & {
  environments: Environment[];
};

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async create(
    ownerId: string,
    data: {
      name: string;
      slug: string;
      subdomain: string;
      repoUrl: string;
      defaultBranch?: string;
    },
  ): Promise<ProjectWithEnvironments> {
    const branch = data.defaultBranch || 'main';
    const webhookSecretEnc = this.crypto.encrypt(
      randomBytes(32).toString('hex'),
    );
    const providerRepoFullName = parseGithubFullName(data.repoUrl);

    try {
      return await this.prisma.project.create({
        data: {
          ownerId,
          name: data.name,
          slug: data.slug,
          subdomain: data.subdomain,
          repoUrl: data.repoUrl,
          defaultBranch: branch,
          providerRepoFullName,
          webhookSecretEnc,
          environments: {
            create: {
              name: 'production',
              type: 'PRODUCTION',
              subdomain: 'production',
              branch,
            },
          },
        },
        include: { environments: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = (err.meta?.target as string[] | undefined)?.join(',');
        const field = target?.includes('subdomain') ? 'subdomain' : 'slug';
        throw new ConflictException(`Project ${field} already in use`);
      }

      throw err;
    }
  }

  findAllByOwner(ownerId: string): Promise<Project[]> {
    return this.prisma.project.findMany({
      where: { ownerId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  findById(id: string): Promise<ProjectWithEnvironments | null> {
    return this.prisma.project.findFirst({
      where: { id, deletedAt: null },
      include: { environments: true },
    });
  }

  async update(
    id: string,
    patch: {
      name?: string;
      defaultBranch?: string;
      buildConfig?: Record<string, unknown>;
    },
  ): Promise<Project> {
    try {
      return await this.prisma.project.update({
        where: { id, deletedAt: null },
        data: patch as Prisma.ProjectUpdateInput,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Project not found');
      }
      throw err;
    }
  }

  async softDelete(id: string): Promise<void> {
    try {
      await this.prisma.project.update({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Project not found');
      }
      throw err;
    }
  }
}
