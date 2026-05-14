import { Module } from '@nestjs/common';
import { DeploymentsModule } from '../deployments/deployments.module';
import { QueueModule } from '../queue/queue.module';
import { GithubWebhookController } from './github.controller';
import { GithubWebhookService } from './github.service';

@Module({
  imports: [DeploymentsModule, QueueModule],
  controllers: [GithubWebhookController],
  providers: [GithubWebhookService],
})
export class WebhooksModule {}
