import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { WsGateway } from './ws.gateway';

@Module({
  imports: [AuthModule, OutboxModule],
  providers: [WsGateway],
})
export class WsModule {}
