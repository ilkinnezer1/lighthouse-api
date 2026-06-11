import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EnvVarsController } from './env-vars.controller';
import { EnvVarsService } from './env-vars.service';

@Module({
  imports: [AuthModule],
  controllers: [EnvVarsController],
  providers: [EnvVarsService],
  exports: [EnvVarsService],
})
export class EnvVarsModule {}
