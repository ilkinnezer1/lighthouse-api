import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Query,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import type { Response } from 'express';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ensureCan } from '../common/authz';
import { Env } from '../config/env';
import { GithubApiService } from '../github/github-api.service';
import { ListReposDto } from './dto/list-repos.dto';
import { GithubOauthService } from './github-oauth.service';

@Controller('integrations')
@UseGuards(JwtAuthGuard)
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(
    private readonly githubOauth: GithubOauthService,
    private readonly github: GithubApiService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get()
  async list(@CurrentUser() user: User) {
    ensureCan(user, 'integrations.read', { ownerId: user.id });
    return { connections: await this.githubOauth.listConnections(user.id) };
  }

  @Get('github/connect')
  @Audit('integrations.connect')
  githubConnect(@CurrentUser() user: User, @Res() res: Response): void {
    ensureCan(user, 'integrations.connect', { ownerId: user.id });
    if (!this.githubOauth.isConfigured()) {
      throw new ServiceUnavailableException(
        'GitHub integration not configured',
      );
    }
    res.redirect(this.githubOauth.authorizeUrl(user.id));
  }

  @Get('github/callback')
  @Audit('integrations.connect')
  async githubCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @CurrentUser() user: User,
    @Res() res: Response,
  ): Promise<void> {
    ensureCan(user, 'integrations.connect', { ownerId: user.id });
    const appUrl = this.config.get('PUBLIC_APP_URL', { infer: true });
    try {
      if (!code || !state) {
        throw new BadRequestException('Missing code or state');
      }
      await this.githubOauth.handleCallback(user.id, code, state);
      res.redirect(`${appUrl}/integrations?connected=github`);
    } catch (err) {
      // Surface failures to the SPA as a query flag — never leak details/token.
      this.logger.warn(
        `github callback failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.redirect(`${appUrl}/integrations?error=github_connect_failed`);
    }
  }

  @Delete('github')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('integrations.disconnect')
  async disconnectGithub(@CurrentUser() user: User): Promise<void> {
    ensureCan(user, 'integrations.disconnect', { ownerId: user.id });
    await this.githubOauth.disconnect(user.id);
  }

  @Get('github/repos')
  async repos(@Query() query: ListReposDto, @CurrentUser() user: User) {
    ensureCan(user, 'integrations.read', { ownerId: user.id });
    return this.github.listRepos(user.id, {
      search: query.search,
      page: query.page,
    });
  }
}
