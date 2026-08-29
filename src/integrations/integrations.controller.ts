import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
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
import {
  AtlassianOauthService,
  type AtlassianConnection,
} from './atlassian-oauth.service';
import { CreateGitCredentialDto } from './dto/create-git-credential.dto';
import { ListReposDto } from './dto/list-repos.dto';
import {
  GitCredentialsService,
  type GitCredentialView,
} from './git-credentials.service';
import { GithubOauthService, type Connection } from './github-oauth.service';

export type IntegrationProvider = 'github' | 'atlassian';

export interface ProviderStatus {
  /**
   * Whether the operator has set this provider's OAuth credentials.
   *
   * False is not "not connected" — it means `/{provider}/connect` can only
   * ever 503, so the client has to show the provider as unavailable instead of
   * offering a Connect button that dead-ends on raw JSON outside the SPA.
   * A boolean and nothing else — the credentials themselves have no business
   * in a status payload.
   */
  configured: boolean;
}

export interface IntegrationsOverview {
  connections: (Connection | AtlassianConnection)[];
  providers: Record<IntegrationProvider, ProviderStatus>;
  /**
   * The caller's stored PATs. A token authenticates GitHub on its own, so a
   * user can be usable here with `providers.github.configured` false — the page
   * has to be able to say "connected via token" rather than "not connected".
   * Same view the dedicated endpoint returns, so the two cannot drift.
   */
  gitCredentials: GitCredentialView[];
}

@Controller('integrations')
@UseGuards(JwtAuthGuard)
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(
    private readonly githubOauth: GithubOauthService,
    private readonly atlassianOauth: AtlassianOauthService,
    private readonly gitCredentials: GitCredentialsService,
    private readonly github: GithubApiService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get()
  async list(@CurrentUser() user: User): Promise<IntegrationsOverview> {
    ensureSelf(user, user.id);
    const [github, atlassian, gitCredentials] = await Promise.all([
      this.githubOauth.listConnections(user.id),
      this.atlassianOauth.listConnections(user.id),
      this.gitCredentials.list(user.id),
    ]);
    return {
      connections: [...github, ...atlassian],
      providers: {
        github: { configured: this.githubOauth.isConfigured() },
        atlassian: { configured: this.atlassianOauth.isConfigured() },
      },
      gitCredentials,
    };
  }

  /**
   * Store a Personal Access Token. The token is verified against GitHub before
   * it is written, and never appears in the response — which matters twice
   * over, because the audit interceptor records response bodies.
   */
  @Post('git-credentials')
  @Audit('integrations.credential_create')
  createGitCredential(
    @Body() dto: CreateGitCredentialDto,
    @CurrentUser() user: User,
  ): Promise<GitCredentialView> {
    ensureSelf(user, user.id);
    return this.gitCredentials.create(user.id, dto);
  }

  @Get('git-credentials')
  listGitCredentials(@CurrentUser() user: User): Promise<GitCredentialView[]> {
    ensureSelf(user, user.id);
    return this.gitCredentials.list(user.id);
  }

  @Delete('git-credentials/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('integrations.credential_delete')
  async deleteGitCredential(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    ensureSelf(user, user.id);
    await this.gitCredentials.remove(user.id, id);
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
