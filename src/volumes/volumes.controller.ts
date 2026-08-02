import {
  BadGatewayException,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import { Action } from '../common/authz';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export interface VolumeInfo {
  name: string;
  volume: string;
  sizeBytes: number;
  createdAt: string;
  inUse: boolean;
}

// Persistent volumes live in Docker, not Postgres, so both routes proxy the
// worker — the only process allowed to touch the Docker socket.
@Controller('environments/:id/volumes')
@UseGuards(JwtAuthGuard)
export class VolumesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<{ volumes: VolumeInfo[] }> {
    await this.authorize(id, user, 'environments.read');

    const resp = await this.worker(`${this.base()}/environments/${id}/volumes`);
    if (!resp.ok) {
      throw new BadGatewayException('Could not list volumes');
    }
    return { volumes: (await resp.json()) as VolumeInfo[] };
  }

  @Delete(':name')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('environments.volume-delete')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('name') name: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    await this.authorize(id, user, 'environments.update');

    const url = `${this.base()}/environments/${id}/volumes/${encodeURIComponent(name)}`;
    const resp = await this.worker(url, 'DELETE');
    if (resp.status === HttpStatus.CONFLICT) {
      throw new ConflictException(
        'Volume is still attached to a container — it can only be removed once no deployment uses it',
      );
    }
    if (resp.status === HttpStatus.NOT_FOUND) {
      throw new NotFoundException('Volume not found');
    }
    if (!resp.ok) {
      throw new BadGatewayException('Could not delete volume');
    }
  }

  private base(): string {
    return this.config.get('WORKER_HTTP_URL', { infer: true });
  }

  private async worker(
    url: string,
    method = 'GET',
  ): Promise<globalThis.Response> {
    try {
      return await fetch(url, { method });
    } catch {
      throw new BadGatewayException('Worker unreachable');
    }
  }

  private async authorize(
    id: string,
    user: User,
    action: Action,
  ): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id },
      select: {
        project: { select: { organizationId: true, deletedAt: true } },
      },
    });
    if (!env || env.project.deletedAt) {
      throw new NotFoundException('Environment not found');
    }
    await this.authz.ensureCan(user, action, env.project);
  }
}
