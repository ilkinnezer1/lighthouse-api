import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InboxEvents } from './inbox.events';
import type { NotificationDraft } from './inbox.recipients';
import { toNotificationView, type NotificationView } from './inbox.view';

const DEFAULT_LIMIT = 20;

export interface NotificationFeed {
  items: NotificationView[];
  nextCursor: string | null;
  unreadCount: number;
}

/**
 * Every query here is scoped by `userId` rather than gated with `ensureCan`:
 * a notification is addressed to exactly one person, so ownership *is* the
 * authorization, and scoping the query — instead of checking then acting —
 * leaves no window in which someone else's row could be touched.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: InboxEvents,
  ) {}

  /**
   * Writes one addressed notification and pushes it live. `dedupeKey` is what
   * makes the outbox's at-least-once redelivery safe: the second attempt hits
   * the unique index and stops, rather than producing a duplicate row.
   */
  async create(draft: NotificationDraft, dedupeKey: string): Promise<void> {
    let row;
    try {
      row = await this.prisma.notification.create({
        data: {
          userId: draft.userId,
          kind: draft.kind,
          title: draft.title,
          body: draft.body,
          link: draft.link,
          context: draft.context as Prisma.InputJsonValue,
          dedupeKey,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return;
      }
      throw err;
    }

    const unreadCount = await this.unreadCount(draft.userId);
    this.events.created$.next({
      userId: draft.userId,
      notification: toNotificationView(row),
      unreadCount,
    });
  }

  async list(
    userId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<NotificationFeed> {
    const limit = opts.limit ?? DEFAULT_LIMIT;

    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(
      toNotificationView,
    );

    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
      unreadCount: await this.unreadCount(userId),
    };
  }

  async markRead(userId: string, id: string): Promise<number> {
    const marked = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (marked.count === 0) {
      const exists = await this.prisma.notification.findFirst({
        where: { id, userId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Notification not found');
    }

    return this.unreadCount(userId);
  }

  async markAllRead(userId: string): Promise<number> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return this.unreadCount(userId);
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }
}
