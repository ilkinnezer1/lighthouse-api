import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { CookieOptions, Response } from 'express';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import type { Env } from '../config/env';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

const COOKIE_NAME = 'session';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post('signup')
  @Throttle({ default: { limit: 3, ttl: 60 * 60 * 1000 } })
  @Audit('users.signup')
  async signup(
    @Body() dto: SignupDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.signup(dto);
    this.setSessionCookie(res, this.auth.signToken(user));
    return this.serialize(user);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 15 * 60 * 1000 } })
  @Audit('users.login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.login(dto);
    this.setSessionCookie(res, this.auth.signToken(user));
    return this.serialize(user);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @SkipThrottle()
  @Audit('users.logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(COOKIE_NAME, this.cookieOptions());
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: User) {
    return this.serialize(user);
  }

  private setSessionCookie(res: Response, token: string) {
    res.cookie(COOKIE_NAME, token, {
      ...this.cookieOptions(),
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }

  private cookieOptions(): CookieOptions {
    const isProd =
      this.config.get('NODE_ENV', { infer: true }) === 'production';
    return {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
    };
  }

  private serialize(user: User) {
    const { id, email, username, displayName, role, createdAt, lastLoginAt } =
      user;
    return { id, email, username, displayName, role, createdAt, lastLoginAt };
  }
}
