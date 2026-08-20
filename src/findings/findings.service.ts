import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FindingStatus, Prisma, type User } from '@prisma/client';
import {
  DeploymentAccessService,
  type DeploymentDetail,
} from '../deployments/deployment-access.service';
import { InboxService } from '../notifications/inbox.service';
import {
  draftsFor,
  type FindingFacts,
} from '../notifications/inbox.recipients';
import { INBOX_ONLY_EVENTS } from '../notifications/notifications.constants';
import { PrismaService } from '../prisma/prisma.service';
import { displayNameOf } from '../common/user-ref';
import { FindingLogsService } from './finding-logs.service';
import { isResolution, resolveTransition } from './finding-status';
import {
  FINDING_DETAIL_SELECT,
  FINDING_SELECT,
  toFindingDetail,
  toFindingView,
  type FindingDetail,
  type FindingView,
} from './finding.view';
import type { CreateFindingDto } from './dto/create-finding.dto';
import type { UpdateFindingDto } from './dto/update-finding.dto';

// Findings are low-volume by nature — a build gets a handful, not a feed — so
// the lists are plain capped arrays rather than a cursor-paged feed nobody
// would page through.
const MAX_FINDINGS = 200;

// What a status change needs to know about the finding it is changing, plus the
// place facts a notification reads. One query instead of a re-read per concern.
const FINDING_CONTEXT_SELECT = {
  id: true,
  title: true,
  status: true,
  deploymentId: true,
  reportedByUserId: true,
  foundOn: {
    select: {
      commitSha: true,
      environmentId: true,
      environment: {
        select: {
          id: true,
          name: true,
          project: { select: { id: true, name: true } },
        },
      },
    },
  },
} satisfies Prisma.FindingSelect;

type FindingContext = Prisma.FindingGetPayload<{
  select: typeof FINDING_CONTEXT_SELECT;
}>;

@Injectable()
export class FindingsService {
  private readonly logger = new Logger(FindingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DeploymentAccessService,
    private readonly logs: FindingLogsService,
    private readonly inbox: InboxService,
  ) {}

  /**
   * Filing is an annotation on a build, so it authorizes as one:
   * `deployments.update`, the same capability that already gates reading that
   * build's runtime logs — which is exactly what filing captures.
   */
  async create(
    deploymentId: string,
    dto: CreateFindingDto,
    user: User,
  ): Promise<FindingView> {
    const deployment = await this.access.detail(
      deploymentId,
      user,
      'deployments.update',
    );

    const captured = await this.logs.capture(
      deploymentId,
      // The web container is what QA was looking at; anything still alive
      // beats a web service whose container is already gone.
      deployment.services.find((s) => s.isWeb && s.containerId) ??
        deployment.services.find((s) => s.containerId),
    );

    const row = await this.prisma.finding.create({
      data: {
        deploymentId,
        reportedByUserId: user.id,
        title: dto.title,
        body: dto.body ?? null,
        logSnapshotStatus: captured.status,
        logSnapshot: captured.text,
        logSnapshotTruncated: captured.truncated,
      },
      // Summary, not detail: the audit interceptor stores the response body,
      // and runtime logs are the reason filing needs `deployments.update` in
      // the first place — they do not belong copied into `audit_log`.
      select: FINDING_SELECT,
    });

    await this.notifyCreated(row.id, row.title, deployment, user);
    return toFindingView(row);
  }

  async listForDeployment(
    deploymentId: string,
    user: User,
    status?: FindingStatus,
  ): Promise<FindingView[]> {
    await this.access.authorize(deploymentId, user, 'deployments.read');
    return this.list({ deploymentId, status });
  }

  /**
   * The environment page's list. Note what it is NOT: a way to file against an
   * environment. Reading "everything open on QA-2" is the useful question;
   * *creating* against an environment is what makes a finding rot.
   */
  async listForEnvironment(
    environmentId: string,
    user: User,
    status?: FindingStatus,
  ): Promise<FindingView[]> {
    await this.access.authorizeEnvironment(
      environmentId,
      user,
      'deployments.read',
    );
    return this.list({ foundOn: { environmentId }, status });
  }

  async findOne(id: string, user: User): Promise<FindingDetail> {
    const finding = await this.context(id);
    await this.access.authorize(finding.deploymentId, user, 'deployments.read');

    const row = await this.prisma.finding.findUnique({
      where: { id },
      select: FINDING_DETAIL_SELECT,
    });
    if (!row) throw new NotFoundException('Finding not found');
    return toFindingDetail(row);
  }

