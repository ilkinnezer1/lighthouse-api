import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ExecGateway } from './exec.gateway';
import { NotificationsGateway } from './notifications.gateway';
import { WsGateway } from './ws.gateway';

@Module({
  imports: [AuthModule, OutboxModule, NotificationsModule],
  providers: [WsGateway, ExecGateway, NotificationsGateway],
})
export class WsModule {}
