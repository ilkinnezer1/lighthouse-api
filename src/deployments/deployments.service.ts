import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { DeploymentStatus } from '@prisma/client';
import { buildDeployUrl } from '../common/url';
import type { Env } from '../config/env';
import { OUTBOX_EVENT_TYPES } from '../outbox/outbox.constants';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import {
  DeploymentBranchesService,
  type BranchRow,
} from './deployment-branches.service';
import { DEFAULT_STAGES } from './deployments.constants';

export interface CreateDeploymentOptions {
  commit?: { sha?: string; message?: string; author?: string };
  sourceBranch?: string;
  mergeBranches?: string[];
}

type EnvForUrl = {
  subdomain: string;
  customDomain: string | null;
  project: {
    subdomain: string;
    organization: { slug: string };
  };
};

@Injectable()
export class DeploymentsService {
  private readonly logger = new Logger(DeploymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly config: ConfigService<Env, true>,
    private readonly branches: DeploymentBranchesService,
  ) {}

  async create(
    environmentId: string,
    triggeredByUserId: string,
    opts: CreateDeploymentOptions = {},
  ) {
    // Resolve the branch set (SOURCE + merges) to commit SHAs before opening
    // the transaction — it makes a GitHub call and validates branch names.
    const branchRows = await this.branches.resolve(
      environmentId,
      opts.sourceBranch,
      opts.mergeBranches,
    );
    return this.enqueue(
      environmentId,
      triggeredByUserId,
      branchRows,
      opts.commit,
    );
  }

