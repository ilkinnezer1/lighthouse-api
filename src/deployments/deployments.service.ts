import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Deployment, DeploymentStage } from '@prisma/client';
import { OUTBOX_EVENT_TYPES } from '../outbox/outbox.constants';
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
      const created = await tx.deployment.create({
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

      // Same TX as the deployment row: if the row commits the event commits.
      // Drainer (OutboxService) picks it up within ~1s and the WS gateway
      // relays it to the deployment + user rooms.
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
