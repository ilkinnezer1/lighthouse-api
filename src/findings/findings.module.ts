import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FindingLogsService } from './finding-logs.service';
import { FindingsController } from './findings.controller';
import { FindingsService } from './findings.service';

// Depends on deployments (authorization + the worker proxy for log capture) and
// on notifications (the Phase 1 inbox). The environments board still counts open
// findings with its own aggregate rather than importing here; `FindingsService`
// is exported for the checklist, whose failed checks file through it so log
// capture and the inbox happen in exactly one place.
@Module({
  imports: [AuthModule, DeploymentsModule, NotificationsModule],
  controllers: [FindingsController],
  providers: [FindingsService, FindingLogsService],
  exports: [FindingsService],
})
export class FindingsModule {}
