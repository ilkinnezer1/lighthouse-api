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

export interface BoundedText {
  text: string;
  /** True when `maxBytes` forced older output to be dropped. */
  truncated: boolean;
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

  /**
   * Reads a worker response as text under a hard byte cap, keeping the TAIL
   * rather than the head: this exists for log snapshots, where the newest lines
   * are the ones worth having. Memory stays bounded at roughly `maxBytes`
   * regardless of how much the container decides to print.
   */
  async text(
    path: string,
    init: RequestInit,
    errors: WorkerErrors,
    maxBytes: number,
  ): Promise<BoundedText> {
    const upstream = await this.request(path, init, errors);
    if (!upstream.body) return { text: '', truncated: false };

    const reader = upstream.body.getReader();
    const chunks: Buffer[] = [];
    let held = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        held += value.byteLength;
        while (chunks.length > 1 && held - chunks[0].byteLength >= maxBytes) {
          held -= chunks[0].byteLength;
          chunks.shift();
          truncated = true;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    let buf = Buffer.concat(chunks);
    if (buf.byteLength > maxBytes) {
      buf = buf.subarray(buf.byteLength - maxBytes);
      truncated = true;
    }
    return { text: buf.toString('utf8'), truncated };
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
