import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import { AuditQueryService } from './audit-query.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

@Controller('audit-logs')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(
    private readonly audit: AuditQueryService,
    private readonly authz: AuthzService,
  ) {}

  @Get()
  async list(@Query() query: ListAuditLogsDto, @CurrentUser() user: User) {
    // Org-scoped activity feed, gated on `audit.read` (Owner/Admin only — a
    // Member/Viewer gets 403). Defaults to the caller's personal org, where
    // they are OWNER, so a solo user still reads their own trail unchanged.
    const orgId = await this.authz.resolveScopeOrgId(user, query.orgId);
    await this.authz.ensureCan(user, 'audit.read', { organizationId: orgId });
    return this.audit.list({ ...query, orgId });
  }
}
