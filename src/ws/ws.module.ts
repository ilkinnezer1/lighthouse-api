import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ExecGateway } from './exec.gateway';
import { WsGateway } from './ws.gateway';

@Module({
  imports: [AuthModule, OutboxModule],
  providers: [WsGateway, ExecGateway],
})
export class WsModule {}
