import { BadRequestException } from '@nestjs/common';

// One DNS label: alphanumeric, inner hyphens allowed, 1–63 chars.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOSTNAME = 253;

/** Lowercase, strip whitespace, a trailing root dot, and an accidental scheme/path. */
export function normalizeDomain(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split('/')[0];
  value = value.replace(/\.$/, '');
  return value;
}

/**
 * Reject anything that isn't a plain hostname we can safely hand to Traefik.
 *
 * The load-bearing rule is the last one: a domain at or under the platform's own
 * BASE_DOMAIN is refused. Generated deploy hosts live there, so accepting one
 * would let an environment claim another tenant's hostname — Traefik would end
 * up with two routers holding the same Host rule and pick between them
 * arbitrarily. The unique index can't catch this; generated hosts are never
 * stored in `custom_domain`.
 */
export function assertValidDomain(domain: string, baseDomain: string): void {
  if (!domain) {
    throw new BadRequestException('Domain is required');
  }
  if (domain.length > MAX_HOSTNAME) {
    throw new BadRequestException('Domain is too long');
  }
  if (domain.includes(':')) {
    throw new BadRequestException('Domain must not include a port');
  }
  if (domain.includes('*')) {
    throw new BadRequestException('Wildcard domains are not supported');
  }

  const labels = domain.split('.');
  if (labels.length < 2) {
    throw new BadRequestException(
      'Use a fully qualified domain, e.g. app.example.com',
    );
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      throw new BadRequestException(`"${label}" is not a valid domain label`);
    }
  }

  const base = baseDomain.trim().toLowerCase().replace(/\.$/, '');
  if (base && (domain === base || domain.endsWith(`.${base}`))) {
    throw new BadRequestException(
      `${domain} is inside the platform domain (${base}); deployments there are addressed automatically`,
    );
  }
}
