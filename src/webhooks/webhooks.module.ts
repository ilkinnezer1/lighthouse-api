import { Module } from '@nestjs/common';
import { DeploymentsModule } from '../deployments/deployments.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { GithubModule } from '../github/github.module';
import { QueueModule } from '../queue/queue.module';
import { GithubWebhookController } from './github.controller';
import { GithubWebhookService } from './github.service';

@Module({
  imports: [DeploymentsModule, EnvironmentsModule, GithubModule, QueueModule],
  controllers: [GithubWebhookController],
  providers: [GithubWebhookService],
})
export class WebhooksModule {}
