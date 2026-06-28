import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ListAuditLogsOptions {
  // The org to scope the feed to; rows are restricted to its members' activity.
  orgId: string;
  limit?: number;
  cursor?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(opts: ListAuditLogsOptions) {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    // The activity feed is org-scoped (caller already gated on `audit.read`):
    // restrict to the org members' rows. An optional actorUserId narrows to one
    // member; a non-member actorUserId is ignored, never honored.
    const memberIds = await this.orgMemberIds(opts.orgId);
    const actorUserId =
      opts.actorUserId && memberIds.includes(opts.actorUserId)
        ? opts.actorUserId
        : { in: memberIds };

    const createdAt = this.dateRange(opts.from, opts.to);
    const where: Prisma.AuditLogWhereInput = {
      actorUserId,
      action: opts.action,
      resourceType: opts.resourceType,
      resourceId: opts.resourceId,
      ...(createdAt ? { createdAt } : {}),
    };

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: BigInt(opts.cursor) }, skip: 1 } : {}),
      select: {
        id: true,
        action: true,
        resourceType: true,
        resourceId: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        afterJson: true,
        actor: { select: { id: true, email: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const items = page.map((row) => ({
      id: row.id.toString(),
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      actor: row.actor,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
      afterJson: row.afterJson,
    }));

    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }

  private async orgMemberIds(orgId: string): Promise<string[]> {
    const members = await this.prisma.orgMembership.findMany({
      where: { orgId },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  private dateRange(
    from?: string,
    to?: string,
  ): Prisma.DateTimeFilter | undefined {
    if (!from && !to) return undefined;
    return {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }
}
