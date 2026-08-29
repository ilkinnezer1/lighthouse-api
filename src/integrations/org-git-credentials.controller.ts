import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthzService } from '../authz/authz.service';
import { CreateGitCredentialDto } from './dto/create-git-credential.dto';
import { UpdateGitCredentialPolicyDto } from './dto/update-git-credential-policy.dto';
import {
  GitCredentialsService,
  type GitCredentialView,
} from './git-credentials.service';

/**
 * The organization's GitHub credential — the account every member's deploys
 * clone and comment as — plus the switch deciding whether members may add
 * their own at all.
 *
 * All of it is `git.manage` (admin/owner), for the reason `jira.manage` is:
 * it is one setting every member's work silently depends on.
 */
@Controller('orgs')
@UseGuards(JwtAuthGuard)
export class OrgGitCredentialsController {
  constructor(
    private readonly gitCredentials: GitCredentialsService,
    private readonly authz: AuthzService,
  ) {}

  @Get(':id/git-credentials')
  async list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ): Promise<GitCredentialView[]> {
    await this.authz.ensureCan(user, 'git.manage', { organizationId: id });
    return this.gitCredentials.listForOrg(id);
  }

  @Post(':id/git-credentials')
  @Audit('orgs.git-credential-create')
  async create(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateGitCredentialDto,
    @CurrentUser() user: User,
  ): Promise<GitCredentialView> {
    await this.authz.ensureCan(user, 'git.manage', { organizationId: id });
    return this.gitCredentials.createForOrg(id, user.id, dto);
  }

  @Delete(':id/git-credentials/:credId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('orgs.git-credential-delete')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credId', new ParseUUIDPipe()) credId: string,
    @CurrentUser() user: User,
  ): Promise<void> {
    await this.authz.ensureCan(user, 'git.manage', { organizationId: id });
    await this.gitCredentials.removeForOrg(id, credId);
  }

  @Put(':id/git-credentials/policy')
  @Audit('orgs.git-policy-update')
  async setPolicy(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateGitCredentialPolicyDto,
    @CurrentUser() user: User,
  ): Promise<{ allowMemberGitCredentials: boolean }> {
    await this.authz.ensureCan(user, 'git.manage', { organizationId: id });
    return this.gitCredentials.setMemberPolicy(
      id,
      dto.allowMemberGitCredentials,
    );
  }
}
