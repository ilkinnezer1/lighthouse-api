import {
  decideHibernation,
  resolveActivity,
  type HibernationVetoes,
  type IdleInput,
} from './hibernation-decision';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

const activity = (over: Partial<Parameters<typeof resolveActivity>[0]> = {}) =>
  resolveActivity({
    lastRequestCount: 5,
    observedRequestCount: 5,
    lastActivityAt: minutesAgo(10),
    now: NOW,
    ...over,
  });

const CLEAR: HibernationVetoes = {
  enabled: true,
  locked: false,
  deploymentInFlight: false,
  hasRunningDeployment: true,
};

type DecideOverrides = Partial<Omit<IdleInput, 'vetoes'>> & {
  vetoes?: Partial<HibernationVetoes>;
};

const decide = ({ vetoes, ...rest }: DecideOverrides = {}) =>
  decideHibernation({
    lastRequestCount: 5,
    observedRequestCount: 5,
    lastActivityAt: minutesAgo(300),
    idleTimeoutMinutes: 240,
    now: NOW,
    ...rest,
    vetoes: { ...CLEAR, ...vetoes },
  });

describe('resolveActivity', () => {
  describe('an absent series is not a count of zero', () => {
    // Traefik sweeps a stopped container's series out of /metrics entirely,
    // and a never-visited deployment never had one. Reading either as 0 trips
    // the reset rule on every poll, and the environment never sleeps — the
    // feature failing while looking like it works.
    it('writes nothing and leaves the idle clock running', () => {
      const activeAt = minutesAgo(10);
      expect(
        activity({ observedRequestCount: null, lastActivityAt: activeAt }),
      ).toEqual({ reason: 'no-observation', patch: null, activeAt });
    });

    it('stays hibernatable once the timeout elapses', () => {
      expect(
        decide({
          observedRequestCount: null,
          lastRequestCount: 5,
          lastActivityAt: minutesAgo(241),
        }),
      ).toMatchObject({
        reason: 'no-observation',
        patch: null,
        hibernate: true,
      });
    });

    it('never refreshes lastActivityAt, poll after poll', () => {
      for (const elapsed of [10, 100, 239, 241]) {
        expect(
          activity({
            observedRequestCount: null,
            lastActivityAt: minutesAgo(elapsed),
          }).patch,
        ).toBeNull();
      }
    });
  });

  describe('counter resets', () => {
    // Traefik restarting, or the container coming back, zeroes the counter and
    // it reads 1 again because a request arrived. That is activity, not
    // silence, and a delta across it would be a negative number.
    it('rebases to the observed value and stamps activity', () => {
      expect(
        activity({ lastRequestCount: 500, observedRequestCount: 1 }),
      ).toEqual({
        reason: 'counter-reset',
        patch: { lastRequestCount: 1, lastActivityAt: NOW },
        activeAt: NOW,
      });
    });

    it('treats a present zero as a reset, unlike an absent series', () => {
      expect(
        activity({ lastRequestCount: 9, observedRequestCount: 0 }).reason,
      ).toBe('counter-reset');
    });

    it('never hibernates on the tick it saw a reset', () => {
      expect(
        decide({
          lastRequestCount: 500,
          observedRequestCount: 1,
          lastActivityAt: minutesAgo(9999),
        }),
      ).toMatchObject({
        reason: 'counter-reset',
        hibernate: false,
        veto: 'not-idle',
      });
    });
  });

  describe('traffic', () => {
    it('records the new count and stamps activity', () => {
      expect(
        activity({ lastRequestCount: 5, observedRequestCount: 6 }),
      ).toEqual({
        reason: 'traffic',
        patch: { lastRequestCount: 6, lastActivityAt: NOW },
        activeAt: NOW,
      });
    });

    it('outranks an expired idle clock', () => {
      expect(
        decide({
          lastRequestCount: 5,
          observedRequestCount: 6,
          lastActivityAt: minutesAgo(9999),
        }),
      ).toMatchObject({ hibernate: false, veto: 'not-idle' });
    });
  });

  describe('silence', () => {
    it('writes nothing when the count has not moved', () => {
      const activeAt = minutesAgo(10);
      expect(
        activity({
          lastRequestCount: 5,
          observedRequestCount: 5,
          lastActivityAt: activeAt,
        }),
      ).toEqual({ reason: 'silence', patch: null, activeAt });
    });
  });

  describe('the first reading', () => {
    // Those requests happened at an unknown time, quite possibly before anyone
    // asked for hibernation. Recording the baseline is honest; stamping
    // activity would invent it and delay every sleep by a full timeout.
    it('records the baseline without stamping activity', () => {
      const activeAt = minutesAgo(300);
      expect(
        activity({
          lastRequestCount: null,
          observedRequestCount: 42,
          lastActivityAt: activeAt,
        }),
      ).toEqual({
        reason: 'first-observation',
        patch: { lastRequestCount: 42 },
        activeAt,
      });
    });

    it('can hibernate on the same tick when the clock has already run out', () => {
      expect(
        decide({
          lastRequestCount: null,
          observedRequestCount: 42,
          lastActivityAt: minutesAgo(241),
        }),
      ).toMatchObject({ hibernate: true, patch: { lastRequestCount: 42 } });
    });
  });

  describe('an environment with no clock yet', () => {
    // Nothing to measure idleness against. Stamping starts the clock, and it
    // can only ever happen once, so it cannot be what keeps one awake.
    it('starts the clock and does not sleep it', () => {
      expect(
        activity({
          lastActivityAt: null,
          lastRequestCount: null,
          observedRequestCount: 3,
        }),
      ).toEqual({
        reason: 'clock-start',
        patch: { lastActivityAt: NOW, lastRequestCount: 3 },
        activeAt: NOW,
      });
    });

    it('starts the clock with no reading at all', () => {
      expect(
        activity({
          lastActivityAt: null,
          lastRequestCount: null,
          observedRequestCount: null,
        }),
      ).toEqual({
        reason: 'clock-start',
        patch: { lastActivityAt: NOW },
        activeAt: NOW,
      });
    });

    it('is never hibernated on that tick', () => {
      expect(
        decide({ lastActivityAt: null, observedRequestCount: null }),
      ).toMatchObject({ hibernate: false, veto: 'not-idle' });
    });
  });
});

