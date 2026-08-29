import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { WIRE_UNSAFE_OMIT } from './wire-safety';

@Injectable()
export class PrismaService
  extends PrismaClient<{ adapter: PrismaPg; omit: typeof WIRE_UNSAFE_OMIT }>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
      }),
      // Keeps BigInt columns that nothing on the wire reads out of every
      // payload by default — see wire-safety.ts.
      omit: WIRE_UNSAFE_OMIT,
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected to database');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Disconnected from database');
  }
}
