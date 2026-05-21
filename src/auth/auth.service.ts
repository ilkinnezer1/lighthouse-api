import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { Prisma, type User } from '@prisma/client';
import type { Env } from '../config/env';
import { UsersService } from '../users/users.service';
import type { LoginDto } from './dto/login.dto';
import type { SignupDto } from './dto/signup.dto';

export interface JwtPayload {
  sub: string;
  role: User['role'];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  verifyPassword(hash: string, plain: string): Promise<boolean> {
    return argon2.verify(hash, plain);
  }

  signToken(user: Pick<User, 'id' | 'role'>): string {
    const payload: JwtPayload = { sub: user.id, role: user.role };
    return this.jwt.sign(payload, { expiresIn: '7d' });
  }

  async signup(dto: SignupDto): Promise<User> {
    const allowSignUp = this.config.get('ALLOW_PUBLIC_SIGNUP', { infer: true });
    if (!allowSignUp) {
      throw new ForbiddenException('Public signup is disabled');
    }

    const existingByEmail = await this.users.findByEmail(dto.email);
    if (existingByEmail) {
      throw new ConflictException('Email already in use');
    }

    const existingByUsername = await this.users.findByUsername(dto.username);
    if (existingByUsername) {
      throw new ConflictException('Username already in use');
    }

    try {
      return await this.users.create({
        email: dto.email,
        username: dto.username,
        passwordHash: await this.hashPassword(dto.password),
        displayName: dto.displayName,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = (err.meta?.target as string[] | undefined)?.join(',');
        const field = target?.includes('username') ? 'Username' : 'Email';
        throw new ConflictException(`${field} already in use`);
      }
      throw err;
    }
  }

  async login(dto: LoginDto): Promise<User> {
    const user = await this.users.findByEmail(dto.email);
    const generic = new UnauthorizedException('Invalid credentials');
    if (!user || !user.passwordHash) {
      throw generic;
    }

    const ok = await this.verifyPassword(user.passwordHash, dto.password);
    if (!ok) {
      throw generic;
    }

    if (!user.isActive) {
      throw new ForbiddenException('Account is disabled');
    }

    return this.users.updateLastLogin(user.id);
  }
}
