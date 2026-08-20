import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Project } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { DeploymentsService } from '../deployments/deployments.service';
import { EnvironmentLocksService } from '../environments/environment-locks.service';
import type { EnvironmentLock } from '../environments/environment-lock';
import { GithubApiService } from '../github/github-api.service';
import { OUTBOX_EVENT_TYPES } from '../outbox/outbox.constants';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { verifyGithubSignature } from './signature';
import type {
  GithubPullRequestPayload,
  GithubPushPayload,
} from './payload.types';

const PROVIDER = 'github';

export interface WebhookHeaders {
  signature: string | undefined;
  event: string | undefined;
  delivery: string | undefined;
}

@Injectable()
export class GithubWebhookService {
  private readonly logger = new Logger(GithubWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly deployments: DeploymentsService,
    private readonly locks: EnvironmentLocksService,
    private readonly queue: QueueService,
    private readonly github: GithubApiService,
  ) {}

  async handle(
    rawBody: Buffer,
    headers: WebhookHeaders,
  ): Promise<{ ok: true; deduped?: boolean; skipped?: 'environment_locked' }> {
    if (!headers.event || !headers.delivery) {
      throw new UnauthorizedException('missing webhook headers');
    }

    const body = JSON.parse(rawBody.toString('utf8')) as {
      repository?: { full_name?: string };
    };
    const fullName = body.repository?.full_name;
    if (!fullName) {
      throw new UnauthorizedException('missing repository.full_name');
    }

    const project = await this.prisma.project.findFirst({
      where: { providerRepoFullName: fullName, deletedAt: null },
    });
    if (!project || !project.webhookSecretEnc) {
      throw new NotFoundException('no project for repository');
    }

    const secret = this.crypto.decrypt(project.webhookSecretEnc);
    if (!verifyGithubSignature(rawBody, headers.signature, secret)) {
      throw new UnauthorizedException('invalid signature');
    }

    try {
      await this.prisma.webhookDelivery.create({
        data: {
          provider: PROVIDER,
          deliveryId: headers.delivery,
          eventType: headers.event,
          projectId: project.id,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return { ok: true, deduped: true };
      }
      throw err;
    }

    if (headers.event === 'push') {
      if (await this.handlePush(project, body as GithubPushPayload)) {
        return { ok: true, skipped: 'environment_locked' };
      }
    } else if (headers.event === 'pull_request') {
      if (
        await this.handlePullRequest(project, body as GithubPullRequestPayload)
      ) {
        return { ok: true, skipped: 'environment_locked' };
      }
    }

    return { ok: true };
  }

  /** Resolves true when a live environment lock stopped the deploy. */
  private async handlePush(
    project: Project,
    payload: GithubPushPayload,
  ): Promise<boolean> {
    if (payload.ref !== `refs/heads/${project.defaultBranch}`) {
      this.logger.debug(
        `push ${payload.ref} ignored (default=${project.defaultBranch})`,
      );
      return false;
    }

    const env = await this.prisma.environment.findFirst({
      where: { projectId: project.id, type: 'PRODUCTION', active: true },
    });
    if (!env) {
      this.logger.warn(`project ${project.id} has no active production env`);
      return false;
    }

    const commit = {
      sha: payload.head_commit?.id,
      message: payload.head_commit?.message,
      author: payload.head_commit?.author?.name,
    };

    const lock = await this.locks.liveLock(env.id);
    if (lock) {
      await this.skipLockedDeploy(env.id, lock, commit);
      return true;
    }

    await this.deployments.create(env.id, project.createdByUserId, { commit });
    return false;
  }

  private async handlePullRequest(
    project: Project,
    payload: GithubPullRequestPayload,
  ): Promise<boolean> {
    const prNumber = payload.pull_request.number;
    const headRef = payload.pull_request.head.ref;
    const headSha = payload.pull_request.head.sha;

    if (payload.action === 'closed') {
      const env = await this.prisma.environment.findFirst({
        where: { projectId: project.id, prNumber },
      });
      if (!env) return false;
      await this.prisma.environment.update({
        where: { id: env.id },
        data: { active: false },
      });
      await this.queue.enqueueTeardown(env.id);
      return false;
    }

    if (
      payload.action !== 'opened' &&
      payload.action !== 'reopened' &&
      payload.action !== 'synchronize'
    ) {
      return false;
    }

    const env = await this.prisma.environment.upsert({
      where: {
        projectId_name: {
          projectId: project.id,
          name: `preview-pr-${prNumber}`,
        },
      },
      create: {
        projectId: project.id,
        name: `preview-pr-${prNumber}`,
        type: 'PREVIEW',
        branch: headRef,
        subdomain: `pr-${prNumber}`,
        prNumber,
        active: true,
      },
      update: { branch: headRef, active: true },
    });

    const lock = await this.locks.liveLock(env.id);
    if (lock) {
      await this.skipLockedDeploy(env.id, lock, { sha: headSha });
      return true;
    }

    const deployment = await this.deployments.create(
      env.id,
      project.createdByUserId,
      { commit: { sha: headSha } },
    );

    if (
      (payload.action === 'opened' || payload.action === 'reopened') &&
      project.providerRepoFullName
    ) {
      void this.github
        .commentOnPR({
          ownerId: project.createdByUserId,
          repoFullName: project.providerRepoFullName,
          prNumber,
          body: `Preview deployed: ${deployment.url}`,
        })
        .catch((err: Error) => {
          this.logger.warn(
            `PR comment for project ${project.id} failed: ${err.message}`,
          );
        });
    }

    return false;
  }

  /**
   * A locked environment skips an automatic deploy rather than overriding it —
   * a push is nobody's decision to make. The outbox row is what stops the skip
   * being invisible: somebody locking production and going home would otherwise
   * silently stop shipping, with a log line as the only trace.
   */
  private async skipLockedDeploy(
    environmentId: string,
    lock: EnvironmentLock,
    commit: { sha?: string; message?: string },
  ): Promise<void> {
    this.logger.warn(
      `deploy for environment ${environmentId} skipped: locked by ${lock.lockedBy.username} until ${lock.expiresAt}`,
    );
    await this.prisma.eventOutbox.create({
      data: {
        type: OUTBOX_EVENT_TYPES.DeploymentSkippedLocked,
        userId: lock.lockedBy.id,
        payload: {
          environmentId,
          lockedByUserId: lock.lockedBy.id,
          expiresAt: lock.expiresAt,
          reason: lock.reason,
          commitSha: commit.sha ?? null,
          commitMessage: commit.message ?? null,
        },
      },
    });
  }
}
