import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FindingLogsService } from './finding-logs.service';
import { FindingsController } from './findings.controller';
import { FindingsService } from './findings.service';

// Depends on deployments (authorization + the worker proxy for log capture) and
// on notifications (the Phase 1 inbox). Nothing depends on this module in
// return — the environments board counts open findings with its own aggregate
// rather than importing here, which is what keeps the graph acyclic.
@Module({
  imports: [AuthModule, DeploymentsModule, NotificationsModule],
  controllers: [FindingsController],
  providers: [FindingsService, FindingLogsService],
})
export class FindingsModule {}
