import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Subscription } from 'rxjs';
import type { Namespace, Socket } from 'socket.io';
import { InboxEvents } from '../notifications/inbox.events';
import { UsersService } from '../users/users.service';
import { authenticateSocket, getSocketUser } from './ws.auth';
import {
  WS_EVENT_NOTIFICATION_CREATED,
  WS_NOTIFICATIONS_NAMESPACE,
  userRoom,
} from './ws.constants';

/**
 * Live delivery for the in-app inbox. Unlike `/deployments`, there is no
 * subscribe message: the only room a client may ever be in is its own user's,
 * and that is known during the handshake — so joining is automatic and there is
 * no client-supplied id to authorize.
 */
@WebSocketGateway({
  namespace: WS_NOTIFICATIONS_NAMESPACE,
  cors: { origin: true, credentials: true },
})
export class NotificationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationsGateway.name);
  private sub?: Subscription;

  @WebSocketServer() io!: Namespace;

  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly inbox: InboxEvents,
  ) {}

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      authenticateSocket(socket, this.jwt, this.users)
        .then(() => next())
        .catch((err: Error) => {
          this.logger.warn(`notifications auth failed: ${err.message}`);
          next(err);
        });
    });

    this.sub = this.inbox.created$.subscribe((event) => {
      this.io.to(userRoom(event.userId)).emit(WS_EVENT_NOTIFICATION_CREATED, {
        notification: event.notification,
        unreadCount: event.unreadCount,
      });
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  async handleConnection(client: Socket): Promise<void> {
    const user = getSocketUser(client);
    if (!user) {
      // Unreachable: the middleware would have rejected. Defensive only.
      client.disconnect(true);
      return;
    }
    await client.join(userRoom(user.id));
  }
}
