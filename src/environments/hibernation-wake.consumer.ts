import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import {
  canonicalEvent,
  NOTIFICATION_EVENTS,
} from '../notifications/notifications.constants';
import { OutboxEvents, type OutboxEvent } from '../outbox/outbox.events';
import { EnvironmentHibernationService } from './environment-hibernation.service';

/**
 * A successful deploy wakes the environment.
 *
 * The worker starts new containers and writes `deploy.succeeded` itself, so
 * there is no request in Nest to hang this off — the outbox drain is where the
 * fact arrives. Clearing `hibernatedAt` from here keeps the badge honest
 * instead of showing a sleeping environment whose containers are running.
 */
@Injectable()
export class HibernationWakeConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HibernationWakeConsumer.name);
  private sub?: Subscription;

  constructor(
    private readonly outbox: OutboxEvents,
    private readonly hibernation: EnvironmentHibernationService,
  ) {}

  onModuleInit(): void {
    this.sub = this.outbox.events$.subscribe((event) => {
      void this.handle(event).catch((err) =>
        this.logger.error('clearing hibernation after a deploy failed', err),
      );
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  private async handle(event: OutboxEvent): Promise<void> {
    // Through `canonicalEvent` rather than a literal: `event_outbox` carries
    // two naming schemes, and that map is where the repo settles which is which.
    if (canonicalEvent(event.type) !== NOTIFICATION_EVENTS.DeploySucceeded) {
      return;
    }
    const { deploymentId } = (event.payload ?? {}) as {
      deploymentId?: unknown;
    };
    if (typeof deploymentId !== 'string') return;
    await this.hibernation.clearForDeployment(deploymentId);
  }
}
