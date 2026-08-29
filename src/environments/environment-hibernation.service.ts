import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeploymentStatus, type User } from '@prisma/client';
import { AuthzService } from '../authz/authz.service';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateHibernationDto } from './dto/update-hibernation.dto';
import {
  HIBERNATION_SELECT,
  hibernationState,
  type EnvironmentHibernation,
} from './environment-hibernation';
import {
  LOCK_SELECT,
  environmentLockedConflict,
  lockHeldAgainst,
} from './environment-lock';

// Statuses where the worker is still acting on the environment. SUCCEEDED is
// the terminal success; RUNNING means containers are up but the pipeline has
// not finished, which is exactly when stopping them would be destructive.
export const NON_TERMINAL_DEPLOYMENT_STATUSES: DeploymentStatus[] = [
  DeploymentStatus.QUEUED,
  DeploymentStatus.CLONING,
  DeploymentStatus.BUILDING,
  DeploymentStatus.PUSHING,
  DeploymentStatus.STARTING,
  DeploymentStatus.RUNNING,
];

export interface WorkerServiceState {
  name: string;
  state: string;
}

interface WorkerHibernationResponse {
  deploymentId: string;
  action: string;
  services: WorkerServiceState[];
}

export interface HibernationActionResult {
  hibernation: EnvironmentHibernation;
  services: WorkerServiceState[];
}

/** The deployment hibernation acts on: newest SUCCEEDED, with containers. */
export interface CurrentDeployment {
  id: string;
  hasContainers: boolean;
}

@Injectable()
export class EnvironmentHibernationService {
  private readonly logger = new Logger(EnvironmentHibernationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly authz: AuthzService,
  ) {}

  async updateSettings(
    environmentId: string,
    user: User,
    dto: UpdateHibernationDto,
  ): Promise<EnvironmentHibernation> {
    const env = await this.authorize(environmentId, user);

    // Opting in starts the idle clock now. A count from before anyone asked for
    // hibernation says nothing about how long this timeout has been running,
    // and reusing it would sleep the environment early.
    const startingClock = dto.enabled && !env.hibernationEnabled;

    const updated = await this.prisma.environment.update({
      where: { id: environmentId },
      data: {
        hibernationEnabled: dto.enabled,
        idleTimeoutMinutes: dto.idleTimeoutMinutes ?? env.idleTimeoutMinutes,
        ...(startingClock
          ? { lastActivityAt: new Date(), lastRequestCount: null }
          : {}),
      },
      select: HIBERNATION_SELECT,
    });
    return hibernationState(updated);
  }

  /**
   * Start the containers again and clear the sleeping state.
   *
   * `lastRequestCount` is deliberately left alone: Traefik's counter for the
   * restarted service comes back lower than the stored value, which the next
   * poll reads as a reset and marks active — so a just-woken environment does
   * not go straight back to sleep.
   */
  async wake(
    environmentId: string,
    user: User,
  ): Promise<HibernationActionResult> {
    await this.authorize(environmentId, user);

    const current = await this.currentDeployment(environmentId);
    if (!current) {
      throw new ConflictException(
        'Environment has no successful deployment to wake',
      );
    }

    const services = await this.callWorker(current.id, 'wake');
    const updated = await this.prisma.environment.update({
      where: { id: environmentId },
      data: { hibernatedAt: null, lastActivityAt: new Date() },
      select: HIBERNATION_SELECT,
    });
    return { hibernation: hibernationState(updated), services };
  }

  /** Manual sleep. The vetoes that protect a person's work still apply. */
  async hibernateNow(
    environmentId: string,
    user: User,
  ): Promise<HibernationActionResult> {
    const env = await this.authorize(environmentId, user);

    // Somebody else's live lock is "I am testing this" — the same gate a deploy
    // hits. The holder may still sleep their own environment.
    const held = lockHeldAgainst(env, user.id);
    if (held) throw environmentLockedConflict(held);

    if (await this.deploymentInFlight(environmentId)) {
      throw new ConflictException(
        'A deployment is in progress for this environment',
      );
    }

    const current = await this.currentDeployment(environmentId);
    if (!current?.hasContainers) {
      throw new ConflictException('Environment has no running containers');
    }

    const services = await this.stopDeployment(current.id);
    const updated = await this.prisma.environment.update({
      where: { id: environmentId },
      data: { hibernatedAt: new Date() },
      select: HIBERNATION_SELECT,
    });
    return { hibernation: hibernationState(updated), services };
  }

  /**
   * A build that succeeded has running containers by definition, so whatever
   * the scheduler decided before it is stale. Also stamps activity: a fresh
   * deploy deserves the full timeout before anyone sleeps it again.
   */
  async clearForDeployment(deploymentId: string): Promise<void> {
    await this.prisma.environment.updateMany({
      where: { deployments: { some: { id: deploymentId } } },
      data: { hibernatedAt: null, lastActivityAt: new Date() },
    });
  }

  stopDeployment(deploymentId: string): Promise<WorkerServiceState[]> {
    return this.callWorker(deploymentId, 'hibernate');
  }

  async currentDeployment(
    environmentId: string,
  ): Promise<CurrentDeployment | null> {
    const deployment = await this.prisma.deployment.findFirst({
      where: { environmentId, status: DeploymentStatus.SUCCEEDED },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, services: { select: { containerId: true } } },
    });
    if (!deployment) return null;
    return {
      id: deployment.id,
      hasContainers: deployment.services.some((s) => s.containerId !== null),
    };
  }

  async deploymentInFlight(environmentId: string): Promise<boolean> {
    const inFlight = await this.prisma.deployment.findFirst({
      where: {
        environmentId,
        status: { in: NON_TERMINAL_DEPLOYMENT_STATUSES },
      },
      select: { id: true },
    });
    return inFlight !== null;
  }

  private async callWorker(
    deploymentId: string,
    action: 'hibernate' | 'wake',
  ): Promise<WorkerServiceState[]> {
    const base = this.config.get('WORKER_HTTP_URL', { infer: true });
    const url = `${base}/deployments/${deploymentId}/${action}`;

    let resp: globalThis.Response;
    try {
      resp = await fetch(url, { method: 'POST' });
    } catch (err) {
      this.logger.warn(`worker ${action} for ${deploymentId} failed: ${err}`);
      throw new BadGatewayException('Worker unreachable');
    }
    if (resp.status === 404) {
      throw new NotFoundException('Deployment has no containers');
    }
    if (!resp.ok) {
      throw new BadGatewayException(`Could not ${action} the environment`);
    }

    const body = (await resp.json()) as WorkerHibernationResponse;
    return body.services ?? [];
  }

  private async authorize(environmentId: string, user: User) {
    const env = await this.prisma.environment.findFirst({
      where: { id: environmentId, project: { deletedAt: null } },
      select: {
        project: { select: { organizationId: true } },
        ...HIBERNATION_SELECT,
        ...LOCK_SELECT,
      },
    });
    if (!env) throw new NotFoundException('Environment not found');
    await this.authz.ensureCan(user, 'environments.update', env.project);
    return env;
  }
}
