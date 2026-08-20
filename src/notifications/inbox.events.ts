import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { NotificationView } from './inbox.view';

export interface NotificationCreated {
  userId: string;
  notification: NotificationView;
  unreadCount: number;
}

/**
 * In-process hand-off from the inbox writer to the `/notifications` gateway,
 * mirroring how OutboxEvents feeds the `/deployments` one. Keeps the gateway
 * out of the write path and the service ignorant of sockets.
 */
@Injectable()
export class InboxEvents {
  readonly created$ = new Subject<NotificationCreated>();
}
