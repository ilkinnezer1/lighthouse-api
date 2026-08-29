import { findBigIntPaths, WIRE_UNSAFE_OMIT } from './wire-safety';

/** What the Prisma client's global omit does, driven by the real config. */
function applyOmit<T extends Record<string, unknown>>(
  row: T,
  model: keyof typeof WIRE_UNSAFE_OMIT,
): Record<string, unknown> {
  const kept: Record<string, unknown> = { ...row };
  for (const [column, dropped] of Object.entries(WIRE_UNSAFE_OMIT[model])) {
    if (dropped) delete kept[column];
  }
  return kept;
}

/**
 * `GET /deployments/:id` as Prisma returns it: `include: { environment: ... }`
 * pulls every environment scalar, `lastRequestCount` included.
 */
const rawEnvironment = {
  id: 'env-1',
  name: 'production',
  subdomain: 'production',
  active: true,
  hibernationEnabled: true,
  idleTimeoutMinutes: 240,
  lastRequestCount: 42n,
  lastActivityAt: new Date('2026-08-29T12:00:00.000Z'),
  hibernatedAt: null,
  project: { id: 'proj-1', name: 'lighthouse' },
};

const deploymentPayload = (environment: unknown) => ({
  id: 'dep-1',
  status: 'SUCCEEDED',
  createdAt: new Date('2026-08-29T11:00:00.000Z'),
  stages: [{ id: 'stage-1', ordinal: 1 }],
  services: [{ name: 'web', containerId: 'abc' }],
  environment,
  url: 'https://production.lighthouse.localhost',
});

describe('findBigIntPaths', () => {
  it('finds a BigInt nested anywhere', () => {
    expect(findBigIntPaths({ a: { b: { c: 1n } } })).toEqual(['a.b.c']);
    expect(findBigIntPaths([{ n: 2n }])).toEqual(['[0].n']);
    expect(findBigIntPaths(3n)).toEqual(['(root)']);
  });

  it('finds every one, not just the first', () => {
    expect(findBigIntPaths({ a: 1n, b: { c: 2n } }).sort()).toEqual([
      'a',
      'b.c',
    ]);
  });

  // Dates serialize fine via toJSON, and null must not be walked as an object.
  it('passes everything JSON can already handle', () => {
    expect(
      findBigIntPaths({
        d: new Date(),
        s: 'x',
        n: 1,
        b: true,
        nil: null,
        u: undefined,
        arr: [1, 'two', null],
      }),
    ).toEqual([]);
  });
});

describe('the deployment detail payload', () => {
  // Guards the guard: if this stops throwing, the fixture has drifted and the
  // test below would be proving nothing.
  it('is genuinely unserializable while the raw counter is on it', () => {
    const payload = deploymentPayload(rawEnvironment);

    expect(findBigIntPaths(payload)).toEqual(['environment.lastRequestCount']);
    expect(() => JSON.stringify(payload)).toThrow(/BigInt/);
  });

  // The regression. `GET /deployments/:id`, deployment create, redeploy and
  // rollback all reach a raw environment row through `include`, and every one
  // of them 500'd once the hibernation scheduler populated this column.
  it('survives JSON.stringify once the client omit is applied', () => {
    const payload = deploymentPayload(applyOmit(rawEnvironment, 'environment'));

    expect(findBigIntPaths(payload)).toEqual([]);
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it('keeps the rest of the environment the page reads', () => {
    const environment = applyOmit(rawEnvironment, 'environment');

    expect(environment).toMatchObject({
      id: 'env-1',
      name: 'production',
      subdomain: 'production',
      active: true,
    });
    expect('lastRequestCount' in environment).toBe(false);
  });
});
