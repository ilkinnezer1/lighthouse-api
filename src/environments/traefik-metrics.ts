/**
 * Traefik's Prometheus exposition → per-deployment request totals.
 *
 * Pure: text in, counts out. The idle signal is `traefik_service_requests_total`
 * — NOT `traefik_router_requests_total`, which Traefik v3 does not emit unless
 * `--metrics.prometheus.addRoutersLabels=true` is set. Both name the same
 * thing here anyway, because the worker labels router and service alike as
 * `deploy-{deploymentId}`.
 *
 * ⚠️ An absent deployment key means "no reading", never "zero". A stopped
 * container's series is swept out of `/metrics` entirely rather than frozen at
 * its last value, so reporting 0 for it would read as a counter reset on every
 * poll and keep an untouched environment awake forever. The caller must treat
 * a missing key as no observation (see hibernation-decision.ts).
 */

const METRIC = 'traefik_service_requests_total';
const SERVICE_PREFIX = 'deploy-';

// The label value is `deploy-{uuid}@docker`; the id is fed straight into a
// `@db.Uuid` query, where a non-uuid string is a Postgres error rather than a
// miss. Anything that isn't a uuid is not one of ours.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/**
 * Total requests Traefik routed per deployment, summed across every series
 * sharing a `service` label — the metric is partitioned by `code`, `method`
 * and `protocol`, so one deployment has many series and reading a single one
 * would make a busy environment look idle.
 *
 * Malformed input is skipped, never thrown: this parses a remote process's
 * output on a timer, and one bad line must not cost the whole sweep.
 */
export function parseServiceRequestTotals(text: string): Map<string, number> {
  const totals = new Map<string, number>();

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!line.startsWith(METRIC)) continue;

    // Guards against a longer metric name that merely shares this prefix; a
    // series with no labels carries no service to attribute it to either.
    const rest = line.slice(METRIC.length);
    if (rest[0] !== '{') continue;

    const close = closingBrace(rest);
    if (close === -1) continue;

    const deploymentId = deploymentIdOf(rest.slice(1, close));
    if (!deploymentId) continue;

    const value = sampleValue(rest.slice(close + 1));
    if (value === null) continue;

    totals.set(deploymentId, (totals.get(deploymentId) ?? 0) + value);
  }

  return totals;
}

/** End of the label set, honouring quoted values that may contain `}`. */
function closingBrace(rest: string): number {
  let quoted = false;
  for (let i = 1; i < rest.length; i++) {
    const c = rest[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '}') return i;
  }
  return -1;
}

/** `service="deploy-<uuid>@docker"` → `<uuid>`. Label order is arbitrary. */
function deploymentIdOf(labels: string): string | null {
  LABEL.lastIndex = 0;
  for (let m = LABEL.exec(labels); m; m = LABEL.exec(labels)) {
    if (m[1] !== 'service') continue;
    const at = m[2].lastIndexOf('@');
    const name = at === -1 ? m[2] : m[2].slice(0, at);
    if (!name.startsWith(SERVICE_PREFIX)) return null;
    const id = name.slice(SERVICE_PREFIX.length);
    return UUID.test(id) ? id : null;
  }
  return null;
}

/**
 * The sample value, ignoring the optional trailing timestamp. Counters are
 * float64 in the exposition format, so `2`, `2.0` and `2e+06` are all legal.
 */
function sampleValue(tail: string): number | null {
  const token = tail.trim().split(/\s+/)[0];
  if (!token) return null;
  const value = Number(token);
  // NaN is a legal Prometheus value and negatives cannot be a request count;
  // neither is a reading, and folding either into a sum would poison it.
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}
