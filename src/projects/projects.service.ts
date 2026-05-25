import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Environment, Project } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { CryptoService } from '../crypto/crypto.service';
import { GithubApiService } from '../github/github-api.service';
import { PrismaService } from '../prisma/prisma.service';
import { BuildConfigSchema } from './dto/build-config.schema';
import { parseGithubFullName } from './util/repo-url';

export type ProjectWithEnvironments = Project & {
  environments: Environment[];
};

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly github: GithubApiService,
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
    const webhookSecretEnc = this.crypto.encrypt(
      randomBytes(32).toString('hex'),
    );
    const providerRepoFullName = parseGithubFullName(data.repoUrl);

    // Prefer an explicit branch; otherwise ask GitHub for the repo's default
    // (e.g. master vs main) and only fall back to 'main' if that lookup fails
    // or the repo isn't a recognizable GitHub URL.
    let branch = data.defaultBranch;
    if (!branch && providerRepoFullName) {
      branch =
        (await this.github.getDefaultBranch(ownerId, providerRepoFullName)) ??
        undefined;
    }
    branch = branch || 'main';

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
    const data: Prisma.ProjectUpdateInput = {
      name: patch.name,
      defaultBranch: patch.defaultBranch,
    };

    if (patch.buildConfig !== undefined) {
      const parsed = BuildConfigSchema.safeParse(patch.buildConfig);
      if (!parsed.success) {
        throw new BadRequestException({
          message: 'Invalid buildConfig',
          issues: parsed.error.issues,
        });
      }
      data.buildConfig = parsed.data;
    }

    try {
      return await this.prisma.project.update({
        where: { id, deletedAt: null },
        data,
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
