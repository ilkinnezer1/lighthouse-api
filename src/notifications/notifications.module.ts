import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { InboxConsumer } from './inbox.consumer';
import { InboxController } from './inbox.controller';
import { InboxEvents } from './inbox.events';
import { InboxService } from './inbox.service';
import { NotificationsConsumer } from './notifications.consumer';
import { NotificationsController } from './notifications.controller';
import { NotificationDispatcher } from './notifications.dispatcher';
import { NotificationsService } from './notifications.service';

// Two consumers of the same outbox: NotificationsConsumer shouts into an
// org-wide channel, InboxConsumer addresses one person.
@Module({
  imports: [AuthModule, OutboxModule],
  controllers: [NotificationsController, InboxController],
  providers: [
    NotificationsService,
    NotificationDispatcher,
    NotificationsConsumer,
    InboxEvents,
    InboxService,
    InboxConsumer,
  ],
  exports: [NotificationsService, InboxEvents],
})
export class NotificationsModule {}
