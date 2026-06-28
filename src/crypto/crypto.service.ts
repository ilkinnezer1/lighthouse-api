import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const raw = config.get('MASTER_ENCRYPTION_KEY', { infer: true });
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `MASTER_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}).`,
      );
    }
    this.key = key;
  }

  encrypt(plainText: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ct, tag]).toString('base64');
  }
  decrypt(payload: string): string {
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < IV_BYTES + TAG_BYTES) {
      throw new Error('ciphertext too short');
    }
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);

    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      'utf8',
    );
  }

  // High-entropy, URL-safe one-time secret (e.g. an invite link token). The
  // plaintext is shown to the caller once; only its hash is persisted.
  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  // Deterministic, peppered (HMAC under the master key) digest used to store and
  // look up a high-entropy token at rest. One-way: a leaked digest can't be
  // matched without the master key, and the plaintext token is never stored.
  hashToken(token: string): string {
    return createHmac('sha256', this.key).update(token).digest('hex');
  }
}
