import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';
import type { AuditService } from './audit.service';
import type { AuditEntry } from './audit.service';

const TOKEN = 'ghp_ARealLookingToken1234567890';

function run(
  body: Record<string, unknown>,
  response: unknown,
): Promise<AuditEntry> {
  const written: AuditEntry[] = [];
  const audit = {
    write: (entry: AuditEntry) => {
      written.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditService;

  const reflector = {
    getAllAndOverride: () => ({ action: 'integrations.credential_create' }),
  } as unknown as Reflector;

  const ctx = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({
        params: {},
        body,
        headers: {},
        ip: '127.0.0.1',
        user: { id: 'user-1' },
      }),
    }),
  } as unknown as ExecutionContext;

  const next = { handle: () => of(response) } as CallHandler;

  return new Promise((resolve, reject) => {
    new AuditInterceptor(reflector, audit).intercept(ctx, next).subscribe({
      next: () => undefined,
      error: reject,
      complete: () => resolve(written[0]),
    });
  });
}

// The credential endpoints put a live GitHub token in the request body, and
// this interceptor records request bodies AND response bodies into audit_log.
// If either survived, every stored token would sit in plaintext in a table
// built to be read by admins.
describe('AuditInterceptor redaction', () => {
  it('never records a token from the request body', async () => {
    const entry = await run({ token: TOKEN, label: 'laptop' }, { id: 'c-1' });
    const after = entry.afterJson as { body: Record<string, unknown> };

    expect(after.body.token).toBe('[REDACTED]');
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  it('keeps the harmless fields alongside it', async () => {
    const entry = await run({ token: TOKEN, label: 'laptop' }, { id: 'c-1' });
    const after = entry.afterJson as { body: Record<string, unknown> };

    expect(after.body.label).toBe('laptop');
    expect(entry.resourceId).toBe('c-1');
    expect(entry.action).toBe('integrations.credential_create');
  });

  it.each(['token', 'accessToken', 'secret', 'password', 'passwordHash'])(
    'redacts a %s key wherever it appears',
    async (key) => {
      const entry = await run({ [key]: TOKEN }, { nested: { [key]: TOKEN } });
      expect(JSON.stringify(entry)).not.toContain(TOKEN);
    },
  );
});
