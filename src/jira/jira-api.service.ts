import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

// Jira caps a JQL `issue in (...)` clause well below this, and a branch list
// this long is already pathological; chunking keeps one huge repo from
// building a query the server rejects outright.
const KEYS_PER_QUERY = 100;
const SUMMARY_TTL_MS = 5 * 60 * 1000;
const SUMMARY_CACHE_MAX = 2000;
// A token about to expire is refreshed rather than spent, so a lookup does not
// have to fail once before it recovers.
const EXPIRY_SKEW_MS = 60 * 1000;

interface CachedSummary {
  at: number;
  title: string | null;
}

export interface JiraSite {
  cloudId: string;
  name: string;
  url: string;
}

/**
 * Reads issue summaries out of Jira on behalf of a user.
 *
 * Every method degrades rather than throws: a branch list must render whether
 * or not Jira answers, so an unreachable or unauthorized Jira costs titles, not
 * the page. Tokens are per-user (OAuth 3LO), the site is per-org.
 */
@Injectable()
export class JiraApiService {
  private readonly logger = new Logger(JiraApiService.name);
  // Keyed by user + cloud + issue, never by issue alone: two users of the same
  // site can have different Jira project permissions, and one must not be
  // served a summary the other resolved.
  private readonly summaryCache = new Map<string, CachedSummary>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.clientId() && this.clientSecret());
  }

  private authUrl(): string {
    return this.config.get('ATLASSIAN_AUTH_URL', { infer: true });
  }

  private apiUrl(): string {
    return this.config.get('ATLASSIAN_API_URL', { infer: true });
  }

  /**
   * Resolve issue keys to summaries. Unknown or forbidden keys are simply
   * absent from the returned map. Returns an empty map when the user has no
   * Atlassian connection, so callers need no special-casing for that.
   */
  async fetchSummaries(
    userId: string,
    cloudId: string,
    keys: string[],
  ): Promise<Map<string, string>> {
    const wanted = [...new Set(keys.filter(Boolean))];
    const resolved = new Map<string, string>();
    if (wanted.length === 0) {
      return resolved;
    }

    const missing: string[] = [];
    for (const key of wanted) {
      const cached = this.readCache(userId, cloudId, key);
      if (cached === undefined) {
        missing.push(key);
      } else if (cached !== null) {
        resolved.set(key, cached);
      }
    }
    if (missing.length === 0) {
      return resolved;
    }

    const token = await this.accessToken(userId);
    if (!token) {
      return resolved;
    }

    const found = await this.search(token, cloudId, missing);
    if (found === null) {
      return resolved;
    }

    for (const key of missing) {
      // Cache the misses too — an unresolvable key would otherwise be re-queried
      // on every render of a branch list that contains it.
      const title = found.get(key) ?? null;
      this.writeCache(userId, cloudId, key, title);
      if (title !== null) {
        resolved.set(key, title);
      }
    }
    return resolved;
  }

  /** The Jira sites this user's token can reach, for the org site picker. */
  async listSites(userId: string): Promise<JiraSite[]> {
    const token = await this.accessToken(userId);
    if (!token) {
      return [];
    }
    return (await this.accessibleResources(token)) ?? [];
  }

  /** Whether this user has a usable Atlassian connection. */
  async isConnected(userId: string): Promise<boolean> {
    const identity = await this.prisma.userIdentity.findFirst({
      where: { userId, provider: 'ATLASSIAN', accessTokenEnc: { not: null } },
      select: { id: true },
    });
    return identity !== null;
  }

  private async accessibleResources(token: string): Promise<JiraSite[] | null> {
    try {
      const res = await fetch(
        `${this.apiUrl()}/oauth/token/accessible-resources`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        },
      );
      if (!res.ok) {
        this.logger.warn(
          `atlassian accessible-resources failed: ${res.status} ${res.statusText}`,
        );
        return null;
      }
      const body = (await res.json()) as Array<{
        id?: string;
        name?: string;
        url?: string;
      }>;
      return body
        .filter((r) => r.id && r.url)
        .map((r) => ({
          cloudId: r.id!,
          name: r.name ?? r.url!,
          url: r.url!,
        }));
    } catch (err) {
      this.logger.warn(
        `atlassian accessible-resources errored: ${String(err)}`,
      );
      return null;
    }
  }

  /**
   * One JQL batch per chunk of keys, asking only for `summary`. Returns null if
   * a chunk fails outright so the caller can tell "nothing found" from "could
   * not ask" and avoid caching a failure as a miss.
   */
  private async search(
    token: string,
    cloudId: string,
    keys: string[],
  ): Promise<Map<string, string> | null> {
    const out = new Map<string, string>();
    for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
      const chunk = keys.slice(i, i + KEYS_PER_QUERY);
      const url = `${this.apiUrl()}/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/search/jql`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jql: `issue in (${chunk.join(', ')})`,
            maxResults: chunk.length,
            fields: ['summary'],
          }),
        });
        if (!res.ok) {
          this.logger.warn(
            `jira issue search failed: ${res.status} ${res.statusText}`,
          );
          return null;
        }
        const body = (await res.json()) as {
          issues?: Array<{ key?: string; fields?: { summary?: string } }>;
        };
        for (const issue of body.issues ?? []) {
          if (issue.key && issue.fields?.summary) {
            out.set(issue.key.toUpperCase(), issue.fields.summary);
          }
        }
      } catch (err) {
        this.logger.warn(`jira issue search errored: ${String(err)}`);
        return null;
      }
    }
    return out;
  }

  /**
   * A live access token for this user, refreshing and persisting a rotated pair
   * when the stored one has expired. Null when unconnected or unrefreshable —
   * callers treat that as "no titles", never as an error.
   */
  private async accessToken(userId: string): Promise<string | null> {
    const identity = await this.prisma.userIdentity.findFirst({
      where: { userId, provider: 'ATLASSIAN' },
    });
    if (!identity?.accessTokenEnc) {
      return null;
    }

    const stillValid =
      !identity.tokenExpiresAt ||
      identity.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS > Date.now();
    if (stillValid) {
      return this.crypto.decrypt(identity.accessTokenEnc);
    }

    if (!identity.refreshTokenEnc || !this.isConfigured()) {
      return null;
    }
    return this.refresh(
      identity.id,
      this.crypto.decrypt(identity.refreshTokenEnc),
    );
  }

  /** Exchange a refresh token, persisting the rotated pair Atlassian returns. */
  private async refresh(
    identityId: string,
    refreshToken: string,
  ): Promise<string | null> {
    try {
      const res = await fetch(`${this.authUrl()}/oauth/token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: this.clientId(),
          client_secret: this.clientSecret(),
          refresh_token: refreshToken,
        }),
      });
      if (!res.ok) {
        this.logger.warn(
          `atlassian token refresh failed: ${res.status} ${res.statusText}`,
        );
        return null;
      }
      // Body carries both tokens — never log it.
      const body = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!body.access_token) {
        return null;
      }

      await this.prisma.userIdentity.update({
        where: { id: identityId },
        data: {
          accessTokenEnc: this.crypto.encrypt(body.access_token),
          // Atlassian rotates the refresh token; keeping the old one would
          // break the next refresh.
          ...(body.refresh_token
            ? { refreshTokenEnc: this.crypto.encrypt(body.refresh_token) }
            : {}),
          tokenExpiresAt: body.expires_in
            ? new Date(Date.now() + body.expires_in * 1000)
            : null,
        },
      });
      return body.access_token;
    } catch (err) {
      this.logger.warn(`atlassian token refresh errored: ${String(err)}`);
      return null;
    }
  }

  private cacheKey(userId: string, cloudId: string, issueKey: string): string {
    return `${userId}::${cloudId}::${issueKey}`;
  }

  /** undefined = not cached; null = cached miss; string = cached summary. */
  private readCache(
    userId: string,
    cloudId: string,
    issueKey: string,
  ): string | null | undefined {
    const hit = this.summaryCache.get(this.cacheKey(userId, cloudId, issueKey));
    if (!hit || Date.now() - hit.at >= SUMMARY_TTL_MS) {
      return undefined;
    }
    return hit.title;
  }

  private writeCache(
    userId: string,
    cloudId: string,
    issueKey: string,
    title: string | null,
  ): void {
    const now = Date.now();
    if (this.summaryCache.size >= SUMMARY_CACHE_MAX) {
      for (const [k, v] of this.summaryCache) {
        if (now - v.at >= SUMMARY_TTL_MS) {
          this.summaryCache.delete(k);
        }
      }
    }
    this.summaryCache.set(this.cacheKey(userId, cloudId, issueKey), {
      at: now,
      title,
    });
  }

  private clientId(): string | undefined {
    return this.config.get('ATLASSIAN_OAUTH_CLIENT_ID', { infer: true });
  }

  private clientSecret(): string | undefined {
    return this.config.get('ATLASSIAN_OAUTH_CLIENT_SECRET', { infer: true });
  }
}
