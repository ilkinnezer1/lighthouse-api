import { findBigIntPaths } from '../prisma/wire-safety';
import {
  hibernationState,
  withHibernation,
  type HibernationColumns,
} from './environment-hibernation';

const awake: HibernationColumns = {
  hibernationEnabled: true,
  idleTimeoutMinutes: 240,
  lastActivityAt: new Date('2026-08-29T11:00:00.000Z'),
  hibernatedAt: null,
};

const asleep: HibernationColumns = {
  ...awake,
  hibernatedAt: new Date('2026-08-29T12:00:00.000Z'),
};

describe('hibernationState', () => {
  // `hibernatedAt != null` IS the sleeping state — the badge reads `sleeping`
  // rather than re-deriving it, so the two can never disagree.
  it('is sleeping exactly when hibernatedAt is set', () => {
    expect(hibernationState(awake).sleeping).toBe(false);
    expect(hibernationState(asleep).sleeping).toBe(true);
  });

  it('serializes both timestamps as ISO strings', () => {
    expect(hibernationState(asleep)).toEqual({
      enabled: true,
      idleTimeoutMinutes: 240,
      sleeping: true,
      hibernatedAt: '2026-08-29T12:00:00.000Z',
      lastActivityAt: '2026-08-29T11:00:00.000Z',
    });
  });

  // Unlike `lock`, this is never null: the toggle and the timeout have to
  // render on an environment nobody has ever opted in.
  it('still reports settings for an environment that has never been watched', () => {
    expect(
      hibernationState({
        hibernationEnabled: false,
        idleTimeoutMinutes: 60,
        lastActivityAt: null,
        hibernatedAt: null,
      }),
    ).toEqual({
      enabled: false,
      idleTimeoutMinutes: 60,
      sleeping: false,
      hibernatedAt: null,
      lastActivityAt: null,
    });
  });
});

describe('withHibernation', () => {
  it('replaces the raw columns with the serialized state', () => {
    const shaped = withHibernation({
      id: 'env-1',
      name: 'production',
      ...asleep,
    });

    expect(shaped).toEqual({
      id: 'env-1',
      name: 'production',
      hibernation: hibernationState(asleep),
    });
  });

  // The client omits this column globally, but the shaper drops it too so the
  // wire shape does not depend on that: it is a BigInt, and a BigInt anywhere
  // in a response is a 500 rather than a bad field.
  it('drops the request counter and leaves a JSON-serializable row', () => {
    const shaped = withHibernation({
      id: 'env-1',
      lastRequestCount: 42n,
      ...awake,
    });

    expect('lastRequestCount' in shaped).toBe(false);
    expect(findBigIntPaths(shaped)).toEqual([]);
    expect(() => JSON.stringify(shaped)).not.toThrow();
  });

  it('works on a row the client already omitted the counter from', () => {
    expect(withHibernation({ id: 'env-1', ...awake }).hibernation).toEqual(
      hibernationState(awake),
    );
  });
});
