import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

/**
 * Shape emitted on every drained row. `id` is stringified so it's safe
 * to JSON.serialize over the wire.
 */
export interface OutboxEvent {
  id: string;
  type: string; // 'deploy.succeeded' | 'deploy.failed' | ...
  userId: string | null; // recipient; null = system event
  payload: unknown; // shape depends on `type`; consumer narrows
}

@Injectable()
export class OutboxEvents {
  readonly events$ = new Subject<OutboxEvent>();
}
