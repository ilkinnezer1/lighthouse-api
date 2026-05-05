import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { InjectRedis } from '../redis/redis.constants';
import {
  BUILD_QUEUE_STREAM,
  FIELD_DEPLOYMENT_ID,
  cancelChannel,
} from './queue.constants';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async enqueueBuild(deploymentId: string): Promise<string> {
    const entryId = await this.redis.xadd(
      BUILD_QUEUE_STREAM,
      '*',
      FIELD_DEPLOYMENT_ID,
      deploymentId,
    );

    if (!entryId) {
      throw new Error('XADD returned no entry ID');
    }
    this.logger.debug(`enqueued build ${deploymentId} as ${entryId}`);

    return entryId;
  }

  async publishCancel(deploymentId: string): Promise<number> {
    const subs = await this.redis.publish(cancelChannel(deploymentId), '1');
    this.logger.debug(
      `cancel ${deploymentId} delivered to ${subs} subscriber(s)`,
    );
    return subs;
  }
}
