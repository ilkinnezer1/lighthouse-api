import { Module } from '@nestjs/common';
import { DeploymentsModule } from '../deployments/deployments.module';
import { GithubWebhookController } from './github.controller';
import { GithubWebhookService } from './github.service';

@Module({
  imports: [DeploymentsModule],
  controllers: [GithubWebhookController],
  providers: [GithubWebhookService],
})
export class WebhooksModule {}
