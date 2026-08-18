import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GithubModule } from '../github/github.module';
import { JiraModule } from '../jira/jira.module';
import { QueueModule } from '../queue/queue.module';
import { DeploymentAccessService } from './deployment-access.service';
import { DeploymentActionsController } from './deployment-actions.controller';
import { DeploymentBranchesService } from './deployment-branches.service';
import { DeploymentServicesController } from './deployment-services.controller';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';
import { WorkerProxyService } from './worker-proxy.service';

@Module({
  imports: [AuthModule, QueueModule, GithubModule, JiraModule],
  controllers: [
    DeploymentsController,
    DeploymentServicesController,
    DeploymentActionsController,
  ],
  providers: [
    DeploymentsService,
    DeploymentBranchesService,
    DeploymentAccessService,
    WorkerProxyService,
  ],
  exports: [DeploymentsService],
})
export class DeploymentsModule {}
