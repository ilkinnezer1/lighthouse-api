import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole, type User } from '@prisma/client';
import { AuthzService } from '../authz/authz.service';
import { JiraApiService } from '../jira/jira-api.service';
import { PrismaService } from '../prisma/prisma.service';
import { slugify } from '../projects/util/slug';

// Fields safe to return for an org — never the membership/invitation internals.
const ORG_SELECT = {
  id: true,
  name: true,
  slug: true,
  isPersonal: true,
  createdAt: true,
} as const;

const MAX_SLUG_TRIES = 50;

@Injectable()
export class OrgsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jira: JiraApiService,
    private readonly authz: AuthzService,
  ) {}

  // Creates a shared org with the caller as its sole OWNER, in one transaction.
  async createShared(userId: string, name: string) {
    const slug = await this.uniqueSlug(name);
    return this.prisma.organization.create({
      data: {
        name,
        slug,
        isPersonal: false,
        memberships: { create: { userId, role: OrgRole.OWNER } },
      },
      select: ORG_SELECT,
    });
  }

  // Orgs the caller belongs to, each annotated with the caller's own role.
  async listForUser(userId: string) {
    const memberships = await this.prisma.orgMembership.findMany({
      where: { userId },
      orderBy: { organization: { createdAt: 'asc' } },
      select: { role: true, organization: { select: ORG_SELECT } },
    });
    return memberships.map((m) => ({ ...m.organization, role: m.role }));
  }

  // Rename — gated on `org.update` (Owner) by the controller. Personal orgs keep
  // a fixed name (their owner's identity), so renaming them is rejected.
  async rename(orgId: string, name: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { isPersonal: true },
    });
    if (!org) {
      throw new NotFoundException('Organization not found');
    }
    if (org.isPersonal) {
      throw new BadRequestException('Personal organizations cannot be renamed');
    }
    return this.prisma.organization.update({
      where: { id: orgId },
      data: { name },
      select: ORG_SELECT,
    });
  }

  // Delete — gated on `org.delete` (Owner). Blocked unless empty (no projects),
  // which is safer than a cascade; personal orgs are never deletable.
  async remove(orgId: string): Promise<void> {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { isPersonal: true, _count: { select: { projects: true } } },
    });
    if (!org) {
      throw new NotFoundException('Organization not found');
    }
    if (org.isPersonal) {
      throw new ForbiddenException('Personal organizations cannot be deleted');
    }
    if (org._count.projects > 0) {
      throw new ConflictException(
        'Organization still has projects; delete them before deleting the org',
      );
    }
    await this.prisma.organization.delete({ where: { id: orgId } });
  }

  // Roster — gated on `members.read` (any member).
  async listMembers(orgId: string) {
    const members = await this.prisma.orgMembership.findMany({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        createdAt: true,
        user: { select: { id: true, username: true, displayName: true } },
      },
    });
    return members.map((m) => ({
      userId: m.user.id,
      username: m.user.username,
      displayName: m.user.displayName,
      role: m.role,
      joinedAt: m.createdAt,
    }));
  }

  // Change a member's role — gated on `members.manage` by the controller; this
  // enforces the role-level guardrails. You can't change your own role; only an
  // Owner may change/appoint an Owner; the org must keep ≥1 Owner.
  async changeRole(
    orgId: string,
    targetUserId: string,
    newRole: OrgRole,
    actor: Pick<User, 'id' | 'role'>,
  ) {
    if (targetUserId === actor.id) {
      throw new BadRequestException('You cannot change your own role');
    }
    const target = await this.getMembership(orgId, targetUserId);
    if (!target) {
      throw new NotFoundException('Member not found');
    }
    const actorRole = await this.authz.effectiveRole(actor, orgId);
    if (target.role === OrgRole.OWNER && actorRole !== OrgRole.OWNER) {
      throw new ForbiddenException('Only an owner can change an owner');
    }
    if (newRole === OrgRole.OWNER && actorRole !== OrgRole.OWNER) {
      throw new ForbiddenException('Only an owner can grant ownership');
    }
    if (target.role === OrgRole.OWNER && newRole !== OrgRole.OWNER) {
      await this.assertNotLastOwner(orgId);
    }
    return this.prisma.orgMembership.update({
      where: { orgId_userId: { orgId, userId: targetUserId } },
      data: { role: newRole },
      select: {
        role: true,
        user: { select: { id: true, username: true, displayName: true } },
      },
    });
  }

  // Remove a member, or leave the org when removing yourself. Self-leave needs
  // no `members.manage`; removing someone else does (+ Admins can't remove
  // Owners). Either way the last Owner can't be removed.
  async removeMember(
    orgId: string,
    targetUserId: string,
    actor: Pick<User, 'id' | 'role'>,
  ): Promise<void> {
    const target = await this.getMembership(orgId, targetUserId);
    if (!target) {
      throw new NotFoundException('Member not found');
    }
    if (targetUserId !== actor.id) {
      await this.authz.ensureCan(actor, 'members.manage', {
        organizationId: orgId,
      });
      const actorRole = await this.authz.effectiveRole(actor, orgId);
      if (target.role === OrgRole.OWNER && actorRole !== OrgRole.OWNER) {
        throw new ForbiddenException('Only an owner can remove an owner');
      }
    }
    if (target.role === OrgRole.OWNER) {
      await this.assertNotLastOwner(orgId);
    }
    await this.prisma.orgMembership.delete({
      where: { orgId_userId: { orgId, userId: targetUserId } },
    });
  }

  private getMembership(orgId: string, userId: string) {
    return this.prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { role: true },
    });
  }

  private async assertNotLastOwner(orgId: string): Promise<void> {
    const owners = await this.prisma.orgMembership.count({
      where: { orgId, role: OrgRole.OWNER },
    });
    if (owners <= 1) {
      throw new ConflictException(
        'An organization must keep at least one owner',
      );
    }
  }

  /**
   * The org's Jira site plus the sites the caller's own token can reach, so the
   * settings UI can offer a picker without a second round-trip.
   */
  async getJiraSite(orgId: string, userId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { atlassianCloudId: true, atlassianSiteUrl: true },
    });
    if (!org) {
      throw new NotFoundException('Organization not found');
    }
    return {
      site: org.atlassianCloudId
        ? { cloudId: org.atlassianCloudId, url: org.atlassianSiteUrl }
        : null,
      availableSites: await this.jira.listSites(userId),
      connected: await this.jira.isConnected(userId),
    };
  }

  /**
   * Point the org at one of the Jira sites the caller can actually reach. The
   * name and URL come from Atlassian's answer, not the request body, so the
   * stored link is always a site this caller was authorized to see.
   */
  async setJiraSite(orgId: string, userId: string, cloudId: string) {
    const sites = await this.jira.listSites(userId);
    const site = sites.find((s) => s.cloudId === cloudId);
    if (!site) {
      throw new BadRequestException(
        'That Jira site is not available to your Atlassian account',
      );
    }
    await this.prisma.organization.update({
      where: { id: orgId },
      data: { atlassianCloudId: site.cloudId, atlassianSiteUrl: site.url },
    });
    return { site: { cloudId: site.cloudId, url: site.url } };
  }

  async clearJiraSite(orgId: string): Promise<void> {
    await this.prisma.organization.update({
      where: { id: orgId },
      data: { atlassianCloudId: null, atlassianSiteUrl: null },
    });
  }

  // Derive a unique, url-safe slug from the org name, deduping with -2, -3, ….
  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name) || 'org';
    for (let i = 1; i <= MAX_SLUG_TRIES; i++) {
      const slug = i === 1 ? base : `${base}-${i}`;
      const existing = await this.prisma.organization.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (!existing) return slug;
    }
    throw new ConflictException(
      'Could not allocate a unique organization slug',
    );
  }
}