describe('decideHibernation', () => {
  describe('the idle threshold', () => {
    it('sleeps an environment past its timeout', () => {
      expect(decide({ lastActivityAt: minutesAgo(241) })).toMatchObject({
        hibernate: true,
        veto: null,
      });
    });

    it('leaves one exactly at its timeout awake', () => {
      expect(decide({ lastActivityAt: minutesAgo(240) })).toMatchObject({
        hibernate: false,
        veto: 'not-idle',
      });
    });

    it('honours a per-environment timeout', () => {
      expect(
        decide({ idleTimeoutMinutes: 1, lastActivityAt: minutesAgo(2) }),
      ).toMatchObject({ hibernate: true });
      expect(
        decide({ idleTimeoutMinutes: 10_080, lastActivityAt: minutesAgo(300) }),
      ).toMatchObject({ hibernate: false, veto: 'not-idle' });
    });
  });

  describe('the vetoes', () => {
    it.each([
      ['disabled', { enabled: false }, 'disabled'],
      ['locked', { locked: true }, 'locked'],
      ['mid-deploy', { deploymentInFlight: true }, 'deploy-in-flight'],
      [
        'with nothing running',
        { hasRunningDeployment: false },
        'nothing-running',
      ],
    ])('never sleeps an environment that is %s', (_label, vetoes, veto) => {
      expect(
        decide({ lastActivityAt: minutesAgo(9999), vetoes }),
      ).toMatchObject({
        hibernate: false,
        veto,
      });
    });

    // A locked or mid-deploy environment still had its traffic measured.
    // Throwing that away would restart its idle clock the moment the veto
    // lifts, and the environment would take another full timeout to sleep.
    it('still records the activity a veto did not stop', () => {
      expect(
        decide({
          vetoes: { locked: true },
          lastRequestCount: 5,
          observedRequestCount: 11,
        }),
      ).toMatchObject({
        veto: 'locked',
        patch: { lastRequestCount: 11, lastActivityAt: NOW },
      });
    });

    it('reports the strongest veto first', () => {
      expect(
        decide({
          lastActivityAt: minutesAgo(9999),
          vetoes: {
            enabled: false,
            locked: true,
            deploymentInFlight: true,
            hasRunningDeployment: false,
          },
        }),
      ).toMatchObject({ veto: 'disabled' });
    });
  });

  it('hibernates only with every veto clear and the clock run out', () => {
    expect(decide({ lastActivityAt: minutesAgo(241), vetoes: CLEAR })).toEqual({
      reason: 'silence',
      patch: null,
      hibernate: true,
      veto: null,
    });
  });
});
