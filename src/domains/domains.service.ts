import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { promises as dns } from 'node:dns';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { assertValidDomain, normalizeDomain } from './domain.util';

export interface DomainStatus {
  customDomain: string | null;
  // Where the user should point DNS. Null in local mode, where there's nothing
  // meaningful to point at.
  target: string | null;
  mode: 'local' | 'server';
}

export interface DomainCheck {
  domain: string;
  resolves: boolean;
  matches: boolean;
  found: string[];
  expected: string[];
  // Set when the check itself can't be meaningful, rather than when it fails.
  note?: string;
}

@Injectable()
export class DomainsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async get(environmentId: string): Promise<DomainStatus> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      select: { customDomain: true },
    });
    if (!env) {
      throw new NotFoundException('Environment not found');
    }
    return {
      customDomain: env.customDomain,
      target: this.target(),
      mode: this.mode(),
    };
  }

  async set(environmentId: string, input: string): Promise<DomainStatus> {
    const domain = normalizeDomain(input);
    assertValidDomain(domain, this.config.get('BASE_DOMAIN', { infer: true }));

    try {
      await this.prisma.environment.update({
        where: { id: environmentId },
        data: { customDomain: domain },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2002') {
          throw new ConflictException(
            `${domain} is already used by another environment`,
          );
        }
        if (err.code === 'P2025') {
          throw new NotFoundException('Environment not found');
        }
      }
      throw err;
    }
    return this.get(environmentId);
  }

  async clear(environmentId: string): Promise<void> {
    try {
      await this.prisma.environment.update({
        where: { id: environmentId },
        data: { customDomain: null },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Environment not found');
      }
      throw err;
    }
  }

  /**
   * Compare where the domain actually points against where this platform lives.
   *
   * Advisory only — saving a domain is never blocked on it, because configuring
   * DNS after adding the domain in the UI is the normal order of operations.
   */
  async check(environmentId: string): Promise<DomainCheck> {
    const { customDomain } = await this.get(environmentId);
    if (!customDomain) {
      throw new NotFoundException('No custom domain set for this environment');
    }

    const found = await resolveAll(customDomain);
    if (this.mode() === 'local') {
      return {
        domain: customDomain,
        resolves: found.length > 0,
        matches: false,
        found,
        expected: [],
        note: 'Running in local mode — there is no public address to point DNS at, so this check is informational only.',
      };
    }

    const expected = await resolveAll(this.config.get('BASE_DOMAIN', { infer: true }));
    return {
      domain: customDomain,
      resolves: found.length > 0,
      matches:
        found.length > 0 &&
        expected.length > 0 &&
        found.some((addr) => expected.includes(addr)),
      found,
      expected,
      note:
        expected.length === 0
          ? 'Could not resolve the platform base domain, so there is nothing to compare against.'
          : undefined,
    };
  }

  private mode(): 'local' | 'server' {
    return this.config.get('MODE', { infer: true });
  }

  private target(): string | null {
    return this.mode() === 'server'
      ? this.config.get('BASE_DOMAIN', { infer: true })
      : null;
  }
}

async function resolveAll(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}
