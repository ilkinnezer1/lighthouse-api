import { Injectable } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import type { User, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByUsername(username: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { username } });
  }

  // Creates the user together with their personal organization (one OWNER
  // membership) in a single transaction, so every account — signup or bootstrap
  // admin — matches the migrated state and has somewhere to own projects.
  create(data: {
    email: string;
    username: string;
    passwordHash: string;
    displayName?: string;
    role?: UserRole;
  }): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data });
      await tx.organization.create({
        data: {
          name: data.displayName ?? data.username,
          slug: data.username,
          isPersonal: true,
          memberships: { create: { userId: user.id, role: OrgRole.OWNER } },
        },
      });
      return user;
    });
  }

  updateLastLogin(id: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }
}
