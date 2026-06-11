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
import { DeploymentsService } from './deployments.service';
import { CreateDeploymentDto } from './dto/create-deployment.dto';
import { ListDeploymentsDto } from './dto/list-deployments.dto';

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
}

// Container lifecycle actions the worker accepts; validated before proxying.
const SERVICE_ACTIONS = new Set(['stop', 'start', 'restart']);
