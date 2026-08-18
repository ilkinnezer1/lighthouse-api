import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GithubModule } from '../github/github.module';
import { JiraModule } from '../jira/jira.module';
import { AtlassianOauthService } from './atlassian-oauth.service';
import { GithubOauthService } from './github-oauth.service';
import { IntegrationsController } from './integrations.controller';

@Module({
  imports: [AuthModule, GithubModule, JiraModule],
  controllers: [IntegrationsController],
  providers: [GithubOauthService, AtlassianOauthService],
})
export class IntegrationsModule {}
