import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GithubModule } from '../github/github.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [AuthModule, GithubModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
