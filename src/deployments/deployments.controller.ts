import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { Request } from 'express';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import type { EnvironmentLock } from '../environments/environment-lock';
import { EnvironmentLocksService } from '../environments/environment-locks.service';
import { DeploymentAccessService } from './deployment-access.service';
import { DeploymentBranchesService } from './deployment-branches.service';
import { DeploymentChangesService } from './deployment-changes.service';
import { DeploymentsService } from './deployments.service';
import { CreateDeploymentDto } from './dto/create-deployment.dto';
import { DeployOverrideDto } from './dto/deploy-override.dto';
import { ListDeploymentsDto } from './dto/list-deployments.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class DeploymentsController {
  constructor(
    private readonly deployments: DeploymentsService,
    private readonly access: DeploymentAccessService,
    private readonly changes: DeploymentChangesService,
    private readonly branches: DeploymentBranchesService,
    private readonly locks: EnvironmentLocksService,
    private readonly authz: AuthzService,
  ) {}

  @Post('environments/:envId/deployments')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('deployments.create')
  async create(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @Body() dto: CreateDeploymentDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    await this.access.authorizeEnvironment(envId, user, 'deployments.create');
    const overridden = await this.gateOnLock(envId, user, dto, req);

    const deployment = await this.deployments.create(envId, user.id, {
      sourceBranch: dto.sourceBranch,
      mergeBranches: dto.mergeBranches,
    });
    await this.locks.announceOverride(
      envId,
      overridden,
      user.id,
      deployment.id,
    );
    return deployment;
  }

  // A dry run of the merge a deploy would perform. Deliberately not automatic:
  // every call costs a full fetch on the worker, so it is asked for, not polled.
  @Post('environments/:envId/merge-check')
  @HttpCode(HttpStatus.OK)
  async mergeCheck(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @Body() dto: CreateDeploymentDto,
    @CurrentUser() user: User,
  ) {
    await this.access.authorizeEnvironment(envId, user, 'deployments.create');
    return this.branches.checkMerge(
      envId,
      dto.sourceBranch,
      dto.mergeBranches,
      user.id,
    );
  }

  @Get('environments/:envId/deployments')
  async list(
    @Param('envId', new ParseUUIDPipe()) envId: string,
    @CurrentUser() user: User,
  ) {
    await this.access.authorizeEnvironment(envId, user, 'deployments.read');
    return this.deployments.listByEnvironment(envId);
  }

  @Get('deployments')
  async listAll(@Query() query: ListDeploymentsDto, @CurrentUser() user: User) {
    const orgId = await this.authz.resolveScopeOrgId(user, query.orgId);
    return this.deployments.listForOrg(orgId, query);
  }

  // What landed between the previous succeeded build of this environment and
  // this one. Separate from the detail payload because it costs a GitHub round
  // trip, and the page is useful before it resolves.
  @Get('deployments/:id/changes')
  async changesSince(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.access.authorize(id, user, 'deployments.read');
    return this.changes.forDeployment(id, user.id);
  }

  @Get('deployments/:id')
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    return this.access.detail(id, user, 'deployments.read');
  }

  @Post('deployments/:id/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('deployments.cancel')
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    await this.access.authorize(id, user, 'deployments.cancel');
    await this.deployments.cancel(id);
  }

  // Redeploy and rollback both create a new deployment in the source's
  // environment, so they gate on `deployments.create` for that project.
  @Post('deployments/:id/redeploy')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('deployments.redeploy')
  async redeploy(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DeployOverrideDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    const envId = await this.access.authorize(id, user, 'deployments.create');
    const overridden = await this.gateOnLock(envId, user, dto, req);
    const deployment = await this.deployments.redeploy(id, user.id);
    await this.locks.announceOverride(
      envId,
      overridden,
      user.id,
      deployment.id,
    );
    return deployment;
  }

  @Post('deployments/:id/rollback')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('deployments.rollback')
  async rollback(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DeployOverrideDto,
    @CurrentUser() user: User,
    @Req() req: Request,
  ) {
    const envId = await this.access.authorize(id, user, 'deployments.create');
    const overridden = await this.gateOnLock(envId, user, dto, req);
    const deployment = await this.deployments.rollback(id, user.id);
    await this.locks.announceOverride(
      envId,
      overridden,
      user.id,
      deployment.id,
    );
    return deployment;
  }

  // 409s when someone else holds the environment, unless the caller asked to
  // override — in which case the lock they walked through is audited and
  // returned, so the holder can be notified once the deployment exists.
  private async gateOnLock(
    envId: string,
    user: User,
    dto: DeployOverrideDto,
    req: Request,
  ): Promise<EnvironmentLock | null> {
    const overridden = await this.locks.assertDeployable(
      envId,
      user.id,
      dto.overrideLock === true,
    );
    if (overridden) {
      req.auditContext = { lockOverridden: overridden };
    }
    return overridden;
  }
}
