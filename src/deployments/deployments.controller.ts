import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ensureCan } from '../common/authz';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import {
  MaintenanceActionsSchema,
  type MaintenanceAction,
} from '../projects/dto/build-config.schema';
import { DeploymentsService } from './deployments.service';
import { CreateDeploymentDto } from './dto/create-deployment.dto';
import { ListDeploymentsDto } from './dto/list-deployments.dto';
import { FRAMEWORK_PRESETS } from './maintenance-presets';

type DeploymentDetail = NonNullable<
  Awaited<ReturnType<DeploymentsService['findById']>>
>;

@Controller()
@UseGuards(JwtAuthGuard)
export class DeploymentsController {
  constructor(
    private readonly deployments: DeploymentsService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post('environments/:envId/deployments')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('deployments.create')
  async create(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @Body() dto: CreateDeploymentDto,
    @CurrentUser() user: User,
  ) {
    const env = await this.prisma.environment.findUnique({
      where: { id: envId },
      include: { project: true },
    });

    if (!env || env.project.deletedAt) {
      throw new NotFoundException('Environment not found');
    }

    ensureCan(user, 'deployments.create', env.project);

    return this.deployments.create(envId, user.id, {
      sourceBranch: dto.sourceBranch,
      mergeBranches: dto.mergeBranches,
    });
  }

  @Get('environments/:envId/deployments')
  async list(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @CurrentUser() user: User,
  ) {
    const env = await this.prisma.environment.findUnique({
      where: { id: envId },
      include: { project: true },
    });
    if (!env || env.project.deletedAt) {
      throw new NotFoundException('Environment not found');
    }
    ensureCan(user, 'deployments.read', env.project);
    return this.deployments.listByEnvironment(envId);
  }

  @Get('deployments')
  async listAll(@Query() query: ListDeploymentsDto, @CurrentUser() user: User) {
    return this.deployments.listAllForOwner(user, query);
  }

  @Get('deployments/:id')
  async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    const dep = await this.deployments.findById(id);
    if (!dep || dep.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    ensureCan(user, 'deployments.read', dep.environment.project);
    return dep;
  }

  // Streams the running web container's stdout/stderr (`docker logs -f`) by
  // proxying the worker's chunked HTTP stream straight through to the browser.
  // Runtime output can leak secrets, so this is gated on `deployments.update`
  // (stricter than read) and audited. The worker is the authority on whether a
  // live container exists (it 404s); we short-circuit when no targeted service
  // has a container id at all.
  @Get('deployments/:id/runtime-logs')
  @Audit('deployments.logs')
  async runtimeLogs(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('tail') tail: string | undefined,
    @Query('service') service: string | undefined,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const dep = await this.deployments.findById(id);
    if (!dep || dep.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    ensureCan(user, 'deployments.update', dep.environment.project);

    // Pick the target service (named, or the web service by default) and make
    // sure it actually has a live container before opening the upstream stream.
    const target = service
      ? dep.services.find((s) => s.name === service)
      : dep.services.find((s) => s.isWeb);
    if (!target?.containerId) {
      throw new NotFoundException('No running container for this deployment');
    }

    // Abort the upstream stream when the browser disconnects.
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    const workerUrl = this.config.get('WORKER_HTTP_URL', { infer: true });
    const params = new URLSearchParams({ follow: '1' });
    if (tail) params.set('tail', tail);
    if (service) params.set('service', service);
    const upstreamUrl = `${workerUrl}/deployments/${id}/logs?${params.toString()}`;

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(upstreamUrl, { signal: ac.signal });
    } catch {
      throw new BadGatewayException('Worker unreachable');
    }

    if (upstream.status === 404) {
      throw new NotFoundException('No running container for this deployment');
    }
    if (!upstream.ok || !upstream.body) {
      throw new BadGatewayException('Worker log stream failed');
    }

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Disable proxy buffering (nginx/Traefik) so tailed lines flush live.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
    } catch {
      // Client disconnect / upstream abort — nothing actionable.
    } finally {
      res.end();
    }
  }

