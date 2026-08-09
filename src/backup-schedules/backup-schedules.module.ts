import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { VolumeBackupsModule } from '../volume-backups/volume-backups.module';
import { BackupSchedulesController } from './backup-schedules.controller';
import { BackupSchedulesScheduler } from './backup-schedules.scheduler';
import { BackupSchedulesService } from './backup-schedules.service';

@Module({
  imports: [AuthModule, QueueModule, SnapshotsModule, VolumeBackupsModule],
  controllers: [BackupSchedulesController],
  providers: [BackupSchedulesService, BackupSchedulesScheduler],
})
export class BackupSchedulesModule {}
