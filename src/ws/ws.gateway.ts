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
import type { Server, Socket } from 'socket.io';
import { ensureCan } from '../common/authz';
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

  @WebSocketServer() io!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxEvents,
    private readonly config: ConfigService<Env, true>,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  // ─── lifecycle ──────────────────────────────────────────────────

  afterInit(): void {
    this.outboxSub = this.outbox.events$.subscribe((e) => this.relayOutbox(e));
  }

  async onModuleDestroy(): Promise<void> {
    this.outboxSub?.unsubscribe();
    await Promise.all([...this.tailers.values()].map((t) => t.stop()));
    this.tailers.clear();
  }

  // ─── connection ─────────────────────────────────────────────────

  async handleConnection(client: Socket): Promise<void> {
    try {
      const user = await authenticateSocket(client, this.jwt, this.users);
      client.data.user = user;
      await client.join(userRoom(user.id));
    } catch (err) {
      this.logger.warn(`auth failed: ${(err as Error).message}`);
      client.disconnect(true);
    }
  }

  async handleDisconnect(): Promise<void> {
    await this.gcEmptyTailers();
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

    const user = client.data.user as SocketUser | undefined;
    if (!user) return { ok: false, error: 'unauthenticated' };

    const project = await this.loadProject(deploymentId);
    if (!project) return { ok: false, error: 'not found' };
    try {
      ensureCan(user, 'deployments.read', project);
    } catch {
      return { ok: false, error: 'forbidden' };
    }

    const room = deploymentRoom(deploymentId);
    await client.join(room);
    this.ensureTailer(deploymentId);
    void this.replayHistory(client, deploymentId);
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
          select: { project: { select: { ownerId: true, deletedAt: true } } },
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
    const ns = this.io.of('/deployments');
    for (const [id, tailer] of this.tailers) {
      const size = ns.adapter.rooms.get(deploymentRoom(id))?.size ?? 0;
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
