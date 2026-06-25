import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GithubModule } from '../github/github.module';
import { GithubOauthService } from './github-oauth.service';
import { IntegrationsController } from './integrations.controller';

@Module({
  imports: [AuthModule, GithubModule],
  controllers: [IntegrationsController],
  providers: [GithubOauthService],
})
export class IntegrationsModule {}
