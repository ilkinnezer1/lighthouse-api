import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ScheduledTasksModule } from './scheduled-tasks/scheduled-tasks.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AuthzModule } from './authz/authz.module';
import { BootstrapModule } from './bootstrap/bootstrap.module';
import { validateEnv } from './config/env';
import { CryptoModule } from './crypto/crypto.module';
import { GithubModule } from './github/github.module';
import { HealthModule } from './health/health.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { InvitationsModule } from './invitations/invitations.module';
import { OrgsModule } from './orgs/orgs.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { ReaperModule } from './reaper/reaper.module';
import { RedisModule } from './redis/redis.module';
import { QueueModule } from './queue/queue.module';
import { DatabasesModule } from './databases/databases.module';
import { EnvVarsModule } from './env-vars/env-vars.module';
import { ManagedFilesModule } from './managed-files/managed-files.module';
import { VolumesModule } from './volumes/volumes.module';
import { SnapshotsModule } from './snapshots/snapshots.module';
import { DeploymentsModule } from './deployments/deployments.module';
import { OutboxModule } from './outbox/outbox.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WsModule } from './ws/ws.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
    }),
    ScheduleModule.forRoot(),
    ScheduledTasksModule,
    PrismaModule,
    RedisModule,
    AuthzModule,
    AuditModule,
    AuthModule,
    ProjectsModule,
    OrgsModule,
    InvitationsModule,
    BootstrapModule,
    QueueModule,
    DatabasesModule,
    EnvVarsModule,
    ManagedFilesModule,
    VolumesModule,
    SnapshotsModule,
    DeploymentsModule,
    OutboxModule,
    GithubModule,
    IntegrationsModule,
    WebhooksModule,
    WsModule,
    HealthModule,
    CryptoModule,
    ReaperModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
