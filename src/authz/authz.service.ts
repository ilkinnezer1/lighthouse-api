import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import type { User } from '@prisma/client';
import {
  ROLE_CAPABILITIES,
  type Action,
  type OrgScopedResource,
} from '../common/authz';
import { PrismaService } from '../prisma/prisma.service';

// Central authorization for org-scoped resources. Resolves the caller's role in
// the resource's organization and checks it against ROLE_CAPABILITIES. Platform
// admins bypass; no membership means deny. Injectable (not a pure function)
// because the membership lookup now hits the DB.
@Injectable()
export class AuthzService {
  constructor(private readonly prisma: PrismaService) {}

  async can(
    user: Pick<User, 'id' | 'role'>,
    action: Action,
    resource: OrgScopedResource,
  ): Promise<boolean> {
    if (user.role === 'ADMIN') return true;
    const role = await this.roleIn(resource.organizationId, user.id);
    if (!role) return false;
    return ROLE_CAPABILITIES[role].has(action);
  }

  async ensureCan(
    user: Pick<User, 'id' | 'role'>,
    action: Action,
    resource: OrgScopedResource,
  ): Promise<void> {
    if (!(await this.can(user, action, resource))) {
      throw new ForbiddenException(`Not allowed: ${action}`);
    }
  }

  // The actor's effective authority in an org for guardrail decisions (e.g.
  // "Admins can't act on Owners"): a platform admin acts with full (OWNER)
  // authority; otherwise their membership role, or VIEWER as a safe floor.
  async effectiveRole(
    user: Pick<User, 'id' | 'role'>,
    orgId: string,
  ): Promise<OrgRole> {
    if (user.role === 'ADMIN') return OrgRole.OWNER;
    return (await this.roleIn(orgId, user.id)) ?? OrgRole.VIEWER;
  }

  // The caller's role in an org, or null when they aren't a member. Used both
  // for capability checks and by Phase B guardrails that need the concrete role.
  async roleIn(orgId: string, userId: string): Promise<OrgRole | null> {
    const membership = await this.prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { role: true },
    });
    return membership?.role ?? null;
  }

  // The org a list/feed request scopes to: an explicit ?orgId= the caller
  // belongs to, or their personal org by default (so solo flows are unchanged).
  // Platform admins may scope to any org; other non-members get 403.
  async resolveScopeOrgId(
    user: Pick<User, 'id' | 'role'>,
    orgId?: string,
  ): Promise<string> {
    if (orgId) {
      if (user.role !== 'ADMIN' && !(await this.roleIn(orgId, user.id))) {
        throw new ForbiddenException('Not a member of this organization');
      }
      return orgId;
    }
    return this.personalOrgId(user.id);
  }

  // The user's personal org (created at signup); the default home for projects
  // and the default scope for list/feed endpoints.
  async personalOrgId(userId: string): Promise<string> {
    const membership = await this.prisma.orgMembership.findFirst({
      where: { userId, organization: { isPersonal: true } },
      select: { orgId: true },
    });
    if (!membership) {
      throw new NotFoundException('Personal organization not found');
    }
    return membership.orgId;
  }
}
