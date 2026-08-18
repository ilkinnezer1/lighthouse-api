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
import { ensureSelf } from '../common/authz';
import { Env } from '../config/env';
import { GithubApiService } from '../github/github-api.service';
import { AtlassianOauthService } from './atlassian-oauth.service';
import { ListReposDto } from './dto/list-repos.dto';
import { GithubOauthService } from './github-oauth.service';

@Controller('integrations')
@UseGuards(JwtAuthGuard)
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(
    private readonly githubOauth: GithubOauthService,
    private readonly atlassianOauth: AtlassianOauthService,
    private readonly github: GithubApiService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get()
  async list(@CurrentUser() user: User) {
    ensureSelf(user, user.id);
    const [github, atlassian] = await Promise.all([
      this.githubOauth.listConnections(user.id),
      this.atlassianOauth.listConnections(user.id),
    ]);
    return { connections: [...github, ...atlassian] };
  }

  @Get('github/connect')
  @Audit('integrations.connect')
  githubConnect(@CurrentUser() user: User, @Res() res: Response): void {
    ensureSelf(user, user.id);
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
    ensureSelf(user, user.id);
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
    ensureSelf(user, user.id);
    await this.githubOauth.disconnect(user.id);
  }

  @Get('github/repos')
  async repos(@Query() query: ListReposDto, @CurrentUser() user: User) {
    ensureSelf(user, user.id);
    return this.github.listRepos(user.id, {
      search: query.search,
      page: query.page,
    });
  }

  @Get('atlassian/connect')
  @Audit('integrations.connect')
  atlassianConnect(@CurrentUser() user: User, @Res() res: Response): void {
    ensureSelf(user, user.id);
    if (!this.atlassianOauth.isConfigured()) {
      throw new ServiceUnavailableException(
        'Atlassian integration not configured',
      );
    }
    res.redirect(this.atlassianOauth.authorizeUrl(user.id));
  }

  @Get('atlassian/callback')
  @Audit('integrations.connect')
  async atlassianCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @CurrentUser() user: User,
    @Res() res: Response,
  ): Promise<void> {
    ensureSelf(user, user.id);
    const appUrl = this.config.get('PUBLIC_APP_URL', { infer: true });
    try {
      if (!code || !state) {
        throw new BadRequestException('Missing code or state');
      }
      await this.atlassianOauth.handleCallback(user.id, code, state);
      res.redirect(`${appUrl}/integrations?connected=atlassian`);
    } catch (err) {
      // Surface failures to the SPA as a query flag — never leak details/token.
      this.logger.warn(
        `atlassian callback failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.redirect(`${appUrl}/integrations?error=atlassian_connect_failed`);
    }
  }

  @Delete('atlassian')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('integrations.disconnect')
  async disconnectAtlassian(@CurrentUser() user: User): Promise<void> {
    ensureSelf(user, user.id);
    await this.atlassianOauth.disconnect(user.id);
  }
}
