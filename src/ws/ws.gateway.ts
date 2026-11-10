import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Redis } from 'ioredis';
import type { Subscription } from 'rxjs';
import type { Namespace, Socket } from 'socket.io';
import { AuthzService } from '../authz/authz.service';
import type { Env } from '../config/env';
import { OutboxEvents, type OutboxEvent } from '../outbox/outbox.events';
import { PrismaService } from '../prisma/prisma.service';
import { InjectRedis } from '../redis/redis.constants';
import { UsersService } from '../users/users.service';
import { toLogEntry } from './log-entry';
import { LogTailer } from './log-tailer';
import { authenticateSocket, getSocketUser } from './ws.auth';
import {
  WS_EVENT_LOG,
  WS_EVENT_SUBSCRIBE,
  WS_EVENT_UNSUBSCRIBE,
  deploymentRoom,
  logsStreamKey,
  userRoom,
} from './ws.constants';

type SubscribeAck = { ok: true; room: string } | { ok: false; error: string };

@WebSocketGateway({
  namespace: '/deployments',
  cors: { origin: true, credentials: true },
})
export class WsGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  private readonly logger = new Logger(WsGateway.name);
  private readonly tailers = new Map<string, LogTailer>();
  private outboxSub?: Subscription;

  // Namespaced gateway: this is the `/deployments` Namespace, not the root Server.
  @WebSocketServer() io!: Namespace;

  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxEvents,
    private readonly config: ConfigService<Env, true>,
    private readonly authz: AuthzService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  // ─── lifecycle ──────────────────────────────────────────────────

  afterInit(namespace: Namespace): void {
    // Auth as Socket.IO middleware so it completes BEFORE the client
    // sees `connect` and starts emitting messages. handleConnection
    // can then assume client.data.user is populated.
    namespace.use((socket, next) => {
      authenticateSocket(socket, this.jwt, this.users)
        .then(() => next())
        .catch((err: Error) => {
          this.logger.warn(`auth failed: ${err.message}`);
          next(err);
        });
    });

    this.outboxSub = this.outbox.events$.subscribe((e) => this.relayOutbox(e));
  }

  async onModuleDestroy(): Promise<void> {
    this.outboxSub?.unsubscribe();
    await Promise.all([...this.tailers.values()].map((t) => t.stop()));
    this.tailers.clear();
  }

  // ─── connection ─────────────────────────────────────────────────

  async handleConnection(client: Socket): Promise<void> {
    const user = getSocketUser(client);
    if (!user) {
      // Should be unreachable: middleware would have rejected. Defensive only.
      client.disconnect(true);
      return;
    }
    await client.join(userRoom(user.id));
  }

  async handleDisconnect(): Promise<void> {
    try {
      await this.gcEmptyTailers();
    } catch (err) {
      this.logger.error('tailer cleanup failed', err);
    }
  }

  // ─── subscribe / unsubscribe ────────────────────────────────────

  @SubscribeMessage(WS_EVENT_SUBSCRIBE)
  async onSubscribe(
    client: Socket,
    payload: { deploymentId?: unknown },
  ): Promise<SubscribeAck> {
    const deploymentId =
      typeof payload?.deploymentId === 'string' ? payload.deploymentId : null;
    if (!deploymentId) return { ok: false, error: 'deploymentId required' };

    const user = getSocketUser(client);
    if (!user) return { ok: false, error: 'unauthenticated' };

    const project = await this.loadProject(deploymentId);
    if (!project) return { ok: false, error: 'not found' };
    try {
      await this.authz.ensureCan(user, 'deployments.read', project);
    } catch {
      return { ok: false, error: 'forbidden' };
    }

    const room = deploymentRoom(deploymentId);
    await client.join(room);
    this.ensureTailer(deploymentId);
    void this.replayHistory(client, deploymentId).catch((err: Error) => {
      this.logger.error(
        `log replay for ${deploymentId} failed: ${err.message}`,
      );
    });
    return { ok: true, room };
  }

  @SubscribeMessage(WS_EVENT_UNSUBSCRIBE)
  async onUnsubscribe(
    client: Socket,
    payload: { deploymentId?: unknown },
  ): Promise<{ ok: true }> {
    if (typeof payload?.deploymentId === 'string') {
      await client.leave(deploymentRoom(payload.deploymentId));
      await this.gcEmptyTailers();
    }
    return { ok: true };
  }

  // ─── helpers ────────────────────────────────────────────────────

  private async loadProject(deploymentId: string) {
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        environment: {
          select: {
            project: { select: { organizationId: true, deletedAt: true } },
          },
        },
      },
    });
    if (!dep || dep.environment.project.deletedAt) return null;
    return dep.environment.project;
  }

  private ensureTailer(deploymentId: string): void {
    if (this.tailers.has(deploymentId)) return;
    const room = deploymentRoom(deploymentId);
    const tailer = new LogTailer(
      deploymentId,
      this.config.get('REDIS_URL', { infer: true }),
      (entry) => this.io.to(room).emit(WS_EVENT_LOG, entry),
    );
    tailer.start();
    this.tailers.set(deploymentId, tailer);
  }

  private async replayHistory(
    client: Socket,
    deploymentId: string,
  ): Promise<void> {
    const entries = await this.redis.xrange(
      logsStreamKey(deploymentId),
      '-',
      '+',
    );
    for (const [id, fields] of entries) {
      client.emit(WS_EVENT_LOG, toLogEntry(id, fields));
    }
  }

  private async gcEmptyTailers(): Promise<void> {
    for (const [id, tailer] of this.tailers) {
      const size = this.io.adapter.rooms.get(deploymentRoom(id))?.size ?? 0;
      if (size === 0) {
        await tailer.stop();
        this.tailers.delete(id);
      }
    }
  }

  private relayOutbox(event: OutboxEvent): void {
    const payload = event.payload as { deploymentId?: unknown } | null;
    const depId =
      typeof payload?.deploymentId === 'string' ? payload.deploymentId : null;
    const body = { id: event.id, payload: event.payload };
    if (depId) this.io.to(deploymentRoom(depId)).emit(event.type, body);
    if (event.userId) this.io.to(userRoom(event.userId)).emit(event.type, body);
  }
}
