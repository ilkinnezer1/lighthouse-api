import { Module } from '@nestjs/common';
import { OutboxEvents } from './outbox.events';
import { OutboxService } from './outbox.service';

@Module({
  providers: [OutboxEvents, OutboxService],
  exports: [OutboxEvents],
})
export class OutboxModule {}
