import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VolumesController } from './volumes.controller';

@Module({
  imports: [AuthModule],
  controllers: [VolumesController],
})
export class VolumesModule {}
