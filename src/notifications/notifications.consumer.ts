import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DeliveryStatus } from '@prisma/client';
import type { Subscription } from 'rxjs';
import { OutboxEvents, type OutboxEvent } from '../outbox/outbox.events';
import { PrismaService } from '../prisma/prisma.service';
import {
  canonicalEvent,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
} from './notifications.constants';
import type { NotificationContext } from './notifications.dispatcher';
import { NotificationsService } from './notifications.service';

const RETRY_SWEEP_MS = 30_000;
const RETRY_BATCH = 20;

interface DeployPayload {
  deploymentId?: unknown;
  stage?: unknown;
  error?: unknown;
  url?: unknown;
}

@Injectable()
export class NotificationsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsConsumer.name);
  private sub?: Subscription;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly outbox: OutboxEvents,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.sub = this.outbox.events$.subscribe((e) => {
      void this.handle(e).catch((err) =>
        this.logger.error('notification handling failed', err),
      );
    });
    this.scheduleSweep();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.sub?.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
  }

  private async handle(event: OutboxEvent): Promise<void> {
    const canonical = canonicalEvent(event.type);
    if (!canonical) return;

    const resolved = await this.resolve(canonical, event.payload);
    if (!resolved) return;

    const channels = await this.notifications.channelsFor(
      resolved.orgId,
      canonical,
    );
    for (const channel of channels) {
      await this.notifications.deliver(channel, event.id, resolved.ctx);
    }
  }

  /**
   * Turns a thin outbox payload into something worth reading. The worker sends
   * only ids (`{deploymentId, stage, error}`), so project, environment and
   * commit come from a lookup — which is also how the owning org is found.
   */
  private async resolve(
    event: NotificationEvent,
    payload: unknown,
  ): Promise<{ orgId: string; ctx: NotificationContext } | null> {
    const body = (payload ?? {}) as DeployPayload;
    if (typeof body.deploymentId !== 'string') return null;

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: body.deploymentId },
      select: {
        commitSha: true,
        commitMessage: true,
        environment: {
          select: {
            name: true,
            project: {
              select: { name: true, organizationId: true },
            },
          },
        },
      },
    });
    if (!deployment) return null;

    const project = deployment.environment.project;
    const ok = event === NOTIFICATION_EVENTS.DeploySucceeded;
    const commit = deployment.commitSha
      ? `${deployment.commitSha.slice(0, 7)}${
          deployment.commitMessage ? ` ${deployment.commitMessage}` : ''
        }`
      : null;

    return {
      orgId: project.organizationId,
      ctx: {
        event,
        title: `${this.verb(event)} — ${project.name} / ${deployment.environment.name}`,
        project: project.name,
        environment: deployment.environment.name,
        commit,
        url: typeof body.url === 'string' ? body.url : null,
        error: this.errorText(body),
        ok,
      },
    };
  }

  private errorText(body: DeployPayload): string | null {
    const stage = typeof body.stage === 'string' ? body.stage : null;
    const error = typeof body.error === 'string' ? body.error : null;
    if (!stage && !error) return null;
    return [stage && `stage ${stage}`, error].filter(Boolean).join(': ');
  }

  private verb(event: NotificationEvent): string {
    switch (event) {
      case NOTIFICATION_EVENTS.DeploySucceeded:
        return 'Deploy succeeded';
      case NOTIFICATION_EVENTS.DeployFailed:
        return 'Deploy failed';
      case NOTIFICATION_EVENTS.DeployCancelled:
        return 'Deploy cancelled';
      case NOTIFICATION_EVENTS.DatabaseProvisionFailed:
        return 'Database provisioning failed';
      case NOTIFICATION_EVENTS.SnapshotFailed:
        return 'Snapshot failed';
    }
  }

  private scheduleSweep(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sweep()
        .catch((err) => this.logger.error('retry sweep failed', err))
        .finally(() => this.scheduleSweep());
    }, RETRY_SWEEP_MS);
  }

  /**
   * Retries deliveries whose backoff has elapsed. This is the only reason a
   * transient Slack outage doesn't silently drop a notification — the outbox
   * itself cannot replay, since its drain marks rows globally.
   */
  private async sweep(): Promise<void> {
    const due = await this.prisma.notificationDelivery.findMany({
      where: {
        status: DeliveryStatus.FAILED,
        nextAttemptAt: { lte: new Date() },
      },
      take: RETRY_BATCH,
      include: { channel: true },
    });
    if (due.length === 0) return;

    for (const delivery of due) {
      if (!delivery.channel.enabled) continue;
      const ctx = await this.rebuild(delivery.event, delivery.eventId);
      if (!ctx) continue;
      await this.notifications.attempt(
        delivery.id,
        delivery.channel,
        ctx,
        delivery.attempts,
      );
    }
  }

  /** Re-derives the message for a retry from the still-present outbox row. */
  private async rebuild(
    event: string,
    eventId: string,
  ): Promise<NotificationContext | null> {
    const rows = await this.prisma.$queryRaw<{ payload: unknown }[]>`
      SELECT payload FROM event_outbox WHERE id = ${BigInt(eventId)}
    `;
    if (rows.length === 0) return null;
    const resolved = await this.resolve(
      event as NotificationEvent,
      rows[0].payload,
    );
    return resolved?.ctx ?? null;
  }
}
