import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Deployment, DeploymentStage } from '@prisma/client';
import { buildDeployUrl } from '../common/url';
import type { Env } from '../config/env';
import { OUTBOX_EVENT_TYPES } from '../outbox/outbox.constants';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { DEFAULT_STAGES } from './deployments.constants';

export type DeploymentWithStages = Deployment & {
  stages: DeploymentStage[];
};

type EnvForUrl = {
  subdomain: string;
  customDomain: string | null;
  project: {
    subdomain: string;
    owner: { username: string };
  };
};

@Injectable()
export class DeploymentsService {
  private readonly logger = new Logger(DeploymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async create(
    environmentId: string,
    triggeredByUserId: string,
    commit?: { sha?: string; message?: string; author?: string },
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
        },
        include: {
          stages: { orderBy: { ordinal: 'asc' } },
          environment: {
            include: {
              project: {
                include: { owner: { select: { username: true } } },
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
        services: true,
        environment: {
          include: {
            project: {
              include: { owner: { select: { username: true } } },
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
      select: { id: true },
    });

    if (!deployment) {
      throw new NotFoundException();
    }

    await this.queue.publishCancel(id);
  }

  private urlFor(env: EnvForUrl): string {
    return buildDeployUrl({
      mode: this.config.get('MODE', { infer: true }),
      baseDomain: this.config.get('BASE_DOMAIN', { infer: true }),
      username: env.project.owner.username,
      projectSubdomain: env.project.subdomain,
      envSubdomain: env.subdomain,
      customDomain: env.customDomain,
    });
  }
}
