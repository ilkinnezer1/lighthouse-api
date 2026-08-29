import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Environment, Project } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuthzService } from '../authz/authz.service';
import { CryptoService } from '../crypto/crypto.service';
import {
  GithubApiService,
  RepoBranch,
  RepoBranchWithMeta,
} from '../github/github-api.service';
import {
  BranchIssue,
  BranchLabelsService,
} from '../jira/branch-labels.service';
import {
  LOCK_SELECT,
  withLock,
  type EnvironmentLock,
  type LockHolder,
} from '../environments/environment-lock';
import { PrismaService } from '../prisma/prisma.service';
import { BuildConfigSchema } from './dto/build-config.schema';
import { parseGithubFullName } from './util/repo-url';

// Only `shapeEnvironments` can produce this: the raw Prisma row has the four
// lock columns and no `lock`, so a query returned straight to a caller is a
// compile error rather than an environment that silently never looks locked.
export type EnvironmentWithLock = Omit<
  Environment,
  'lockedByUserId' | 'lockedAt' | 'lockExpiresAt' | 'lockReason'
> & { lock: EnvironmentLock | null };

export type ProjectWithEnvironments = Project & {
  environments: EnvironmentWithLock[];
};

export const ENVIRONMENTS_WITH_LOCK = {
  environments: { include: { lockedBy: LOCK_SELECT.lockedBy } },
} satisfies Prisma.ProjectInclude;

type RawEnvironment = Environment & { lockedBy: LockHolder | null };

export function shapeEnvironments<T extends { environments: RawEnvironment[] }>(
  project: T,
): Omit<T, 'environments'> & { environments: EnvironmentWithLock[] } {
  const now = new Date();
  return {
    ...project,
    environments: project.environments.map((env) => withLock(env, now)),
  };
}

