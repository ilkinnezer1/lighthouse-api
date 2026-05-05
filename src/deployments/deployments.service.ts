import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Deployment, DeploymentStage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { DEFAULT_STAGES } from './deployments.constants';

export type DeploymentWithStages = Deployment & {
  stages: DeploymentStage[];
};

@Injectable()
export class DeploymentsService {
  private readonly logger = new Logger(DeploymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async create(
    environmentId: string,
    triggeredByUserId: string,
  ): Promise<DeploymentWithStages> {
    const deployment = await this.prisma.$transaction(async (tx) => {
      return tx.deployment.create({
        data: {
          environmentId,
          triggeredByUserId,
          stages: {
            create: DEFAULT_STAGES.map((name, index) => ({
              name,
              ordinal: index + 1,
            })),
          },
        },
        include: { stages: { orderBy: { ordinal: 'asc' } } },
      });
    });

    try {
      await this.queue.enqueueBuild(deployment.id);
    } catch (err) {
      this.logger.error(
        `enqueue failed for deployment ${deployment.id}; row left in QUEUED for reaper`,
        err,
      );
    }

    return deployment;
  }

  listByEnvironment(environmentId: string): Promise<Deployment[]> {
    return this.prisma.deployment.findMany({
      where: { environmentId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
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
}
