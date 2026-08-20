import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { OutboxEvents, type OutboxEvent } from '../outbox/outbox.events';
import { PrismaService } from '../prisma/prisma.service';
import { InboxService } from './inbox.service';
import {
  draftsFor,
  type DatabaseFacts,
  type DeploymentFacts,
  type LockFacts,
  type NotificationSubject,
} from './inbox.recipients';
import {
  canonicalEvent,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
} from './notifications.constants';

interface DeployPayload {
  deploymentId?: unknown;
  stage?: unknown;
  error?: unknown;
}

interface LockPayload {
  environmentId?: unknown;
  deploymentId?: unknown;
  lockedByUserId?: unknown;
  overriddenByUserId?: unknown;
  reason?: unknown;
  commitSha?: unknown;
  commitMessage?: unknown;
}

interface DatabasePayload {
  databaseId?: unknown;
  snapshotId?: unknown;
  error?: unknown;
  reason?: unknown;
}

/**
 * The in-app inbox: a second consumer of the same `event_outbox` the channels
 * read. It resolves the facts an event refers to, then hands them to the pure
 * `draftsFor` predicate — which is the only thing that decides whether anyone
 * is told. No drafts means no rows, never a fallback to org-wide fan-out.
 */
@Injectable()
export class InboxConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboxConsumer.name);
  private sub?: Subscription;

  constructor(
    private readonly outbox: OutboxEvents,
    private readonly prisma: PrismaService,
    private readonly inbox: InboxService,
  ) {}

  onModuleInit(): void {
    this.sub = this.outbox.events$.subscribe((e) => {
      void this.handle(e).catch((err) =>
        this.logger.error('inbox handling failed', err),
      );
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  private async handle(event: OutboxEvent): Promise<void> {
    const canonical = canonicalEvent(event.type);
    if (!canonical) return;

    const subject = await this.subjectFor(canonical, event);
    if (!subject) return;

    for (const draft of draftsFor(subject)) {
      await this.inbox.create(draft, `outbox:${event.id}`);
    }
  }

  private subjectFor(
    event: NotificationEvent,
    outboxEvent: OutboxEvent,
  ): Promise<NotificationSubject | null> {
    switch (event) {
      case NOTIFICATION_EVENTS.DeploySucceeded:
      case NOTIFICATION_EVENTS.DeployFailed:
      case NOTIFICATION_EVENTS.DeployCancelled:
        return this.deploymentSubject(event, outboxEvent.payload);
      case NOTIFICATION_EVENTS.DeploySkippedLocked:
      case NOTIFICATION_EVENTS.LockOverridden:
        return this.lockSubject(event, outboxEvent.payload);
      case NOTIFICATION_EVENTS.DatabaseProvisionFailed:
      case NOTIFICATION_EVENTS.SnapshotFailed:
        return this.databaseSubject(event, outboxEvent);
    }
  }

  private async deploymentSubject(
    event:
      | typeof NOTIFICATION_EVENTS.DeploySucceeded
      | typeof NOTIFICATION_EVENTS.DeployFailed
      | typeof NOTIFICATION_EVENTS.DeployCancelled,
    payload: unknown,
  ): Promise<NotificationSubject | null> {
    const body = (payload ?? {}) as DeployPayload;
    if (typeof body.deploymentId !== 'string') return null;

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: body.deploymentId },
      select: {
        id: true,
        triggeredByUserId: true,
        commitSha: true,
        commitMessage: true,
        errorSummary: true,
        environment: {
          select: {
            id: true,
            name: true,
            project: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!deployment) return null;

    const facts: DeploymentFacts = {
      deploymentId: deployment.id,
      triggeredByUserId: deployment.triggeredByUserId,
      projectId: deployment.environment.project.id,
      projectName: deployment.environment.project.name,
      environmentId: deployment.environment.id,
      environmentName: deployment.environment.name,
      commitSha: deployment.commitSha,
      commitMessage: deployment.commitMessage,
      failure: this.failureText(body) ?? deployment.errorSummary,
    };
    return { event, deployment: facts };
  }

  private async lockSubject(
    event:
      | typeof NOTIFICATION_EVENTS.DeploySkippedLocked
      | typeof NOTIFICATION_EVENTS.LockOverridden,
    payload: unknown,
  ): Promise<NotificationSubject | null> {
    const body = (payload ?? {}) as LockPayload;
    if (typeof body.environmentId !== 'string') return null;

    const environment = await this.prisma.environment.findUnique({
      where: { id: body.environmentId },
      select: {
        id: true,
        name: true,
        project: { select: { id: true, name: true } },
      },
    });
    if (!environment) return null;

    const overriddenByUserId =
      typeof body.overriddenByUserId === 'string'
        ? body.overriddenByUserId
        : null;

    const facts: LockFacts = {
      projectId: environment.project.id,
      projectName: environment.project.name,
      environmentId: environment.id,
      environmentName: environment.name,
      lockedByUserId:
        typeof body.lockedByUserId === 'string' ? body.lockedByUserId : null,
      overriddenByUserId,
      overriddenByName: await this.displayName(overriddenByUserId),
      reason: typeof body.reason === 'string' ? body.reason : null,
      commitSha: typeof body.commitSha === 'string' ? body.commitSha : null,
      commitMessage:
        typeof body.commitMessage === 'string' ? body.commitMessage : null,
      deploymentId:
        typeof body.deploymentId === 'string' ? body.deploymentId : null,
    };
    return { event, lock: facts };
  }

  /**
   * A managed database has no user column of its own, so the recipient is the
   * actor the outbox row names, falling back to the project's owner — the only
   * other person the schema can say the database belongs to.
   */
  private async databaseSubject(
    event:
      | typeof NOTIFICATION_EVENTS.DatabaseProvisionFailed
      | typeof NOTIFICATION_EVENTS.SnapshotFailed,
    outboxEvent: OutboxEvent,
  ): Promise<NotificationSubject | null> {
    const body = (outboxEvent.payload ?? {}) as DatabasePayload;
    const databaseId = await this.databaseIdFor(body);
    if (!databaseId) return null;

    const database = await this.prisma.managedDatabase.findUnique({
      where: { id: databaseId },
      select: {
        id: true,
        name: true,
        errorSummary: true,
        environment: {
          select: {
            id: true,
            name: true,
            project: {
              select: { id: true, name: true, createdByUserId: true },
            },
          },
        },
      },
    });
    if (!database) return null;

    const project = database.environment.project;
    const facts: DatabaseFacts = {
      databaseId: database.id,
      databaseName: database.name,
      ownerUserId: outboxEvent.userId ?? project.createdByUserId,
      projectId: project.id,
      projectName: project.name,
      environmentId: database.environment.id,
      environmentName: database.environment.name,
      failure: database.errorSummary ?? this.failureText(body),
    };
    return { event, database: facts };
  }

  // The worker keys these events on `databaseId`; the Nest reaper emits a
  // snapshot failure keyed on `snapshotId` alone, so both are accepted.
  private async databaseIdFor(body: DatabasePayload): Promise<string | null> {
    if (typeof body.databaseId === 'string') return body.databaseId;
    if (typeof body.snapshotId !== 'string') return null;
    const snapshot = await this.prisma.databaseSnapshot.findUnique({
      where: { id: body.snapshotId },
      select: { databaseId: true },
    });
    return snapshot?.databaseId ?? null;
  }

  private async displayName(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, username: true },
    });
    return user?.displayName ?? user?.username ?? null;
  }

  private failureText(body: {
    stage?: unknown;
    error?: unknown;
  }): string | null {
    const stage = typeof body.stage === 'string' ? body.stage : null;
    const error = typeof body.error === 'string' ? body.error : null;
    if (!stage && !error) return null;
    return [stage && `stage ${stage}`, error].filter(Boolean).join(': ');
  }
}
