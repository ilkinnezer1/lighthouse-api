import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGithubSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false;

  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();

  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
