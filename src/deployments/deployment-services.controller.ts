import {
  BadRequestException,
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
import type { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { DeploymentAccessService } from './deployment-access.service';
import { WorkerProxyService } from './worker-proxy.service';

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

@Controller()
@UseGuards(JwtAuthGuard)
export class DeploymentServicesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DeploymentAccessService,
    private readonly worker: WorkerProxyService,
  ) {}

  // Streams the running web container's stdout/stderr (`docker logs -f`) by
  // proxying the worker's chunked HTTP stream straight through to the browser.
  // Runtime output can leak secrets, so this is gated on `deployments.update`
  // (stricter than read) and audited.
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
    const dep = await this.access.detail(id, user, 'deployments.update');

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

    const params = new URLSearchParams({ follow: '1' });
    if (tail) params.set('tail', tail);
    if (service) params.set('service', service);

    await this.worker.stream(
      res,
      `/deployments/${id}/logs?${params.toString()}`,
      { signal: ac.signal },
      {
        notFound: 'No running container for this deployment',
        failed: 'Worker log stream failed',
      },
    );
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
    await this.access.authorize(id, user, 'deployments.update');

    const body = await this.worker.json<{
      service: string;
      action: string;
      state: string;
    }>(
      `/deployments/${id}/services/${encodeURIComponent(name)}/${action}`,
      { method: 'POST' },
      {
        notFound: 'No container for this service',
        failed: 'Service action failed',
      },
    );

    await this.prisma.service.updateMany({
      where: { deploymentId: id, name },
      data: { status: body.state },
    });
    return body;
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
    const dep = await this.access.detail(id, user, 'deployments.read');

    const target = dep.services.find((s) => s.name === name);
    if (!target?.containerId) {
      throw new NotFoundException('No running container for this service');
    }

    return this.worker.json<ServiceStats>(
      `/deployments/${id}/services/${encodeURIComponent(name)}/stats`,
      {},
      {
        notFound: 'No container for this service',
        failed: 'Service stats failed',
      },
    );
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
    const dep = await this.access.detail(id, user, 'deployments.read');

    const target = dep.services.find((s) => s.name === name);
    if (!target?.containerId) {
      throw new NotFoundException('No container for this service');
    }

    return this.worker.json<ServiceHealth>(
      `/deployments/${id}/services/${encodeURIComponent(name)}/health`,
      {},
      {
        notFound: 'No container for this service',
        failed: 'Service health failed',
      },
    );
  }
}
