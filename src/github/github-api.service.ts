import { Injectable, Logger } from '@nestjs/common';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

const GITHUB_API = 'https://api.github.com';

@Injectable()
export class GithubApiService {
  private readonly logger = new Logger(GithubApiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async commentOnPR(args: {
    ownerId: string;
    repoFullName: string;
    prNumber: number;
    body: string;
  }): Promise<void> {
    const credential = await this.prisma.gitCredential.findFirst({
      where: { userId: args.ownerId, kind: 'PAT' },
      orderBy: { createdAt: 'desc' },
    });
    if (!credential) {
      this.logger.warn(`no PAT for owner ${args.ownerId}; skipping PR comment`);
      return;
    }

    const token = this.crypto.decrypt(credential.secretEnc);

    try {
      const res = await fetch(
        `${GITHUB_API}/repos/${args.repoFullName}/issues/${args.prNumber}/comments`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'lighthouse',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ body: args.body }),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        this.logger.warn(
          `PR comment failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
        );
      }
    } catch (err) {
      this.logger.warn(`PR comment request errored: ${String(err)}`);
    }
  }

  /**
   * Look up a repo's default branch via the GitHub API. Uses the owner's PAT
   * when one exists (required for private repos, higher rate limits otherwise),
   * but falls back to an unauthenticated call so public repos still resolve.
   * Returns null on any failure so callers can fall back to their own default.
   */
  async getDefaultBranch(
    ownerId: string,
    repoFullName: string,
  ): Promise<string | null> {
    const credential = await this.prisma.gitCredential.findFirst({
      where: { userId: ownerId, kind: 'PAT' },
      orderBy: { createdAt: 'desc' },
    });

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lighthouse',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (credential) {
      headers.Authorization = `Bearer ${this.crypto.decrypt(credential.secretEnc)}`;
    }

    try {
      const res = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
        headers,
      });
      if (!res.ok) {
        this.logger.warn(
          `default-branch lookup failed for ${repoFullName}: ${res.status} ${res.statusText}`,
        );
        return null;
      }
      const body = (await res.json()) as { default_branch?: string };
      return body.default_branch ?? null;
    } catch (err) {
      this.logger.warn(
        `default-branch lookup errored for ${repoFullName}: ${String(err)}`,
      );
      return null;
    }
  }
}
