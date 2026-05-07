import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { LogEmitter, toLogEntry } from './log-entry';
import { logsStreamKey, XREAD_BLOCK_MS } from './ws.constants';

// One per active deployment. Tails Redis Stream `deploy:{id}:logs` and
// calls `emit` for every new entry. Owns a dedicated Redis connection
// because XREAD BLOCK monopolises the socket for the duration of the wait.
export class LogTailer {
  private readonly logger: Logger;
  private readonly redis: Redis;
  private readonly abort = new AbortController();
  private cursor = '$'; // start from "only new entries"

  constructor(
    private readonly deploymentId: string,
    redisUrl: string,
    private readonly emit: LogEmitter,
  ) {
    this.redis = new Redis(redisUrl);
    this.logger = new Logger(`LogTailer:${deploymentId.slice(0, 8)}`);
  }

  start(): void {
    void this.loop().catch((err) =>
      this.logger.error(`crashed: ${(err as Error).message}`),
    );
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.redis.quit();
  }

  private async loop(): Promise<void> {
    const stream = logsStreamKey(this.deploymentId);
    while (!this.abort.signal.aborted) {
      const reply = await this.redis.xread(
        'BLOCK',
        XREAD_BLOCK_MS,
        'STREAMS',
        stream,
        this.cursor,
      );
      if (!reply) continue; // BLOCK timeout; re-check abort and loop
      for (const [, entries] of reply) {
        for (const [id, fields] of entries) {
          this.cursor = id;
          this.emit(toLogEntry(id, fields));
        }
      }
    }
  }
}
