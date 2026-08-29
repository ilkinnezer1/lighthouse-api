import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
import { ListEnvironmentsDto } from './dto/list-environments.dto';
import { LockEnvironmentDto } from './dto/lock-environment.dto';
import { UpdateHibernationDto } from './dto/update-hibernation.dto';
import { EnvironmentHibernationService } from './environment-hibernation.service';
import { EnvironmentLocksService } from './environment-locks.service';
import { EnvironmentsService } from './environments.service';

@Controller('environments')
@UseGuards(JwtAuthGuard)
export class EnvironmentsController {
  constructor(
    private readonly environments: EnvironmentsService,
    private readonly locks: EnvironmentLocksService,
    private readonly hibernation: EnvironmentHibernationService,
    private readonly authz: AuthzService,
  ) {}

  // Org-scoped like the deployments and databases feeds: resolveScopeOrgId
  // validates membership, so no per-row capability check is needed here.
  @Get()
  async list(@Query() query: ListEnvironmentsDto, @CurrentUser() user: User) {
    const orgId = await this.authz.resolveScopeOrgId(user, query.orgId);
    return this.environments.listForOrg(orgId, {
      limit: query.limit,
      cursor: query.cursor,
      projectId: query.projectId,
      type: query.type,
      active: query.active === undefined ? undefined : query.active === 'true',
    });
  }

  @Post(':id/lock')
  @HttpCode(HttpStatus.OK)
  @Audit('environments.lock')
  lock(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: LockEnvironmentDto,
    @CurrentUser() user: User,
  ) {
    return this.locks.acquire(id, user, dto);
  }

  @Delete(':id/lock')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('environments.unlock')
  async unlock(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
    @Req() req: Request,
  ): Promise<void> {
    const { released, forced } = await this.locks.release(id, user);
    if (forced && released) {
      req.auditAction = 'environments.force_unlock';
      req.auditContext = { releasedLock: released };
    }
  }

  @Put(':id/hibernation')
  @Audit('environments.hibernation_update')
  updateHibernation(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateHibernationDto,
    @CurrentUser() user: User,
  ) {
    return this.hibernation.updateSettings(id, user, dto);
  }

  @Post(':id/wake')
  @HttpCode(HttpStatus.OK)
  @Audit('environments.wake')
  wake(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    return this.hibernation.wake(id, user);
  }

  @Post(':id/hibernate')
  @HttpCode(HttpStatus.OK)
  @Audit('environments.hibernate')
  hibernate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    return this.hibernation.hibernateNow(id, user);
  }
}
