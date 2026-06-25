import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Signed, expiring OAuth `state` for CSRF protection on the GitHub web flow.
// Pure + stateless so it is unit-testable without bootstrapping Nest: the only
// secret is MASTER_ENCRYPTION_KEY, read at call time. A dedicated HMAC key is
// derived from it for domain separation from the AES cipher that shares the key.

const STATE_TTL_MS = 10 * 60 * 1000;
const HMAC_DOMAIN = 'lighthouse:oauth-state:v1';

function signingKey(): Buffer {
  // Env is always present in prod (validated in config/env.ts); the empty
  // fallback only ever applies in unit tests, which need internal consistency,
  // not a real secret.
  const master = process.env.MASTER_ENCRYPTION_KEY ?? '';
  return createHmac('sha256', master).update(HMAC_DOMAIN).digest();
}

function sign(body: string): string {
  return createHmac('sha256', signingKey()).update(body).digest('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function signState(userId: string): string {
  const nonce = randomBytes(16).toString('hex');
  const exp = Date.now() + STATE_TTL_MS;
  const payload = `${userId}.${nonce}.${exp}`;
  const body = Buffer.from(payload, 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyState(token: string, userId: string): boolean {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!constantTimeEqual(sig, sign(body))) return false;

  const payload = Buffer.from(body, 'base64url').toString('utf8');
  const parts = payload.split('.');
  if (parts.length !== 3) return false;
  const [uid, , expStr] = parts;
  if (uid !== userId) return false;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  return true;
}
