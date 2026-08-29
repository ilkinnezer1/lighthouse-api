import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { EnvironmentHibernationService } from './environment-hibernation.service';
import { EnvironmentLocksService } from './environment-locks.service';
import { EnvironmentsController } from './environments.controller';
import { EnvironmentsService } from './environments.service';
import { HibernationWakeConsumer } from './hibernation-wake.consumer';
import { HibernationScheduler } from './hibernation.scheduler';

@Module({
  imports: [AuthModule, OutboxModule],
  controllers: [EnvironmentsController],
  providers: [
    EnvironmentsService,
    EnvironmentLocksService,
    EnvironmentHibernationService,
    HibernationScheduler,
    HibernationWakeConsumer,
  ],
  exports: [EnvironmentLocksService],
})
export class EnvironmentsModule {}
