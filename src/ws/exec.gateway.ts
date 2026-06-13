import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { WebSocket } from 'ws';
import { ensureCan } from '../common/authz';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { authenticateSocket, getSocketUser } from './ws.auth';
import {
  WS_EXEC_ERROR,
  WS_EXEC_EXIT,
  WS_EXEC_INPUT,
  WS_EXEC_NAMESPACE,
  WS_EXEC_OUTPUT,
  WS_EXEC_READY,
  WS_EXEC_RESIZE,
  WS_EXEC_START,
  WS_EXEC_STOP,
} from './ws.constants';

// Deployment states with a live container worth attaching a shell to.
const EXECABLE_STATUSES = new Set(['RUNNING', 'SUCCEEDED']);

type StartPayload = {
  deploymentId?: unknown;
  service?: unknown;
  cols?: unknown;
  rows?: unknown;
};
type Ack = { ok: true } | { ok: false; error: string };

// One shell session per socket: the worker-side WebSocket carrying raw pty bytes.
interface ExecSession {
  worker: WebSocket;
  exited: boolean;
}

// ExecGateway bridges a browser terminal (socket.io, `/exec` namespace) to the
// worker's `docker exec` WebSocket. The browser leg reuses the session-cookie
// auth used everywhere else; the worker leg is a raw WS on the internal network.
// Framing: pty bytes travel as binary frames both ways; resize is a JSON text
// frame to the worker; lifecycle is surfaced to the browser as discrete events.
@WebSocketGateway({
  namespace: WS_EXEC_NAMESPACE,
  cors: { origin: true, credentials: true },
})
export class ExecGateway
  implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy
{
  private readonly logger = new Logger(ExecGateway.name);
  private readonly sessions = new Map<string, ExecSession>();

  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  afterInit(namespace: Namespace): void {
    // Authenticate during the handshake so `exec:start` can trust client.data.user.
    namespace.use((socket, next) => {
      authenticateSocket(socket, this.jwt, this.users)
        .then(() => next())
        .catch((err: Error) => {
          this.logger.warn(`exec auth failed: ${err.message}`);
          next(err);
        });
    });
  }

  handleConnection(client: Socket): void {
    if (!getSocketUser(client)) client.disconnect(true);
  }

  // No handleDisconnect interface — Socket.IO still invokes it if present.
  handleDisconnect(client: Socket): void {
    this.closeSession(client.id);
  }

  onModuleDestroy(): void {
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
  }

  @SubscribeMessage(WS_EXEC_START)
  async onStart(client: Socket, payload: StartPayload): Promise<Ack> {
    const deploymentId =
      typeof payload?.deploymentId === 'string' ? payload.deploymentId : null;
    if (!deploymentId) return { ok: false, error: 'deploymentId required' };
    const service =
      typeof payload?.service === 'string' && payload.service
        ? payload.service
        : null;

    const user = getSocketUser(client);
    if (!user) return { ok: false, error: 'unauthenticated' };

    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        status: true,
        environment: {
          select: { project: { select: { ownerId: true, deletedAt: true } } },
        },
        services: { select: { name: true, isWeb: true, containerId: true } },
      },
    });
    if (!dep || dep.environment.project.deletedAt) {
      return { ok: false, error: 'not found' };
    }
    try {
      ensureCan(user, 'deployments.exec', dep.environment.project);
    } catch {
      return { ok: false, error: 'forbidden' };
    }
    if (!EXECABLE_STATUSES.has(dep.status)) {
      return { ok: false, error: 'deployment has no running container' };
    }

    const target = service
      ? dep.services.find((s) => s.name === service)
      : dep.services.find((s) => s.isWeb);
    if (!target?.containerId) {
      return { ok: false, error: 'no running container for this service' };
    }

    // One shell per socket: replace any prior session.
    this.closeSession(client.id);

    const cols = clampDim(payload?.cols, 80);
    const rows = clampDim(payload?.rows, 24);
    const url = this.workerExecUrl(deploymentId, target.name, cols, rows);

    const worker = new WebSocket(url);
    const session: ExecSession = { worker, exited: false };
    this.sessions.set(client.id, session);

    worker.on('open', () => client.emit(WS_EXEC_READY));

    worker.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        client.emit(WS_EXEC_OUTPUT, data);
        return;
      }
      // The only text frame the worker sends is the exit notice.
      try {
        const msg = JSON.parse(data.toString('utf8')) as {
          type?: string;
          code?: number;
        };
        if (msg.type === 'exit') {
          session.exited = true;
          client.emit(WS_EXEC_EXIT, { code: msg.code ?? -1 });
        }
      } catch {
        // Non-JSON text frame — ignore.
      }
    });

    worker.on('unexpected-response', (_req, res) => {
      client.emit(WS_EXEC_ERROR, {
        error:
          res.statusCode === 404
            ? 'container is no longer running'
            : `worker rejected exec (${res.statusCode})`,
      });
      this.closeSession(client.id);
    });

    worker.on('error', (err: Error) => {
      this.logger.warn(`exec worker socket error: ${err.message}`);
      client.emit(WS_EXEC_ERROR, { error: 'worker connection failed' });
      this.closeSession(client.id);
    });

    worker.on('close', () => {
      if (!session.exited) client.emit(WS_EXEC_EXIT, { code: -1 });
      this.sessions.delete(client.id);
    });

    return { ok: true };
  }

  @SubscribeMessage(WS_EXEC_INPUT)
  onInput(client: Socket, data: unknown): void {
    const worker = this.openWorker(client.id);
    if (worker) worker.send(toBuffer(data), { binary: true });
  }

  @SubscribeMessage(WS_EXEC_RESIZE)
  onResize(client: Socket, payload: { cols?: unknown; rows?: unknown }): void {
    const worker = this.openWorker(client.id);
    if (!worker) return;
    const cols = clampDim(payload?.cols, 80);
    const rows = clampDim(payload?.rows, 24);
    worker.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  @SubscribeMessage(WS_EXEC_STOP)
  onStop(client: Socket): void {
    this.closeSession(client.id);
  }

  // ─── helpers ────────────────────────────────────────────────────

  // Returns the session's worker socket only when it's ready to send.
  private openWorker(socketId: string): WebSocket | null {
    const worker = this.sessions.get(socketId)?.worker;
    return worker && worker.readyState === WebSocket.OPEN ? worker : null;
  }

  private closeSession(socketId: string): void {
    const session = this.sessions.get(socketId);
    if (!session) return;
    this.sessions.delete(socketId);
    try {
      session.worker.removeAllListeners();
      session.worker.close();
    } catch {
      // already closing
    }
  }

  private workerExecUrl(
    deploymentId: string,
    service: string,
    cols: number,
    rows: number,
  ): string {
    const http = this.config.get('WORKER_HTTP_URL', { infer: true });
    const base = http.replace(/^http/, 'ws');
    const params = new URLSearchParams({
      cols: String(cols),
      rows: String(rows),
    });
    return `${base}/deployments/${deploymentId}/services/${encodeURIComponent(service)}/exec?${params.toString()}`;
  }
}

// Clamp a terminal dimension to a sane range, defaulting when absent/invalid.
function clampDim(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 1000);
}

// Normalize a socket.io input payload (string | Buffer | ArrayBuffer | view)
// into a Buffer of raw terminal bytes.
function toBuffer(data: unknown): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.alloc(0);
}
