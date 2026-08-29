import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GithubModule } from '../github/github.module';
import { JiraModule } from '../jira/jira.module';
import { AtlassianOauthService } from './atlassian-oauth.service';
import { GitCredentialsService } from './git-credentials.service';
import { GithubOauthService } from './github-oauth.service';
import { IntegrationsController } from './integrations.controller';
import { OrgGitCredentialsController } from './org-git-credentials.controller';

@Module({
  imports: [AuthModule, GithubModule, JiraModule],
  controllers: [IntegrationsController, OrgGitCredentialsController],
  providers: [GithubOauthService, AtlassianOauthService, GitCredentialsService],
})
export class IntegrationsModule {}
