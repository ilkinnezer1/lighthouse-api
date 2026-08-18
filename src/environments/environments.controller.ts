import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import { ListEnvironmentsDto } from './dto/list-environments.dto';
import { EnvironmentsService } from './environments.service';

@Controller('environments')
@UseGuards(JwtAuthGuard)
export class EnvironmentsController {
  constructor(
    private readonly environments: EnvironmentsService,
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
}
