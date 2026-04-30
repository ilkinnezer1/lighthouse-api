import { Global, Inject, Logger, Module, OnModuleDestroy, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env';
import { REDIS_CLIENT } from './redis.constants';

const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (config: ConfigService<Env, true>) => {
    const logger = new Logger('RedisClient');
    const client = new Redis(config.get('REDIS_URL', { infer: true }));
    client.on('connect', () => logger.log('Connected to Redis'));
    client.on('error', (err) => logger.error('Redis error', err));
    return client;
  },
  inject: [ConfigService],
};

@Global()
@Module({
  providers: [redisProvider],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy() {
    await this.redis.quit();
  }
}
