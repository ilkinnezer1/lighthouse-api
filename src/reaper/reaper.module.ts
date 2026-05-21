import { Module } from '@nestjs/common';
import { ReaperService } from './reaper.service';

@Module({
  providers: [ReaperService],
})
export class ReaperModule {}
