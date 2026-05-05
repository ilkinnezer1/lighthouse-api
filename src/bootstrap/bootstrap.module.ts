import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BootstrapService } from './bootstrap.service';

@Module({
  imports: [AuthModule],
  providers: [BootstrapService],
})
export class BootstrapModule {}
