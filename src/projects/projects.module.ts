import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GithubModule } from '../github/github.module';
import { JiraModule } from '../jira/jira.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [AuthModule, GithubModule, JiraModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
