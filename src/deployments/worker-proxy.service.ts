import {
  BadGatewayException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { Env } from '../config/env';

export interface WorkerErrors {
  notFound: string;
  failed: string;
}

@Injectable()
export class WorkerProxyService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async json<T>(
    path: string,
    init: RequestInit,
    errors: WorkerErrors,
  ): Promise<T> {
    const resp = await this.request(path, init, errors);
    return (await resp.json()) as T;
  }

  async stream(
    res: Response,
    path: string,
    init: RequestInit,
    errors: WorkerErrors,
  ): Promise<void> {
    const upstream = await this.request(path, init, errors);
    if (!upstream.body) {
      throw new BadGatewayException(errors.failed);
    }

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Disable proxy buffering (nginx/Traefik) so tailed lines flush live.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          // A destroyed socket never emits 'drain', so 'close' must settle this too.
          const flushed = await new Promise<boolean>((resolve) => {
            const onDrain = () => {
              res.off('close', onClose);
              resolve(true);
            };
            const onClose = () => {
              res.off('drain', onDrain);
              resolve(false);
            };
            res.once('drain', onDrain);
            res.once('close', onClose);
          });
          if (!flushed) break;
        }
      }
    } catch {
      // Client disconnect / upstream abort — nothing actionable.
    } finally {
      await reader.cancel().catch(() => undefined);
      res.end();
    }
  }

  // The worker is the authority on whether a live container exists, so its 404
  // is surfaced verbatim rather than guessed at from local state.
  private async request(
    path: string,
    init: RequestInit,
    errors: WorkerErrors,
  ): Promise<globalThis.Response> {
    const base = this.config.get('WORKER_HTTP_URL', { infer: true });

    let resp: globalThis.Response;
    try {
      resp = await fetch(`${base}${path}`, init);
    } catch {
      throw new BadGatewayException('Worker unreachable');
    }
    if (resp.status === 404) {
      throw new NotFoundException(errors.notFound);
    }
    if (!resp.ok) {
      throw new BadGatewayException(errors.failed);
    }
    return resp;
  }
}
