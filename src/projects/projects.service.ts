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
import { PrismaService } from '../prisma/prisma.service';
import { BuildConfigSchema } from './dto/build-config.schema';
import { parseGithubFullName } from './util/repo-url';

export type ProjectWithEnvironments = Project & {
  environments: Environment[];
};

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly github: GithubApiService,
    private readonly authz: AuthzService,
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
        (await this.github.getDefaultBranch(userId, providerRepoFullName)) ??
        undefined;
    }
    branch = branch || 'main';

    try {
      return await this.prisma.project.create({
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
        include: { environments: true },
      });
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

  findById(id: string): Promise<ProjectWithEnvironments | null> {
    return this.prisma.project.findFirst({
      where: { id, deletedAt: null },
      include: { environments: true },
    });
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
  ): Promise<RepoBranch[] | RepoBranchWithMeta[]> {
    if (!project.providerRepoFullName) {
      throw new BadRequestException(
        'Project is not linked to a GitHub repository',
      );
    }
    const branches = base
      ? await this.github.listBranchesWithDeltas(
          project.createdByUserId,
          project.providerRepoFullName,
          base,
          refresh,
        )
      : await this.github.listBranches(
          project.createdByUserId,
          project.providerRepoFullName,
        );
    if (branches === null) {
      throw new BadGatewayException('Could not fetch branches from GitHub');
    }
    return branches;
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
      return await this.prisma.project.update({
        where: { id: projectId, deletedAt: null },
        data: { organizationId: toOrgId },
        include: { environments: true },
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
