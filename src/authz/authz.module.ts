import { Global, Module } from '@nestjs/common';
import { AuthzService } from './authz.service';

// Global so any controller/gateway can authorize without re-importing. Relies
// on the (also global) PrismaModule for the membership lookup.
@Global()
@Module({
  providers: [AuthzService],
  exports: [AuthzService],
})
export class AuthzModule {}
