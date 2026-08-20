import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EnvironmentLocksService } from './environment-locks.service';
import { EnvironmentsController } from './environments.controller';
import { EnvironmentsService } from './environments.service';

@Module({
  imports: [AuthModule],
  controllers: [EnvironmentsController],
  providers: [EnvironmentsService, EnvironmentLocksService],
  exports: [EnvironmentLocksService],
})
export class EnvironmentsModule {}
