import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GithubModule } from '../github/github.module';
import { QueueModule } from '../queue/queue.module';
import { DeploymentBranchesService } from './deployment-branches.service';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';

@Module({
  imports: [AuthModule, QueueModule, GithubModule],
  controllers: [DeploymentsController],
  providers: [DeploymentsService, DeploymentBranchesService],
  exports: [DeploymentsService],
})
export class DeploymentsModule {}