// A branch as the picker sees it: GitHub's name/sha (plus deltas when a base
// was given), optionally carrying the Jira issue its name refers to.
export type LabelledBranch = (RepoBranch | RepoBranchWithMeta) &
  Partial<BranchIssue>;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly github: GithubApiService,
    private readonly authz: AuthzService,
    private readonly branchLabels: BranchLabelsService,
  ) {}

  async create(
    userId: string,
    data: {
      name: string;
      slug: string;
      subdomain: string;
      repoUrl: string;
      defaultBranch?: string;
      organizationId?: string;
    },
  ): Promise<ProjectWithEnvironments> {
    // Use the caller-chosen org (already authorized by the controller) or fall
    // back to their personal org so solo creation is unchanged.
    const organizationId =
      data.organizationId ?? (await this.authz.personalOrgId(userId));
    const webhookSecretEnc = this.crypto.encrypt(
      randomBytes(32).toString('hex'),
    );
    const providerRepoFullName = parseGithubFullName(data.repoUrl);

    // Prefer an explicit branch; otherwise ask GitHub for the repo's default
    // (e.g. master vs main) and only fall back to 'main' if that lookup fails
    // or the repo isn't a recognizable GitHub URL.
    let branch = data.defaultBranch;
    if (!branch && providerRepoFullName) {
      branch =
        (await this.github.getDefaultBranch(
          organizationId,
          providerRepoFullName,
        )) ?? undefined;
    }
    branch = branch || 'main';

    try {
      return shapeEnvironments(
        await this.prisma.project.create({
          data: {
            organizationId,
            createdByUserId: userId,
            name: data.name,
            slug: data.slug,
            subdomain: data.subdomain,
            repoUrl: data.repoUrl,
            defaultBranch: branch,
            providerRepoFullName,
            webhookSecretEnc,
            environments: {
              create: {
                name: 'production',
                type: 'PRODUCTION',
                subdomain: 'production',
                branch,
              },
            },
          },
          include: ENVIRONMENTS_WITH_LOCK,
        }),
      );
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const target = (err.meta?.target as string[] | undefined)?.join(',');
        const field = target?.includes('subdomain') ? 'subdomain' : 'slug';
        throw new ConflictException(`Project ${field} already in use`);
      }

      throw err;
    }
  }

  // Projects in one org (the caller's resolved active/personal org). Membership
  // is validated by the caller via AuthzService.resolveScopeOrgId.
  listForOrg(organizationId: string): Promise<Project[]> {
    return this.prisma.project.findMany({
      where: { deletedAt: null, organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string): Promise<ProjectWithEnvironments | null> {
    const project = await this.prisma.project.findFirst({
      where: { id, deletedAt: null },
      include: ENVIRONMENTS_WITH_LOCK,
    });
    return project && shapeEnvironments(project);
  }

  /**
   * List the project repo's branches for the branch picker. Requires the
   * project to be linked to a recognizable GitHub repo; surfaces an upstream
   * failure as 502 so the caller can distinguish it from a missing repo (400).
   * When `base` is given, each branch also carries its delta relative to it.
   */
  async listBranches(
    project: Project,
    base?: string,
    refresh = false,
    viewerId?: string,
  ): Promise<LabelledBranch[]> {
    if (!project.providerRepoFullName) {
      throw new BadRequestException(
        'Project is not linked to a GitHub repository',
      );
    }
    const branches = base
      ? await this.github.listBranchesWithDeltas(
          project.organizationId,
          project.providerRepoFullName,
          base,
          refresh,
        )
      : await this.github.listBranches(
          project.organizationId,
          project.providerRepoFullName,
        );
    if (branches === null) {
      throw new BadGatewayException('Could not fetch branches from GitHub');
    }
    return this.withIssueLabels(project, branches, viewerId);
  }

  /**
   * Attach each branch's Jira issue, resolved with the viewer's own token.
   * Labelling is decoration: if it throws, the branch list is still the answer,
   * so a broken Jira never turns a working picker into an error page.
   */
  private async withIssueLabels(
    project: Project,
    branches: RepoBranch[] | RepoBranchWithMeta[],
    viewerId: string | undefined,
  ): Promise<LabelledBranch[]> {
    if (!viewerId) {
      return branches;
    }
    try {
      const labels = await this.branchLabels.labelBranches(
        viewerId,
        project.organizationId,
        branches.map((b) => b.name),
      );
      if (labels.size === 0) {
        return branches;
      }
      return branches.map((b) => {
        const label = labels.get(b.name);
        return label ? { ...b, ...label } : b;
      });
    } catch {
      return branches;
    }
  }

  async update(
    id: string,
    patch: {
      name?: string;
      defaultBranch?: string;
      buildConfig?: Record<string, unknown>;
    },
  ): Promise<Project> {
    const data: Prisma.ProjectUpdateInput = {
      name: patch.name,
      defaultBranch: patch.defaultBranch,
    };

    if (patch.buildConfig !== undefined) {
      const parsed = BuildConfigSchema.safeParse(patch.buildConfig);
      if (!parsed.success) {
        throw new BadRequestException({
          message: 'Invalid buildConfig',
          issues: parsed.error.issues,
        });
      }
      data.buildConfig = parsed.data;
    }

    try {
      return await this.prisma.project.update({
        where: { id, deletedAt: null },
        data,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Project not found');
      }
      throw err;
    }
  }

  /**
   * Re-anchor a project to a new org. The single-anchor design means everything
   * under it (environments → deployments → databases → snapshots) resolves its
   * org through the project, so this lone FK update moves the whole tree;
   * `createdByUserId` (creator attribution + per-user namespace) is untouched.
   * Caller authorizes both ends (`projects.transfer` source, `projects.create`
   * dest); here we guard the destination itself.
   */
  async transfer(
    userId: string,
    projectId: string,
    toOrgId: string,
  ): Promise<ProjectWithEnvironments> {
    const dest = await this.prisma.organization.findUnique({
      where: { id: toOrgId },
      select: { isPersonal: true },
    });
    if (!dest) {
      throw new NotFoundException('Destination organization not found');
    }

    // Only a shared org — or the actor's OWN personal org — may receive a
    // project; never let one be dumped into someone else's personal org.
    if (
      dest.isPersonal &&
      toOrgId !== (await this.authz.personalOrgId(userId))
    ) {
      throw new ForbiddenException(
        'Cannot transfer into a personal organization you do not own',
      );
    }

    try {
      return shapeEnvironments(
        await this.prisma.project.update({
          where: { id: projectId, deletedAt: null },
          data: { organizationId: toOrgId },
          include: ENVIRONMENTS_WITH_LOCK,
        }),
      );
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Project not found');
      }
      throw err;
    }
  }

  async softDelete(id: string): Promise<void> {
    try {
      await this.prisma.project.update({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Project not found');
      }
      throw err;
    }
  }
}
