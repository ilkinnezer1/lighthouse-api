import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GithubApiService } from '../github/github-api.service';
import { PrismaService } from '../prisma/prisma.service';

export type BranchRow = Prisma.DeploymentBranchCreateWithoutDeploymentInput;

/**
 * Turns a requested branch set (source + merges) into immutable, SHA-pinned
 * rows for a deployment. Isolated from DeploymentsService because it owns the
 * GitHub round-trip and the name/SHA validation.
 */
@Injectable()
export class DeploymentBranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubApiService,
  ) {}

  /**
   * Resolve a requested branch set to rows pinned to commit SHAs. Returns []
   * when nothing is requested, so plain deploys keep the fast path (worker
   * clones the environment's branch). Otherwise the first row is the SOURCE
   * (defaulting to the environment's branch) followed by deduped MERGE branches
   * in order. Throws if the repo is unlinked, GitHub is unreachable, or any
   * named branch does not exist.
   */
  async resolve(
    environmentId: string,
    sourceBranch: string | undefined,
    mergeBranches: string[] | undefined,
  ): Promise<BranchRow[]> {
    const merges = (mergeBranches ?? []).map((b) => b.trim()).filter(Boolean);
    const requestedSource = sourceBranch?.trim();
    if (!requestedSource && merges.length === 0) {
      return [];
    }

    const { source, shaByName } = await this.resolveAvailableBranches(
      environmentId,
      requestedSource,
    );

    const unknown = [source, ...merges].filter((n) => !shaByName.has(n));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown branch(es): ${unknown.join(', ')}`,
      );
    }

    return this.toRows(source, merges, shaByName);
  }

  /** Load the env's repo, fetch its branches, and pick the source branch. */
  private async resolveAvailableBranches(
    environmentId: string,
    requestedSource: string | undefined,
  ): Promise<{ source: string; shaByName: Map<string, string> }> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      select: {
        branch: true,
        project: {
          select: { createdByUserId: true, providerRepoFullName: true },
        },
      },
    });
    if (!env) {
      throw new NotFoundException('Environment not found');
    }

    const source = requestedSource || env.branch;
    if (!source) {
      throw new BadRequestException('No source branch to deploy');
    }
    const { createdByUserId, providerRepoFullName } = env.project;
    if (!providerRepoFullName) {
      throw new BadRequestException(
        'Project is not linked to a GitHub repository',
      );
    }

    const branches = await this.github.listBranches(
      createdByUserId,
      providerRepoFullName,
    );
    if (branches === null) {
      throw new BadGatewayException('Could not fetch branches from GitHub');
    }

    return { source, shaByName: new Map(branches.map((b) => [b.name, b.sha])) };
  }

  /** Source first (ordinal 0), then deduped merges in order (ordinal 1..N). */
  private toRows(
    source: string,
    merges: string[],
    shaByName: Map<string, string>,
  ): BranchRow[] {
    const rows: BranchRow[] = [
      { role: 'SOURCE', name: source, sha: shaByName.get(source)!, ordinal: 0 },
    ];
    const seen = new Set([source]);
    let ordinal = 1;
    for (const name of merges) {
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({
        role: 'MERGE',
        name,
        sha: shaByName.get(name)!,
        ordinal: ordinal++,
      });
    }
    return rows;
  }
}
