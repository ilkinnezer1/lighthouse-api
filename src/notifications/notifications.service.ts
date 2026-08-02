import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel } from '@prisma/client';
import { DeliveryStatus } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  MAX_DELIVERY_ATTEMPTS,
  RETRY_BACKOFF_MS,
  type NotificationEvent,
} from './notifications.constants';
import {
  NotificationDispatcher,
  type ChannelConfig,
  type NotificationContext,
} from './notifications.dispatcher';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  config(channel: NotificationChannel): ChannelConfig {
    return JSON.parse(this.crypto.decrypt(channel.configEnc)) as ChannelConfig;
  }

  encryptConfig(config: ChannelConfig): string {
    return this.crypto.encrypt(JSON.stringify(config));
  }

  /**
   * Records the intent to notify, then sends. The delivery row is written first
   * and its unique (eventId, channelId) is what makes the outbox's at-least-once
   * redelivery safe: a duplicate event finds the row already there and stops.
   */
  async deliver(
    channel: NotificationChannel,
    eventId: string,
    ctx: NotificationContext,
  ): Promise<void> {
    let deliveryId: string;
    try {
      const row = await this.prisma.notificationDelivery.create({
        data: { channelId: channel.id, eventId, event: ctx.event },
        select: { id: true },
      });
      deliveryId = row.id;
    } catch {
      // Unique violation — this event was already handled for this channel.
      return;
    }
    await this.attempt(deliveryId, channel, ctx, 0);
  }

  /** One send attempt, recording success or scheduling the next retry. */
  async attempt(
    deliveryId: string,
    channel: NotificationChannel,
    ctx: NotificationContext,
    priorAttempts: number,
  ): Promise<void> {
    const attempts = priorAttempts + 1;
    try {
      await this.dispatcher.send(channel.kind, this.config(channel), ctx);
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          status: DeliveryStatus.SENT,
          attempts,
          sentAt: new Date(),
          lastError: null,
          nextAttemptAt: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          status: exhausted ? DeliveryStatus.DEAD : DeliveryStatus.FAILED,
          attempts,
          lastError: message.slice(0, 500),
          nextAttemptAt: exhausted
            ? null
            : new Date(Date.now() + RETRY_BACKOFF_MS[attempts - 1]),
        },
      });
      this.logger.warn(
        `notification ${ctx.event} to ${channel.name} failed (attempt ${attempts}): ${message}`,
      );
    }
  }

  /** Sends a sample message so a misconfigured URL surfaces at setup time. */
  async sendTest(channel: NotificationChannel): Promise<void> {
    await this.dispatcher.send(channel.kind, this.config(channel), {
      event: 'deploy.succeeded',
      title: `Test notification from Lighthouse — ${channel.name}`,
      project: 'lighthouse',
      environment: 'production',
      commit: null,
      url: null,
      error: null,
      ok: true,
    });
  }

  /** Channels in an org that want this event. Empty `events` means all. */
  async channelsFor(
    orgId: string,
    event: NotificationEvent,
  ): Promise<NotificationChannel[]> {
    const channels = await this.prisma.notificationChannel.findMany({
      where: { orgId, enabled: true },
    });
    return channels.filter(
      (c) => c.events.length === 0 || c.events.includes(event),
    );
  }
}
