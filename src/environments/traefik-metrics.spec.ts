import { parseServiceRequestTotals } from './traefik-metrics';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const series = (labels: string, value: string) =>
  `traefik_service_requests_total{${labels}} ${value}`;

describe('parseServiceRequestTotals', () => {
  // The metric is partitioned by code/method/protocol, so one deployment has
  // many series. Reading one would undercount and make a busy environment look
  // idle — which is the worst thing this feature can get wrong.
  it('sums every series that shares a service label', () => {
    const text = [
      series(
        `code="200",method="GET",protocol="http",service="deploy-${A}@docker"`,
        '2',
      ),
      series(
        `code="404",method="GET",protocol="http",service="deploy-${A}@docker"`,
        '3',
      ),
      series(
        `code="200",method="POST",protocol="http",service="deploy-${A}@docker"`,
        '7',
      ),
    ].join('\n');

    expect(parseServiceRequestTotals(text)).toEqual(new Map([[A, 12]]));
  });

  it('keeps deployments apart', () => {
    const text = [
      series(`code="200",service="deploy-${A}@docker"`, '2'),
      series(`code="200",service="deploy-${B}@docker"`, '5'),
      series(`code="500",service="deploy-${B}@docker"`, '1'),
    ].join('\n');

    expect(parseServiceRequestTotals(text)).toEqual(
      new Map([
        [A, 2],
        [B, 6],
      ]),
    );
  });

  it('does not care where the service label sits', () => {
    const text = [
      series(`service="deploy-${A}@docker",code="200",method="GET"`, '1'),
      series(`code="200",service="deploy-${A}@docker",method="GET"`, '1'),
      series(`code="200",method="GET",service="deploy-${A}@docker"`, '1'),
    ].join('\n');

    expect(parseServiceRequestTotals(text).get(A)).toBe(3);
  });

  it('strips the provider suffix', () => {
    const text = series(`service="deploy-${A}@docker"`, '4');
    expect([...parseServiceRequestTotals(text).keys()]).toEqual([A]);
  });

  it('reads a service with no provider suffix at all', () => {
    const text = series(`service="deploy-${A}"`, '4');
    expect(parseServiceRequestTotals(text).get(A)).toBe(4);
  });

  describe('what it ignores', () => {
    it('skips HELP, TYPE and comment lines', () => {
      const text = [
        '# HELP traefik_service_requests_total How many HTTP requests processed.',
        '# TYPE traefik_service_requests_total counter',
        '# a bare comment',
        series(`service="deploy-${A}@docker"`, '9'),
      ].join('\n');

      expect(parseServiceRequestTotals(text)).toEqual(new Map([[A, 9]]));
    });

    it('skips other traefik metrics, including the entrypoint ones', () => {
      const text = [
        `traefik_entrypoint_requests_total{entrypoint="web",code="200"} 400`,
        `traefik_service_request_duration_seconds_sum{service="deploy-${A}@docker"} 0.5`,
        `traefik_service_requests_tls_total{service="deploy-${A}@docker"} 12`,
        series(`service="deploy-${A}@docker"`, '9'),
      ].join('\n');

      expect(parseServiceRequestTotals(text)).toEqual(new Map([[A, 9]]));
    });

    it('skips traefik-internal services, which map to no deployment', () => {
      const text = [
        'traefik_service_requests_total{service="api@internal"} 31',
        'traefik_service_requests_total{service="noop@internal"} 2',
      ].join('\n');

      expect(parseServiceRequestTotals(text).size).toBe(0);
    });

    // The id goes straight into a `@db.Uuid` query, where a non-uuid is a
    // Postgres error rather than a miss.
    it('skips a deploy- service whose id is not a uuid', () => {
      const text = series('service="deploy-not-a-uuid@docker"', '5');
      expect(parseServiceRequestTotals(text).size).toBe(0);
    });

    it('skips a series with no labels at all', () => {
      expect(
        parseServiceRequestTotals('traefik_service_requests_total 5').size,
      ).toBe(0);
    });
  });

  describe('malformed input is skipped, never thrown', () => {
    it('survives an unterminated label set', () => {
      const text = [
        `traefik_service_requests_total{service="deploy-${A}@docker" 5`,
        series(`service="deploy-${B}@docker"`, '3'),
      ].join('\n');

      expect(parseServiceRequestTotals(text)).toEqual(new Map([[B, 3]]));
    });

    it.each([
      [
        'a missing value',
        `traefik_service_requests_total{service="deploy-${A}@docker"}`,
      ],
      ['a non-numeric value', series(`service="deploy-${A}@docker"`, 'abc')],
      [
        'NaN, which is a legal prometheus value',
        series(`service="deploy-${A}@docker"`, 'NaN'),
      ],
      ['a negative count', series(`service="deploy-${A}@docker"`, '-4')],
    ])('drops %s rather than poisoning the sum', (_label, bad) => {
      const text = [bad, series(`service="deploy-${A}@docker"`, '6')].join(
        '\n',
      );
      expect(parseServiceRequestTotals(text).get(A)).toBe(6);
    });

    it.each(['', '\n\n  \n', 'garbage\nmore garbage'])(
      'returns an empty map for %j',
      (text) => {
        expect(parseServiceRequestTotals(text).size).toBe(0);
      },
    );
  });

  describe('exposition-format details', () => {
    it('accepts floats and exponents', () => {
      const text = [
        series(`code="200",service="deploy-${A}@docker"`, '2.0'),
        series(`code="404",service="deploy-${A}@docker"`, '1e+02'),
      ].join('\n');

      expect(parseServiceRequestTotals(text).get(A)).toBe(102);
    });

    it('ignores an optional trailing timestamp', () => {
      const text = series(`service="deploy-${A}@docker"`, '7 1756468800000');
      expect(parseServiceRequestTotals(text).get(A)).toBe(7);
    });

    it('tolerates trailing whitespace and CRLF line endings', () => {
      const text = `${series(`service="deploy-${A}@docker"`, '7')}  \r\n`;
      expect(parseServiceRequestTotals(text).get(A)).toBe(7);
    });

    it('does not let a brace inside a quoted label end the label set', () => {
      const text = series(`code="}",service="deploy-${A}@docker"`, '5');
      expect(parseServiceRequestTotals(text).get(A)).toBe(5);
    });
  });

  // The single most important property: a deployment Traefik has no series for
  // must be ABSENT, not zero. A stopped or never-visited container has no
  // series, and reporting 0 would read as a counter reset on every poll.
  it('leaves a deployment with no series out of the map entirely', () => {
    const totals = parseServiceRequestTotals(
      series(`service="deploy-${A}@docker"`, '3'),
    );
    expect(totals.has(B)).toBe(false);
    expect(totals.get(B)).toBeUndefined();
  });
});
