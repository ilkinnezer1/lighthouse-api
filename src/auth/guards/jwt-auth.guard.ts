import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import { UsersService } from '../../users/users.service';
import type { JwtPayload } from '../auth.service';

const COOKIE_NAME = 'session';

declare module 'express' {
  interface Request {
    user?: User;
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = (req.cookies as Record<string, string> | undefined)?.[
      COOKIE_NAME
    ];
    if (!token) {
      throw new UnauthorizedException('No session');
    }

    let payload: JwtPayload;

    try {
      payload = this.jwt.verify<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }

    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account unavailable');
    }

    req.user = user;
    return true;
  }
}
