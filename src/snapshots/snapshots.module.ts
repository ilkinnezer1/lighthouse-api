import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabasesModule } from '../databases/databases.module';
import { QueueModule } from '../queue/queue.module';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';

@Module({
  imports: [AuthModule, DatabasesModule, QueueModule],
  controllers: [SnapshotsController],
  providers: [SnapshotsService],
  exports: [SnapshotsService],
})
export class SnapshotsModule {}
