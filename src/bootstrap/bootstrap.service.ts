import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  async onApplicationBootstrap() {
    const userCount = await this.prisma.user.count();
    if (userCount > 0) {
      this.logger.log(
        `Skip admin bootstrap: ${userCount} user(s) already exist`,
      );
      return;
    }

    const email = this.config.get('BOOTSTRAP_ADMIN_EMAIL', { infer: true });
    const password = this.config.get('BOOTSTRAP_ADMIN_PASSWORD', {
      infer: true,
    });

    await this.users.create({
      email,
      username: 'admin',
      passwordHash: await this.auth.hashPassword(password),
      displayName: 'Admin',
      role: 'ADMIN',
    });

    this.logger.warn(
      `Bootstrap admin created: ${email} - change the password after first login`,
    );
  }
}
