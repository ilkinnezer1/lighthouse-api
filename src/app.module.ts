import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BootstrapModule } from './bootstrap/bootstrap.module';
import { validateEnv } from './config/env';
import { CryptoModule } from './crypto/crypto.module';
import { GithubModule } from './github/github.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { ReaperModule } from './reaper/reaper.module';
import { RedisModule } from './redis/redis.module';
import { QueueModule } from './queue/queue.module';
import { DatabasesModule } from './databases/databases.module';
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
    PrismaModule,
    RedisModule,
    AuditModule,
    AuthModule,
    ProjectsModule,
    BootstrapModule,
    QueueModule,
    DatabasesModule,
    SnapshotsModule,
    DeploymentsModule,
    OutboxModule,
    GithubModule,
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
