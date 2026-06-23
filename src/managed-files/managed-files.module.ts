import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ManagedFilesController } from './managed-files.controller';
import { ManagedFilesService } from './managed-files.service';

@Module({
  imports: [AuthModule],
  controllers: [ManagedFilesController],
  providers: [ManagedFilesService],
  exports: [ManagedFilesService],
})
export class ManagedFilesModule {}
