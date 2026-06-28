import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrgRole, Prisma, type User } from '@prisma/client';
import { AuthzService } from '../authz/authz.service';
import type { Env } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Fields safe to expose for an org's pending invites — never the token hash.
const ORG_INVITE_SELECT = {
  id: true,
  role: true,
  status: true,
  email: true,
  expiresAt: true,
  createdAt: true,
  invitee: { select: { id: true, username: true, displayName: true } },
  invitedBy: { select: { username: true } },
} satisfies Prisma.OrgInvitationSelect;

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly crypto: CryptoService,
    private readonly users: UsersService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Create an invitation — gated on `members.manage` by the controller. Admins
  // may invite up to ADMIN; only an Owner may mint an OWNER invite.
  async create(orgId: string, actor: User, dto: CreateInvitationDto) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { isPersonal: true },
    });
    if (!org) {
      throw new NotFoundException('Organization not found');
    }
    if (org.isPersonal) {
      throw new BadRequestException('Cannot invite to a personal organization');
    }
    if (!dto.link && !dto.username && !dto.email) {
      throw new BadRequestException('Provide a username, email, or link: true');
    }
    if (dto.role === OrgRole.OWNER) {
      const actorRole = await this.authz.effectiveRole(actor, orgId);
      if (actorRole !== OrgRole.OWNER) {
        throw new ForbiddenException('Only an owner can invite an owner');
      }
    }

    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    return dto.link
      ? this.createLinkInvite(orgId, actor.id, dto, expiresAt)
      : this.createInAppInvite(orgId, actor.id, dto, expiresAt);
  }

  // Mint a single-use link: the plaintext token is returned ONCE; only its hash
  // is persisted. `email` is optional metadata for a link invite.
  private async createLinkInvite(
    orgId: string,
    invitedByUserId: string,
    dto: CreateInvitationDto,
    expiresAt: Date,
  ) {
    const token = this.crypto.randomToken();
    const invite = await this.prisma.orgInvitation.create({
      data: {
        orgId,
        role: dto.role,
        invitedByUserId,
        tokenHash: this.crypto.hashToken(token),
        email: dto.email ?? null,
        expiresAt,
      },
      select: { id: true, role: true, expiresAt: true, createdAt: true },
    });
    const appUrl = this.config.get('PUBLIC_APP_URL', { infer: true });
    // Returned to the caller ONCE. The field is named `tokenLink` so the audit
    // interceptor's redactor (matches /token/) scrubs it from audit_log — the
    // plaintext token is never persisted, only its hash on the row above.
    return { ...invite, tokenLink: `${appUrl}/invite/${token}` };
  }

  private async createInAppInvite(
    orgId: string,
    invitedByUserId: string,
    dto: CreateInvitationDto,
    expiresAt: Date,
  ) {
    const invitee = dto.username
      ? await this.users.findByUsername(dto.username)
      : dto.email
        ? await this.users.findByEmail(dto.email)
        : null;
    if (!invitee) {
      throw new NotFoundException(
        'No existing user with that username or email',
      );
    }
    if (await this.authz.roleIn(orgId, invitee.id)) {
      throw new ConflictException('User is already a member of this org');
    }
    try {
      return await this.prisma.orgInvitation.create({
        data: {
          orgId,
          role: dto.role,
          invitedByUserId,
          inviteeUserId: invitee.id,
          expiresAt,
        },
        select: ORG_INVITE_SELECT,
      });
    } catch (err) {
      // Partial-unique (org, invitee) WHERE status=PENDING — already invited.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'User already has a pending invitation to this org',
        );
      }
      throw err;
    }
  }

  // An org's pending invites — gated on `members.manage`.
  listForOrg(orgId: string) {
    return this.prisma.orgInvitation.findMany({
      where: { orgId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      select: ORG_INVITE_SELECT,
    });
  }

  // Revoke a pending invite. Gated on `members.manage` for THAT invite's org.
  async revoke(invitationId: string, actor: User): Promise<void> {
    const invite = await this.prisma.orgInvitation.findUnique({
      where: { id: invitationId },
      select: { orgId: true, status: true },
    });
    if (!invite) {
      throw new NotFoundException('Invitation not found');
    }
    await this.authz.ensureCan(actor, 'members.manage', {
      organizationId: invite.orgId,
    });
    if (invite.status !== 'PENDING') {
      throw new ConflictException('Invitation is no longer pending');
    }
    await this.prisma.orgInvitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED' },
    });
  }

  // The caller's own pending in-app invites (their inbox).
  listMine(userId: string) {
    return this.prisma.orgInvitation.findMany({
      where: { inviteeUserId: userId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        role: true,
        expiresAt: true,
        createdAt: true,
        organization: { select: { id: true, name: true, slug: true } },
        invitedBy: { select: { username: true } },
      },
    });
  }

  // Accept an in-app invite. Only the invitee may act; idempotent if already
  // accepted/joined. Creates the membership and flips status to ACCEPTED.
  async accept(invitationId: string, user: User): Promise<void> {
    const invite = await this.loadOwnInvite(invitationId, user.id);
    if (invite.status === 'ACCEPTED') return;
    this.assertPending(invite.status);
    if (invite.expiresAt < new Date()) {
      await this.markExpired(invite.id);
      throw new GoneException('Invitation has expired');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.orgMembership.upsert({
        where: { orgId_userId: { orgId: invite.orgId, userId: user.id } },
        create: { orgId: invite.orgId, userId: user.id, role: invite.role },
        update: {},
      });
      await tx.orgInvitation.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED' },
      });
    });
  }

  // Decline an in-app invite. Only the invitee may act; idempotent.
  async decline(invitationId: string, user: User): Promise<void> {
    const invite = await this.loadOwnInvite(invitationId, user.id);
    if (invite.status === 'DECLINED') return;
    this.assertPending(invite.status);
    await this.prisma.orgInvitation.update({
      where: { id: invite.id },
      data: { status: 'DECLINED' },
    });
  }

  // Preview a link invite for the accept page (org + role + inviter). Never
  // returns the token/hash. 404 missing, 410 used/revoked/expired.
  async previewByToken(token: string) {
    const invite = await this.loadValidLinkInvite(token);
    return {
      orgName: invite.organization.name,
      role: invite.role,
      inviterUsername: invite.invitedBy.username,
    };
  }

  // Bind the authenticated caller to a link invite's org with the baked role.
  // Single-use: the token is atomically consumed (PENDING→ACCEPTED); idempotent
  // for a caller who already joined. Used/revoked/expired → 410.
  async acceptByToken(
    token: string,
    user: User,
  ): Promise<{ orgId: string; role: OrgRole }> {
    const invite = await this.prisma.orgInvitation.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
      select: {
        id: true,
        orgId: true,
        role: true,
        status: true,
        expiresAt: true,
      },
    });
    if (!invite) {
      throw new NotFoundException('Invitation not found');
    }
    if (invite.status === 'PENDING' && invite.expiresAt < new Date()) {
      await this.markExpired(invite.id);
      throw new GoneException('Invitation has expired');
    }
    // Atomically claim the single-use token: only one caller wins the flip.
    const claimed = await this.prisma.orgInvitation.updateMany({
      where: { id: invite.id, status: 'PENDING' },
      data: { status: 'ACCEPTED' },
    });
    if (claimed.count === 0) {
      // Already consumed: idempotent only if this caller is already a member.
      if (await this.authz.roleIn(invite.orgId, user.id)) {
        return { orgId: invite.orgId, role: invite.role };
      }
      throw new GoneException('Invitation has already been used');
    }
    await this.prisma.orgMembership.upsert({
      where: { orgId_userId: { orgId: invite.orgId, userId: user.id } },
      create: { orgId: invite.orgId, userId: user.id, role: invite.role },
      update: {},
    });
    return { orgId: invite.orgId, role: invite.role };
  }

  private async loadOwnInvite(invitationId: string, userId: string) {
    const invite = await this.prisma.orgInvitation.findUnique({
      where: { id: invitationId },
      select: {
        id: true,
        orgId: true,
        role: true,
        status: true,
        expiresAt: true,
        inviteeUserId: true,
      },
    });
    // Only the invitee may act; hide existence from anyone else.
    if (!invite || invite.inviteeUserId !== userId) {
      throw new NotFoundException('Invitation not found');
    }
    return invite;
  }

  private async loadValidLinkInvite(token: string) {
    const invite = await this.prisma.orgInvitation.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
      select: {
        id: true,
        role: true,
        status: true,
        expiresAt: true,
        organization: { select: { name: true } },
        invitedBy: { select: { username: true } },
      },
    });
    if (!invite) {
      throw new NotFoundException('Invitation not found');
    }
    if (invite.status !== 'PENDING') {
      throw new GoneException('Invitation is no longer valid');
    }
    if (invite.expiresAt < new Date()) {
      await this.markExpired(invite.id);
      throw new GoneException('Invitation has expired');
    }
    return invite;
  }

  private assertPending(status: string): void {
    if (status !== 'PENDING') {
      throw new ConflictException(
        `Invitation is ${status.toLowerCase()}, not pending`,
      );
    }
  }

  private async markExpired(id: string): Promise<void> {
    await this.prisma.orgInvitation.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
  }
}
