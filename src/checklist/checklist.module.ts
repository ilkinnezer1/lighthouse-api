import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { FindingsModule } from '../findings/findings.module';
import { ChecklistController } from './checklist.controller';
import { ChecklistService } from './checklist.service';

// Depends on deployments (authorization + the change range it seeds from) and
// on findings (a FAIL files one through the service that owns filing). Nothing
// depends on this module in return — the environments board counts its own
// progress with an aggregate, which is what keeps the graph acyclic.
@Module({
  imports: [AuthModule, DeploymentsModule, FindingsModule],
  controllers: [ChecklistController],
  providers: [ChecklistService],
})
export class ChecklistModule {}
