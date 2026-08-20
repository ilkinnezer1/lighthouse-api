import { Injectable, NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { AuthzService } from '../authz/authz.service';
import type { Action } from '../common/authz';
import { PrismaService } from '../prisma/prisma.service';
import { DeploymentsService } from './deployments.service';

export type DeploymentDetail = NonNullable<
  Awaited<ReturnType<DeploymentsService['findById']>>
>;

// A soft-deleted project hides its deployments, so every lookup here treats
// `project.deletedAt` as a 404 before the capability check runs.
@Injectable()
export class DeploymentAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentsService,
    private readonly authz: AuthzService,
  ) {}

  async detail(
    id: string,
    user: User,
    action: Action,
  ): Promise<DeploymentDetail> {
    const dep = await this.deployments.findById(id);
    if (!dep || dep.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    await this.authz.ensureCan(user, action, dep.environment.project);
    return dep;
  }

  // Authorization only, for handlers that need nothing from the deployment
  // itself — skips the stages/branches/services joins `detail` pays for.
  // Returns the environment id, which redeploy/rollback need to check the lock.
  async authorize(id: string, user: User, action: Action): Promise<string> {
    const dep = await this.prisma.deployment.findUnique({
      where: { id },
      select: {
        environmentId: true,
        environment: {
          select: {
            project: { select: { organizationId: true, deletedAt: true } },
          },
        },
      },
    });
    if (!dep || dep.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    await this.authz.ensureCan(user, action, dep.environment.project);
    return dep.environmentId;
  }

  async authorizeEnvironment(
    envId: string,
    user: User,
    action: Action,
  ): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id: envId },
      select: {
        project: { select: { organizationId: true, deletedAt: true } },
      },
    });
    if (!env || env.project.deletedAt) {
      throw new NotFoundException('Environment not found');
    }
    await this.authz.ensureCan(user, action, env.project);
  }
}
