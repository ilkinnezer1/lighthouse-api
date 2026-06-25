import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { AuditQueryService } from './audit-query.service';
import { AuditController } from './audit.controller';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditQueryService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
