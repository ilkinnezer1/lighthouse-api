import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GithubApiService } from '../github/github-api.service';
import { BranchLabelsService } from '../jira/branch-labels.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerProxyService } from './worker-proxy.service';

export type BranchRow = Prisma.DeploymentBranchCreateWithoutDeploymentInput;

/**
 * The worker's `POST /merge-check` body.
 *
 * `projectId`, not a user: the worker resolves the git credential from the
 * project's ORGANIZATION. It used to authenticate as the requesting person,
 * which is the same personal-token leak that was removed from the clone path.
 * Typed so the shape is a compile error to get wrong rather than a private repo
 * quietly answering `mergeable: null`.
 */
interface MergeCheckRequest {
  repoUrl: string;
  projectId: string;
  source: { name: BranchRow['name']; sha: BranchRow['sha'] };
  merges: { name: BranchRow['name']; sha: BranchRow['sha'] }[];
}

/**
 * Whether a branch set would combine cleanly. `mergeable: null` means the probe
 * could not run — an unreachable worker or a repo it could not fetch — which is
 * not the same as "no conflicts" and must never be shown as one.
 */
export interface MergeCheckResult {
  mergeable: boolean | null;
  branch?: string;
  files?: string[];
}

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
    private readonly branchLabels: BranchLabelsService,
    private readonly worker: WorkerProxyService,
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
    viewerId?: string,
  ): Promise<BranchRow[]> {
    const merges = (mergeBranches ?? []).map((b) => b.trim()).filter(Boolean);
    const requestedSource = sourceBranch?.trim();
    if (!requestedSource && merges.length === 0) {
      return [];
    }

    const { source, shaByName, organizationId } =
      await this.resolveAvailableBranches(environmentId, requestedSource);

    const unknown = [source, ...merges].filter((n) => !shaByName.has(n));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown branch(es): ${unknown.join(', ')}`,
      );
    }

    const rows = this.toRows(source, merges, shaByName);
    return this.withIssueSnapshot(rows, organizationId, viewerId);
  }

  /**
   * Stamp each row with the Jira issue its branch names, resolved once here so
   * the deployment keeps reading as its ticket forever — after the summary is
   * edited, after the org disconnects Jira, and without a Jira call to render
   * a deployments list. Best-effort: a failure costs labels, not the deploy.
   */
  private async withIssueSnapshot(
    rows: BranchRow[],
    organizationId: string,
    viewerId: string | undefined,
  ): Promise<BranchRow[]> {
    if (!viewerId || rows.length === 0) {
      return rows;
    }
    try {
      const labels = await this.branchLabels.labelBranches(
        viewerId,
        organizationId,
        rows.map((r) => r.name),
      );
      if (labels.size === 0) {
        return rows;
      }
      return rows.map((row) => {
        const label = labels.get(row.name);
        return label
          ? { ...row, issueKey: label.issueKey, issueTitle: label.issueTitle }
          : row;
      });
    } catch {
      return rows;
    }
  }

  /**
   * Dry-run the merge the deploy would perform, without spending a build on it.
   *
   * Resolution is shared with the real thing — same name validation, same SHA
   * pinning — so a check that passes has answered the question the build will
   * ask. The probe itself runs on the worker, which is the only side with git.
   */
  async checkMerge(
    environmentId: string,
    sourceBranch: string | undefined,
    mergeBranches: string[] | undefined,
  ): Promise<MergeCheckResult> {
    const rows = await this.resolve(environmentId, sourceBranch, mergeBranches);
    const merges = rows.filter((r) => r.role === 'MERGE');
    if (merges.length === 0) {
      // Nothing to combine; a lone source branch cannot conflict with itself.
      return { mergeable: true };
    }

    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      select: { project: { select: { id: true, repoUrl: true } } },
    });
    if (!env) {
      throw new NotFoundException('Environment not found');
    }

    const source = rows.find((r) => r.role === 'SOURCE')!;
    const payload: MergeCheckRequest = {
      repoUrl: env.project.repoUrl,
      projectId: env.project.id,
      source: { name: source.name, sha: source.sha },
      merges: merges.map((m) => ({ name: m.name, sha: m.sha })),
    };
    try {
      const result = await this.worker.json<{
        mergeable: boolean;
        branch?: string;
        files?: string[];
      }>(
        '/merge-check',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        {
          notFound: 'Merge check unavailable',
          failed: 'Merge check failed',
        },
      );
      return result;
    } catch {
      // Degrade rather than block the deploy button: the user can still try,
      // and the build reports the conflict properly if there is one.
      return { mergeable: null };
    }
  }

  /** Load the env's repo, fetch its branches, and pick the source branch. */
  private async resolveAvailableBranches(
    environmentId: string,
    requestedSource: string | undefined,
  ): Promise<{
    source: string;
    shaByName: Map<string, string>;
    organizationId: string;
  }> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      select: {
        branch: true,
        project: {
          select: { providerRepoFullName: true, organizationId: true },
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
    const { organizationId, providerRepoFullName } = env.project;
    if (!providerRepoFullName) {
      throw new BadRequestException(
        'Project is not linked to a GitHub repository',
      );
    }

    const branches = await this.github.listBranches(
      organizationId,
      providerRepoFullName,
    );
    if (branches === null) {
      throw new BadGatewayException('Could not fetch branches from GitHub');
    }

    return {
      source,
      shaByName: new Map(branches.map((b) => [b.name, b.sha])),
      organizationId,
    };
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
