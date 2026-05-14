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
import { GithubApiService } from '../github/github-api.service';
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
    private readonly queue: QueueService,
    private readonly github: GithubApiService,
  ) {}

  async handle(
    rawBody: Buffer,
    headers: WebhookHeaders,
  ): Promise<{ ok: true; deduped?: boolean }> {
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
      await this.handlePush(project, body as GithubPushPayload);
    } else if (headers.event === 'pull_request') {
      await this.handlePullRequest(project, body as GithubPullRequestPayload);
    }

    return { ok: true };
  }

  private async handlePush(
    project: Project,
    payload: GithubPushPayload,
  ): Promise<void> {
    if (payload.ref !== `refs/heads/${project.defaultBranch}`) {
      this.logger.debug(
        `push ${payload.ref} ignored (default=${project.defaultBranch})`,
      );
      return;
    }

    const env = await this.prisma.environment.findFirst({
      where: { projectId: project.id, type: 'PRODUCTION', active: true },
    });
    if (!env) {
      this.logger.warn(`project ${project.id} has no active production env`);
      return;
    }

    await this.deployments.create(env.id, project.ownerId, {
      sha: payload.head_commit?.id,
      message: payload.head_commit?.message,
      author: payload.head_commit?.author?.name,
    });
  }

  private async handlePullRequest(
    project: Project,
    payload: GithubPullRequestPayload,
  ): Promise<void> {
    const prNumber = payload.pull_request.number;
    const headRef = payload.pull_request.head.ref;
    const headSha = payload.pull_request.head.sha;

    if (payload.action === 'closed') {
      const env = await this.prisma.environment.findFirst({
        where: { projectId: project.id, prNumber },
      });
      if (!env) return;
      await this.prisma.environment.update({
        where: { id: env.id },
        data: { active: false },
      });
      await this.queue.enqueueTeardown(env.id);
      return;
    }

    if (
      payload.action !== 'opened' &&
      payload.action !== 'reopened' &&
      payload.action !== 'synchronize'
    ) {
      return;
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

    const deployment = await this.deployments.create(env.id, project.ownerId, {
      sha: headSha,
    });

    if (
      (payload.action === 'opened' || payload.action === 'reopened') &&
      project.providerRepoFullName
    ) {
      void this.github.commentOnPR({
        ownerId: project.ownerId,
        repoFullName: project.providerRepoFullName,
        prNumber,
        body: `Preview deployed: ${deployment.url}`,
      });
    }
  }
}
