import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { VolumeBackupsController } from './volume-backups.controller';
import { VolumeBackupsService } from './volume-backups.service';

@Module({
  imports: [AuthModule, QueueModule],
  controllers: [VolumeBackupsController],
  providers: [VolumeBackupsService],
  exports: [VolumeBackupsService],
})
export class VolumeBackupsModule {}
