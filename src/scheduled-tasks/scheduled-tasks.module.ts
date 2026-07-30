import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ScheduledTasksController } from './scheduled-tasks.controller';
import { ScheduledTasksRunner } from './scheduled-tasks.runner';
import { ScheduledTasksScheduler } from './scheduled-tasks.scheduler';
import { ScheduledTasksService } from './scheduled-tasks.service';

@Module({
  imports: [AuthModule],
  controllers: [ScheduledTasksController],
  providers: [
    ScheduledTasksService,
    ScheduledTasksRunner,
    ScheduledTasksScheduler,
  ],
  exports: [ScheduledTasksService],
})
export class ScheduledTasksModule {}
