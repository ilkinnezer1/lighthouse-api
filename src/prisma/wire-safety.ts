import type { Prisma } from '@prisma/client';

/**
 * Columns stripped from every Prisma result by default.
 *
 * `Environment.lastRequestCount` is a BigInt, and Express's JSON serializer
 * throws `TypeError: Do not know how to serialize a BigInt` — so any endpoint
 * whose payload reaches a raw environment row 500s the moment the column holds
 * a value. That is not hypothetical: `deployments.service.ts` reaches one
 * through `include: { environment: ... }` on four routes (deployment detail,
 * create, redeploy, rollback), and the hibernation scheduler populates the
 * column for every environment Traefik has routed a request to.
 *
 * Omitting it on the client rather than at each call site is deliberate. The
 * column has NO reader on the wire — it is a measurement the scheduler keeps
 * for itself — so removing it globally cannot break a consumer, and it makes
 * the next `include` that reaches an environment safe by construction instead
 * of leaving the failure to be found in a browser. The two readers that do
 * need it ask for it explicitly, which still works:
 *
 *   select: { lastRequestCount: true }   // hibernation.scheduler.ts
 *   omit:   { lastRequestCount: false }
 *
 * The other BigInt columns are deliberately NOT here. `sizeBytes` on
 * volume backups and database snapshots is shown to the user, and each service
 * narrows it on the way out (a Number, or a decimal string). A column with a
 * reader has to be converted; a column with none should never leave the DB.
 */
export const WIRE_UNSAFE_OMIT = {
  environment: { lastRequestCount: true },
} as const satisfies Prisma.GlobalOmitConfig;

/**
 * Every path in `value` holding a BigInt — empty when the value can survive
 * `JSON.stringify`. Exists for the regression test that pins the omit above.
 */
export function findBigIntPaths(value: unknown, path = ''): string[] {
  if (typeof value === 'bigint') return [path || '(root)'];
  if (value === null || typeof value !== 'object') return [];
  if (value instanceof Date) return [];

  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findBigIntPaths(item, `${path}[${i}]`));
  }
  return Object.entries(value).flatMap(([key, item]) =>
    findBigIntPaths(item, path ? `${path}.${key}` : key),
  );
}
