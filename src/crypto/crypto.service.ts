import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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
}
