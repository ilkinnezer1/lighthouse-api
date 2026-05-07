import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxEvents } from './outbox.events';

const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 100;

interface RawRow {
  id: bigint;
  type: string;
  user_id: string | null;
  payload: unknown;
}

@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: OutboxEvents,
  ) {}

  onModuleInit(): void {
    this.scheduleNext();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  /**
   * Single drain tick. Guarded against overlap by the `running` flag,
   * if a previous drain is somehow still in flight (e.g., DB hang), we
   * skip this tick. The next setTimeout still fires regardless, so the
   * loop self-heals once the slow tick finishes.
   */
  private async tick(): Promise<void> {
    if (this.running) {
      this.scheduleNext();
      return;
    }
    this.running = true;
    try {
      await this.drain();
    } catch (err) {
      this.logger.error('drain failed', err);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  /**
   * One transactional batch:
   *   1. SELECT FOR UPDATE SKIP LOCKED — claim up to BATCH_SIZE rows
   *   2. .next() each row onto the in-process Subject
   *   3. UPDATE drained_at = NOW() for the claimed rows
   * Steps 2 and 3 happen inside the same TX so that crash-between-emit-and-commit causes the row to stay undrained and re-fire on the next
   * tick (at-least-once delivery). Subscribers must dedupe on `id`.
   */
  private async drain(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RawRow[]>`
                SELECT id, type, user_id, payload
                FROM event_outbox
                WHERE drained_at IS NULL
                ORDER BY id
                LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
            `;
      if (rows.length === 0) return;

      for (const row of rows) {
        this.events.events$.next({
          id: row.id.toString(),
          type: row.type,
          userId: row.user_id,
          payload: row.payload,
        });
      }

      await tx.eventOutbox.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { drainedAt: new Date() },
      });

      this.logger.debug(`drained ${rows.length} event(s)`);
    });
  }
}