  // Lists the curated maintenance actions available for this deployment — the
  // project's allowlist, filtered to actions whose target service has a live
  // container. The `command` is never exposed; the client triggers by id only.
  @Get('deployments/:id/actions')
  async listActions(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<{ actions: PublicMaintenanceAction[] }> {
    const dep = await this.deployments.findById(id);
    if (!dep || dep.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    ensureCan(user, 'deployments.exec', dep.environment.project);

    const actions = maintenanceActionsFor(dep)
      .filter((a) => hasContainer(dep, a.service))
      .map(
        (a): PublicMaintenanceAction => ({
          id: a.id,
          label: a.label,
          service: a.service,
          destructive: a.destructive ?? false,
        }),
      );
    return { actions };
  }

  // Runs a curated maintenance command in the target service's container and
  // streams its merged stdout/stderr (then a `\x1e{"exitCode":N}` frame) straight
  // through from the worker — same streaming path as runtime-logs. The client
  // sends only an action id; the API resolves the command from the allowlist.
  @Post('deployments/:id/actions/:actionId')
  @Audit('deployments.action')
  async runAction(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('actionId') actionId: string,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const dep = await this.deployments.findById(id);
    if (!dep || dep.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    ensureCan(user, 'deployments.exec', dep.environment.project);

    const action = maintenanceActionsFor(dep).find((a) => a.id === actionId);
    if (!action) {
      throw new BadRequestException(`Unknown action: ${actionId}`);
    }
    const target = dep.services.find((s) => s.name === action.service);
    if (!target?.containerId) {
      throw new NotFoundException('No running container for this action');
    }

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    const workerUrl = this.config.get('WORKER_HTTP_URL', { infer: true });
    const upstreamUrl = `${workerUrl}/deployments/${id}/services/${encodeURIComponent(action.service)}/run`;

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: action.command }),
        signal: ac.signal,
      });
    } catch {
      throw new BadGatewayException('Worker unreachable');
    }
    if (upstream.status === 404) {
      throw new NotFoundException('No running container for this action');
    }
    if (!upstream.ok || !upstream.body) {
      throw new BadGatewayException('Maintenance command failed');
    }

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
    } catch {
      // Client disconnect / upstream abort — nothing actionable.
    } finally {
      res.end();
    }
  }

  @Post('deployments/:id/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('deployments.cancel')
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    const dep = await this.prisma.deployment.findUnique({
      where: { id },
      select: {
        environment: {
          select: { project: { select: { ownerId: true, deletedAt: true } } },
        },
      },
    });
    if (!dep || dep.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    ensureCan(user, 'deployments.cancel', dep.environment.project);
    await this.deployments.cancel(id);
  }

  @Post('deployments/:id/redeploy')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('deployments.redeploy')
  async redeploy(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.assertCanDeployFrom(id, user);
    return this.deployments.redeploy(id, user.id);
  }

  @Post('deployments/:id/rollback')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('deployments.rollback')
  async rollback(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.assertCanDeployFrom(id, user);
    return this.deployments.rollback(id, user.id);
  }

  // Both redeploy and rollback create a new deployment in the source's
  // environment, so they gate on `deployments.create` for that project.
  private async assertCanDeployFrom(id: string, user: User): Promise<void> {
    const dep = await this.prisma.deployment.findUnique({
      where: { id },
      select: {
        environment: {
          select: { project: { select: { ownerId: true, deletedAt: true } } },
        },
      },
    });
    if (!dep || dep.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    ensureCan(user, 'deployments.create', dep.environment.project);
  }

  // Stop/start/restart a single named container of a deployment by proxying the
  // worker. Gated on `deployments.update` and audited. The worker resolves the
  // container and returns its resulting live state as JSON.
  @Post('deployments/:id/services/:name/:action')
  @HttpCode(HttpStatus.OK)
  @Audit('deployments.service-action')
  async serviceAction(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('name') name: string,
    @Param('action') action: string,
    @CurrentUser() user: User,
  ): Promise<unknown> {
    if (!SERVICE_ACTIONS.has(action)) {
      throw new BadRequestException(`Unknown action: ${action}`);
    }
    await this.assertCanControl(id, user);

    const workerUrl = this.config.get('WORKER_HTTP_URL', { infer: true });
    const url = `${workerUrl}/deployments/${id}/services/${encodeURIComponent(name)}/${action}`;

    let resp: globalThis.Response;
    try {
      resp = await fetch(url, { method: 'POST' });
    } catch {
      throw new BadGatewayException('Worker unreachable');
    }
    if (resp.status === 404) {
      throw new NotFoundException('No container for this service');
    }
    if (!resp.ok) {
      throw new BadGatewayException('Service action failed');
    }
    const body = (await resp.json()) as {
      service: string;
      action: string;
      state: string;
    };
    await this.prisma.service.updateMany({
      where: { deploymentId: id, name },
      data: { status: body.state },
    });
    return body;
  }

  private async assertCanControl(id: string, user: User): Promise<void> {
    const dep = await this.prisma.deployment.findUnique({
      where: { id },
      select: {
        environment: {
          select: { project: { select: { ownerId: true, deletedAt: true } } },
        },
      },
    });
    if (!dep || dep.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    ensureCan(user, 'deployments.update', dep.environment.project);
  }

  // Instantaneous CPU/memory readout for one running service, proxied verbatim
  // from the worker as plain JSON (not a stream). Read-only and polled at high
  // frequency by the web (~every 4s), so it is gated on `deployments.read` and
  // deliberately NOT audited.
  @Get('deployments/:id/services/:name/stats')
  async serviceStats(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('name') name: string,
    @CurrentUser() user: User,
  ): Promise<ServiceStats> {
    const dep = await this.deployments.findById(id);
    if (!dep || dep.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    ensureCan(user, 'deployments.read', dep.environment.project);

    const target = name
      ? dep.services.find((s) => s.name === name)
      : dep.services.find((s) => s.isWeb);
    if (!target?.containerId) {
      throw new NotFoundException('No running container for this service');
    }

    const workerUrl = this.config.get('WORKER_HTTP_URL', { infer: true });
    const url = `${workerUrl}/deployments/${id}/services/${encodeURIComponent(name)}/stats`;

    let resp: globalThis.Response;
    try {
      resp = await fetch(url);
    } catch {
      throw new BadGatewayException('Worker unreachable');
    }
    if (resp.status === 404) {
      throw new NotFoundException('No container for this service');
    }
    if (!resp.ok) {
      throw new BadGatewayException('Service stats failed');
    }
    return (await resp.json()) as ServiceStats;
  }

  // Health/lifecycle snapshot for one service, proxied verbatim from the worker
  // as plain JSON (not a stream). Read-only and polled by the web, so it is gated
  // on `deployments.read` and deliberately NOT audited. We 404 locally only when
  // the service never had a container; a stopped container still has a
  // containerId and must reach the worker, which reports its stopped state.
  @Get('deployments/:id/services/:name/health')
  async serviceHealth(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('name') name: string,
    @CurrentUser() user: User,
  ): Promise<ServiceHealth> {
    const dep = await this.deployments.findById(id);
    if (!dep || dep.environment.project.deletedAt) {
      throw new NotFoundException();
    }
    ensureCan(user, 'deployments.read', dep.environment.project);

    const target = name
      ? dep.services.find((s) => s.name === name)
      : dep.services.find((s) => s.isWeb);
    if (!target?.containerId) {
      throw new NotFoundException('No container for this service');
    }

    const workerUrl = this.config.get('WORKER_HTTP_URL', { infer: true });
    const url = `${workerUrl}/deployments/${id}/services/${encodeURIComponent(name)}/health`;

    let resp: globalThis.Response;
    try {
      resp = await fetch(url);
    } catch {
      throw new BadGatewayException('Worker unreachable');
    }
    if (resp.status === 404) {
      throw new NotFoundException('No container for this service');
    }
    if (!resp.ok) {
      throw new BadGatewayException('Service health failed');
    }
    return (await resp.json()) as ServiceHealth;
  }
}

// Container lifecycle actions the worker accepts; validated before proxying.
const SERVICE_ACTIONS = new Set(['stop', 'start', 'restart']);

// Worker stats payload, mirrored byte-for-byte by the web client.
interface ServiceStats {
  service: string;
  cpuPct: number;
  memUsedBytes: number;
  memLimitBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  blkReadBytes: number;
  blkWriteBytes: number;
}

// Worker health payload, mirrored byte-for-byte by the web client.
interface ServiceHealth {
  service: string;
  state: string;
  health: string;
  restartCount: number;
  exitCode: number;
}

// What the client receives for a maintenance action — never the command.
interface PublicMaintenanceAction {
  id: string;
  label: string;
  service: string;
  destructive: boolean;
}

// Resolves the maintenance action allowlist for a deployment: the built-in
// presets for its detected framework, merged with the project's hand-written
// actions by id (a project action overrides the preset of the same id; project-
// only ids are appended). Unknown/NULL framework contributes no presets. The
// project actions are validated on their own so a stale/extra buildConfig field
// can't hide the catalog.
function maintenanceActionsFor(dep: DeploymentDetail): MaintenanceAction[] {
  const presets = FRAMEWORK_PRESETS[dep.framework ?? ''] ?? [];

  const raw = (dep.environment.project.buildConfig as {
    maintenanceActions?: unknown;
  } | null)?.maintenanceActions;
  const parsed = MaintenanceActionsSchema.safeParse(raw);
  const custom = parsed.success ? parsed.data : [];

  const byId = new Map<string, MaintenanceAction>();
  for (const action of [...presets, ...custom]) {
    byId.set(action.id, action);
  }
  return [...byId.values()];
}

function hasContainer(dep: DeploymentDetail, service: string): boolean {
  return !!dep.services.find((s) => s.name === service)?.containerId;
}
