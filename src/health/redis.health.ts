import { Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { Redis } from 'ioredis';
import { InjectRedis } from '../redis/redis.constants';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        return indicator.down({ message: `Unexpected ping response: ${pong}` });
      }
      return indicator.up();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return indicator.down({ message });
    }
  }
}
