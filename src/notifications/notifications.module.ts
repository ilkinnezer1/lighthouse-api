import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { NotificationsConsumer } from './notifications.consumer';
import { NotificationsController } from './notifications.controller';
import { NotificationDispatcher } from './notifications.dispatcher';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [AuthModule, OutboxModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationDispatcher,
    NotificationsConsumer,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
