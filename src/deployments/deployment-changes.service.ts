import { Injectable } from '@nestjs/common';
import { GithubApiService, RepoCommit } from '../github/github-api.service';
import { BranchLabelsService } from '../jira/branch-labels.service';
import { issueKeyFromBranch } from '../jira/issue-key';
import { PrismaService } from '../prisma/prisma.service';

export interface ChangedCommit extends RepoCommit {
  issueKey: string | null;
  issueTitle: string | null;
  issueUrl: string | null;
}

export interface DeploymentChanges {
  /** The build this one is measured against, or null if it is the first here. */
  previous: { id: string; commitSha: string; createdAt: Date } | null;
  commits: ChangedCommit[];
  totalCommits: number;
  /** GitHub caps the compare at 250 commits; more than that and this is true. */
  truncated: boolean;
  /** Set when the range could not be worked out, so the UI can say why. */
  unavailable: 'no-previous' | 'no-commit' | 'unlinked' | 'upstream' | null;
}

// A factory, not a shared constant: each response owns its own array.
const empty = () => ({
  commits: [] as ChangedCommit[],
  totalCommits: 0,
  truncated: false,
});

/**
 * What landed between the last build of an environment and this one.
 *
 * The question a tester actually asks of a sandbox is not "what is on it" but
 * "what changed since I last looked". That is the range between this build's
 * commit and the previous *succeeded* build's: a failed build never reached the
 * environment, so measuring against it would report changes nobody could have
 * tested.
 */
@Injectable()
export class DeploymentChangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubApiService,
    private readonly branchLabels: BranchLabelsService,
  ) {}

  async forDeployment(
    deploymentId: string,
    viewerId: string,
  ): Promise<DeploymentChanges> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        environmentId: true,
        commitSha: true,
        createdAt: true,
        environment: {
          select: {
            project: {
              select: {
                createdByUserId: true,
                providerRepoFullName: true,
                organizationId: true,
              },
            },
          },
        },
      },
    });
    if (!deployment?.commitSha) {
      return { previous: null, ...empty(), unavailable: 'no-commit' };
    }
    const { providerRepoFullName, createdByUserId, organizationId } =
      deployment.environment.project;
    if (!providerRepoFullName) {
      return { previous: null, ...empty(), unavailable: 'unlinked' };
    }

    const previous = await this.previousSucceeded(deployment);
    if (!previous?.commitSha) {
      return { previous: null, ...empty(), unavailable: 'no-previous' };
    }

    // Redeploying the same commit is a real and common case; GitHub would
    // answer with an empty range anyway, so skip the call.
    if (previous.commitSha === deployment.commitSha) {
      return { previous: this.brief(previous), ...empty(), unavailable: null };
    }

    const range = await this.github.compareCommits(
      createdByUserId,
      providerRepoFullName,
      previous.commitSha,
      deployment.commitSha,
    );
    if (!range) {
      return {
        previous: this.brief(previous),
        ...empty(),
        unavailable: 'upstream',
      };
    }

    return {
      previous: this.brief(previous),
      commits: await this.withIssues(range.commits, viewerId, organizationId),
      totalCommits: range.totalCommits,
      truncated: range.truncated,
      unavailable: null,
    };
  }

  /**
   * The last build before this one that actually reached the environment.
   * SUCCEEDED only — a failed or cancelled build changed nothing, so counting
   * it would understate what a tester has not yet seen.
   */
  private previousSucceeded(deployment: {
    id: string;
    environmentId: string;
    createdAt: Date;
  }) {
    return this.prisma.deployment.findFirst({
      where: {
        environmentId: deployment.environmentId,
        status: 'SUCCEEDED',
        commitSha: { not: null },
        id: { not: deployment.id },
        createdAt: { lt: deployment.createdAt },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, commitSha: true, createdAt: true },
    });
  }

  private brief(p: { id: string; commitSha: string | null; createdAt: Date }) {
    return { id: p.id, commitSha: p.commitSha!, createdAt: p.createdAt };
  }

  /**
   * Attach the Jira issue each subject references. Decoration only — a Jira
   * that is down or unconfigured costs the links, never the commit list.
   */
  private async withIssues(
    commits: RepoCommit[],
    viewerId: string,
    organizationId: string,
  ): Promise<ChangedCommit[]> {
    const bare = commits.map((c) => ({
      ...c,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
    }));
    if (commits.length === 0) {
      return bare;
    }
    try {
      const byKey = await this.branchLabels.confirmedIssues(
        viewerId,
        organizationId,
        commits.map((c) => c.message),
      );
      if (byKey.size === 0) {
        return bare;
      }
      return commits.map((c) => {
        const key = issueKeyFromBranch(c.message);
        const issue = key ? byKey.get(key) : undefined;
        return {
          ...c,
          issueKey: issue?.issueKey ?? null,
          issueTitle: issue?.issueTitle ?? null,
          issueUrl: issue?.issueUrl ?? null,
        };
      });
    } catch {
      return bare;
    }
  }
}
