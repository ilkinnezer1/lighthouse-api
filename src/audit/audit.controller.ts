import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ensureCan } from '../common/authz';
import { AuditQueryService } from './audit-query.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

@Controller('audit-logs')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  async list(@Query() query: ListAuditLogsDto, @CurrentUser() user: User) {
    const scopedActorId =
      user.role === 'ADMIN' ? query.actorUserId ?? user.id : user.id;
    ensureCan(user, 'audit.read', { ownerId: scopedActorId });
    return this.audit.list(user, query);
  }
}
