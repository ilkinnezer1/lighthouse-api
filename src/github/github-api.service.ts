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
}