  async updateStatus(
    id: string,
    dto: UpdateFindingDto,
    user: User,
  ): Promise<FindingView> {
    const finding = await this.context(id);
    await this.access.authorize(
      finding.deploymentId,
      user,
      'deployments.update',
    );

    const patch = resolveTransition({
      current: finding.status,
      next: dto.status,
      actorUserId: user.id,
      latestSucceededDeploymentId:
        dto.status === FindingStatus.FIXED && finding.status !== dto.status
          ? await this.latestSucceededDeploymentId(
              finding.foundOn.environmentId,
            )
          : null,
      now: new Date(),
    });
    // Already in that state: no write, no timestamp churn, and above all no
    // second notification for a repeated click.
    if (!patch) return this.view(id);

    let row;
    try {
      row = await this.prisma.finding.update({
        where: { id },
        data: patch,
        select: FINDING_SELECT,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Finding not found');
      }
      throw err;
    }

    if (isResolution(patch)) {
      await this.notifyResolved(finding, row, user, patch.resolvedAt);
    }
    return toFindingView(row);
  }

  private async list(where: Prisma.FindingWhereInput): Promise<FindingView[]> {
    const rows = await this.prisma.finding.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_FINDINGS,
      select: FINDING_SELECT,
    });
    return rows.map(toFindingView);
  }

  private async view(id: string): Promise<FindingView> {
    const row = await this.prisma.finding.findUnique({
      where: { id },
      select: FINDING_SELECT,
    });
    if (!row) throw new NotFoundException('Finding not found');
    return toFindingView(row);
  }

  private async context(id: string): Promise<FindingContext> {
    const finding = await this.prisma.finding.findUnique({
      where: { id },
      select: FINDING_CONTEXT_SELECT,
    });
    if (!finding) throw new NotFoundException('Finding not found');
    return finding;
  }

  /**
   * The build a fix landed in: whatever the environment last shipped
   * successfully. If that is the same build the finding was found on, it is
   * still recorded — a config or data fix genuinely is fixed on that build, and
   * saying so is more honest than leaving the field empty.
   */
  private async latestSucceededDeploymentId(
    environmentId: string,
  ): Promise<string | null> {
    const latest = await this.prisma.deployment.findFirst({
      where: { environmentId, status: 'SUCCEEDED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return latest?.id ?? null;
  }

  private async notifyCreated(
    findingId: string,
    title: string,
    deployment: DeploymentDetail,
    reporter: User,
  ): Promise<void> {
    await this.dispatch(
      INBOX_ONLY_EVENTS.FindingCreated,
      {
        projectId: deployment.environment.project.id,
        projectName: deployment.environment.project.name,
        environmentId: deployment.environment.id,
        environmentName: deployment.environment.name,
        findingId,
        title,
        status: FindingStatus.OPEN,
        deploymentId: deployment.id,
        commitSha: deployment.commitSha,
        deployedByUserId: deployment.triggeredByUserId,
        reportedByUserId: reporter.id,
        reportedByName: displayNameOf(reporter),
        resolvedByUserId: null,
        resolvedByName: null,
        fixedInCommitSha: null,
      },
      `finding:${findingId}:created`,
    );
  }

  private async notifyResolved(
    finding: FindingContext,
    row: {
      status: FindingStatus;
      fixedIn: { commitSha: string | null } | null;
    },
    resolver: User,
    resolvedAt: Date | null,
  ): Promise<void> {
    const environment = finding.foundOn.environment;
    await this.dispatch(
      INBOX_ONLY_EVENTS.FindingResolved,
      {
        projectId: environment.project.id,
        projectName: environment.project.name,
        environmentId: environment.id,
        environmentName: environment.name,
        findingId: finding.id,
        title: finding.title,
        status: row.status,
        deploymentId: finding.deploymentId,
        commitSha: finding.foundOn.commitSha,
        deployedByUserId: null,
        reportedByUserId: finding.reportedByUserId,
        reportedByName: null,
        resolvedByUserId: resolver.id,
        resolvedByName: displayNameOf(resolver),
        fixedInCommitSha: row.fixedIn?.commitSha ?? null,
      },
      // Per transition, not per finding: a finding can be reopened and fixed
      // again, and the second fix is news.
      `finding:${finding.id}:resolved:${resolvedAt?.toISOString() ?? ''}`,
    );
  }

  /**
   * `draftsFor` is the only thing that decides whether anyone is told — no
   * recipient means no row, never a fallback fan-out. A failure to notify must
   * not undo the finding: the record is the feature, the nudge is the courtesy.
   */
  private async dispatch(
    event:
      | typeof INBOX_ONLY_EVENTS.FindingCreated
      | typeof INBOX_ONLY_EVENTS.FindingResolved,
    finding: FindingFacts,
    dedupeKey: string,
  ): Promise<void> {
    try {
      for (const draft of draftsFor({ event, finding })) {
        await this.inbox.create(draft, dedupeKey);
      }
    } catch (err) {
      this.logger.error(
        `notifying ${event} for finding ${finding.findingId} failed`,
        err,
      );
    }
  }
}