  // Re-runs an existing deployment's branch set at the branches' CURRENT tips
  // (re-resolves names → fresh SHAs). Plain deploys (no branch rows) redeploy
  // the environment's branch tip.
  async redeploy(deploymentId: string, triggeredByUserId: string) {
    const src = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        branches: { orderBy: { ordinal: 'asc' } },
        environment: { select: { project: { select: { deletedAt: true } } } },
      },
    });
    if (!src || src.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    const sourceBranch = src.branches.find((b) => b.role === 'SOURCE')?.name;
    const mergeBranches = src.branches
      .filter((b) => b.role === 'MERGE')
      .map((b) => b.name);
    return this.create(src.environmentId, triggeredByUserId, {
      sourceBranch,
      mergeBranches,
    });
  }

  // Reproduces a previous SUCCEEDED build by re-enqueueing its branch set pinned
  // to the SAME SHAs (worker's fetchRef pins on sha). Plain deploys pin a single
  // SOURCE row to the recorded commit SHA so the old code is rebuilt exactly.
  async rollback(deploymentId: string, triggeredByUserId: string) {
    const src = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        branches: { orderBy: { ordinal: 'asc' } },
        environment: {
          select: {
            branch: true,
            project: { select: { deletedAt: true } },
          },
        },
      },
    });
    if (!src || src.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    if (src.status !== 'SUCCEEDED') {
      throw new ConflictException(
        'Can only roll back to a succeeded deployment',
      );
    }

    const branchRows: BranchRow[] = src.branches.length
      ? src.branches.map((b) => ({
          role: b.role,
          name: b.name,
          sha: b.sha,
          ordinal: b.ordinal,
        }))
      : this.pinnedSourceRow(src.environment.branch, src.commitSha);

    return this.enqueue(src.environmentId, triggeredByUserId, branchRows, {
      sha: src.commitSha ?? undefined,
      message: src.commitMessage ?? undefined,
      author: src.commitAuthor ?? undefined,
    });
  }

  // A single SHA-pinned SOURCE row, used to roll back a plain deploy to the
  // exact commit it built. Throws if the deploy has no recorded commit to pin.
  private pinnedSourceRow(
    branch: string | null,
    sha: string | null,
  ): BranchRow[] {
    if (!branch || !sha) {
      throw new BadRequestException(
        'Deployment has no pinned commit to roll back to',
      );
    }
    return [{ role: 'SOURCE', name: branch, sha, ordinal: 0 }];
  }

  private async enqueue(
    environmentId: string,
    triggeredByUserId: string,
    branchRows: BranchRow[],
    commit?: CreateDeploymentOptions['commit'],
  ) {
    const deployment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.deployment.create({
        data: {
          environmentId,
          triggeredByUserId,
          commitSha: commit?.sha,
          commitMessage: commit?.message,
          commitAuthor: commit?.author,
          stages: {
            create: DEFAULT_STAGES.map((name, index) => ({
              name,
              ordinal: index + 1,
            })),
          },
          branches: branchRows.length ? { create: branchRows } : undefined,
        },
        include: {
          stages: { orderBy: { ordinal: 'asc' } },
          branches: { orderBy: { ordinal: 'asc' } },
          environment: {
            include: {
              project: {
                include: {
                  owner: { select: { username: true } },
                  organization: { select: { slug: true } },
                },
              },
            },
          },
        },
      });
      await tx.eventOutbox.create({
        data: {
          type: OUTBOX_EVENT_TYPES.DeploymentQueued,
          userId: triggeredByUserId,
          payload: {
            deploymentId: created.id,
            environmentId: created.environmentId,
            status: created.status,
          },
        },
      });

      return created;
    });

    try {
      await this.queue.enqueueBuild(deployment.id);
    } catch (err) {
      this.logger.error(
        `enqueue failed for deployment ${deployment.id}; row left in QUEUED for reaper`,
        err,
      );
    }

    return { ...deployment, url: this.urlFor(deployment.environment) };
  }

  // Scoped to one org (the caller's resolved active/personal org); membership is
  // validated by the controller via AuthzService.resolveScopeOrgId.
  async listForOrg(
    organizationId: string,
    opts: {
      limit?: number;
      cursor?: string;
      status?: DeploymentStatus;
      projectId?: string;
    } = {},
  ) {
    const limit = opts.limit ?? 20;
    const where: Prisma.DeploymentWhereInput = {
      status: opts.status,
      environment: {
        project: {
          deletedAt: null,
          id: opts.projectId,
          organizationId,
        },
      },
    };

    const rows = await this.prisma.deployment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: {
        branches: { orderBy: { ordinal: 'asc' } },
        environment: {
          select: {
            id: true,
            name: true,
            subdomain: true,
            customDomain: true,
            project: {
              select: {
                id: true,
                name: true,
                subdomain: true,
                owner: { select: { username: true } },
                organization: { select: { slug: true } },
              },
            },
          },
        },
      },
    });

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((d) => ({
      ...d,
      url: this.urlFor(d.environment),
    }));
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async listByEnvironment(environmentId: string) {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      select: {
        subdomain: true,
        customDomain: true,
        project: {
          select: {
            subdomain: true,
            owner: { select: { username: true } },
            organization: { select: { slug: true } },
          },
        },
      },
    });
    if (!env) return [];

    const url = this.urlFor(env);
    const deployments = await this.prisma.deployment.findMany({
      where: { environmentId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return deployments.map((d) => ({ ...d, url }));
  }

  async findById(id: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id },
      include: {
        stages: { orderBy: { ordinal: 'asc' } },
        branches: { orderBy: { ordinal: 'asc' } },
        services: true,
        environment: {
          include: {
            project: {
              include: {
                owner: { select: { username: true } },
                organization: { select: { slug: true } },
              },
            },
          },
        },
      },
    });
    if (!deployment) return null;
    return { ...deployment, url: this.urlFor(deployment.environment) };
  }

  async cancel(id: string): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!deployment) {
      throw new NotFoundException();
    }

    if (deployment.status === 'QUEUED') {
      const now = new Date();
      const won = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.deployment.updateMany({
          where: { id, status: 'QUEUED' },
          data: {
            status: 'CANCELLED',
            cancelRequestedAt: now,
            finishedAt: now,
          },
        });
        if (updated.count === 0) return false;
        await tx.eventOutbox.create({
          data: {
            type: OUTBOX_EVENT_TYPES.DeploymentCancelled,
            userId: null,
            payload: { deploymentId: id, reason: 'cancelled-before-pickup' },
          },
        });
        return true;
      });
      if (won) return;
    }

    await this.prisma.deployment.update({
      where: { id },
      data: { cancelRequestedAt: new Date() },
    });
    await this.queue.publishCancel(id);
  }

  private urlFor(env: EnvForUrl): string {
    return buildDeployUrl({
      mode: this.config.get('MODE', { infer: true }),
      baseDomain: this.config.get('BASE_DOMAIN', { infer: true }),
      identity: env.project.organization.slug,
      projectSubdomain: env.project.subdomain,
      envSubdomain: env.subdomain,
      customDomain: env.customDomain,
    });
  }
}
