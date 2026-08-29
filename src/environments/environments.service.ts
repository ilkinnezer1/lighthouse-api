import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type EnvironmentType } from '@prisma/client';
import { buildDeployUrl } from '../common/url';
import { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { HIBERNATION_SELECT, withHibernation } from './environment-hibernation';
import { LOCK_SELECT, withLock } from './environment-lock';

@Injectable()
export class EnvironmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Every environment in one org, newest project activity first, each carrying
   * the deployment currently on it.
   *
   * This is the "what is on which sandbox right now" view: the per-project pages
   * answer it one project at a time, which is the wrong shape for anyone testing
   * across several. The latest deployment is fetched as a bounded nested read
   * (one row per environment), so the page costs a single query rather than one
   * per environment.
   */
  async listForOrg(
    organizationId: string,
    opts: {
      limit?: number;
      cursor?: string;
      projectId?: string;
      type?: EnvironmentType;
      active?: boolean;
    } = {},
  ) {
    const limit = opts.limit ?? 20;
    const where: Prisma.EnvironmentWhereInput = {
      type: opts.type,
      active: opts.active,
      project: {
        deletedAt: null,
        id: opts.projectId,
        organizationId,
      },
    };

    const rows = await this.prisma.environment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        type: true,
        branch: true,
        subdomain: true,
        customDomain: true,
        active: true,
        createdAt: true,
        ...LOCK_SELECT,
        ...HIBERNATION_SELECT,
        project: {
          select: {
            id: true,
            name: true,
            subdomain: true,
            owner: { select: { username: true } },
            organization: {
              select: { slug: true, atlassianSiteUrl: true },
            },
          },
        },
        deployments: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            id: true,
            status: true,
            createdAt: true,
            finishedAt: true,
            commitSha: true,
            commitMessage: true,
            errorSummary: true,
            branches: {
              orderBy: { ordinal: 'asc' },
              select: {
                role: true,
                name: true,
                issueKey: true,
                issueTitle: true,
              },
            },
          },
        },
      },
    });

    const page = rows.slice(0, limit);
    const ids = page.map((r) => r.id);
    const [openFindings, checklists] = await Promise.all([
      this.openFindingCounts(ids),
      this.checklistProgress(ids),
    ]);
    const now = new Date();
    return {
      items: page.map(({ deployments, ...row }) => ({
        ...withHibernation(withLock(row, now)),
        url: buildDeployUrl({
          mode: this.config.get('MODE', { infer: true }),
          baseDomain: this.config.get('BASE_DOMAIN', { infer: true }),
          identity: row.project.organization.slug,
          projectSubdomain: row.project.subdomain,
          envSubdomain: row.subdomain,
          customDomain: row.customDomain,
        }),
        // Null for an environment that has never been deployed — a real state
        // the board has to show, not an error.
        latestDeployment: deployments[0] ?? null,
        openFindingCount: openFindings.get(row.id) ?? 0,
        // Null, not a zeroed object: an environment nobody has put a checklist
        // on has no progress to report, which is different from one where
        // everything is still outstanding.
        checklist: checklists.get(row.id) ?? null,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /**
   * Open findings per environment for the page that was just fetched — one
   * grouped aggregate for the whole board, not a count per row, which is what
   * would turn this feed into an N+1.
   *
   * Raw because the join is `findings -> deployments -> environment`, and
   * Prisma can only count a relation one hop away. The alternative is a
   * denormalised `environment_id` on `findings`, which is exactly the copied
   * fact the model refuses to keep: a finding's environment is a property of
   * the build it was found on, and only ever knowable from there.
   */
  private async openFindingCounts(
    environmentIds: string[],
  ): Promise<Map<string, number>> {
    if (environmentIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<
      { environmentId: string; count: bigint }[]
    >`
      SELECT d.environment_id AS "environmentId", COUNT(*) AS count
      FROM findings f
      JOIN deployments d ON d.id = f.deployment_id
      WHERE f.status = 'OPEN'
        AND d.environment_id IN (${Prisma.join(
          environmentIds.map((id) => Prisma.sql`${id}::uuid`),
        )})
      GROUP BY d.environment_id
    `;
    return new Map(rows.map((r) => [r.environmentId, Number(r.count)]));
  }

  /**
   * Checklist progress per environment, measured against the build the board
   * is already showing as current — its latest SUCCEEDED deployment.
   *
   * `remaining` counts items with no check on *that* build, so an item ticked
   * two deploys ago is outstanding again the moment the code moves. An
   * environment that has never succeeded has no build to have tested, so every
   * item is remaining — which is what the LEFT JOIN on a null deployment gives
   * for free.
   */
  private async checklistProgress(
    environmentIds: string[],
  ): Promise<Map<string, { total: number; remaining: number }>> {
    if (environmentIds.length === 0) return new Map();

    const ids = Prisma.join(
      environmentIds.map((id) => Prisma.sql`${id}::uuid`),
    );
    const rows = await this.prisma.$queryRaw<
      { environmentId: string; total: bigint; remaining: bigint }[]
    >`
      WITH current_build AS (
        SELECT DISTINCT ON (d.environment_id)
               d.environment_id, d.id
        FROM deployments d
        WHERE d.environment_id IN (${ids})
          AND d.status = 'SUCCEEDED'
        ORDER BY d.environment_id, d.created_at DESC, d.id DESC
      )
      SELECT i.environment_id AS "environmentId",
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE c.id IS NULL) AS remaining
      FROM checklist_items i
      LEFT JOIN current_build b ON b.environment_id = i.environment_id
      LEFT JOIN checklist_checks c
             ON c.item_id = i.id AND c.deployment_id = b.id
      WHERE i.environment_id IN (${ids})
      GROUP BY i.environment_id
    `;
    return new Map(
      rows.map((r) => [
        r.environmentId,
        { total: Number(r.total), remaining: Number(r.remaining) },
      ]),
    );
  }
}
