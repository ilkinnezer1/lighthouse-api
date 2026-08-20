import type { Notification } from '@prisma/client';
import type { InboxContext } from './inbox.recipients';
import type { NotificationEvent } from './notifications.constants';

/** The one notification shape: feed item, mark-read subject and socket push. */
export interface NotificationView {
  id: string;
  kind: NotificationEvent;
  title: string;
  body: string | null;
  link: string | null;
  context: InboxContext | null;
  readAt: string | null;
  createdAt: string;
}

export function toNotificationView(row: Notification): NotificationView {
  return {
    id: row.id,
    kind: row.kind as NotificationEvent,
    title: row.title,
    body: row.body,
    link: row.link,
    context: (row.context ?? null) as InboxContext | null,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
