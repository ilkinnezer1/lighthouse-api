import {
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
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ensureCan } from '../common/authz';
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
  async listAll(
    @Query() query: ListDeploymentsDto,
    @CurrentUser() user: User,
  ) {
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
}
