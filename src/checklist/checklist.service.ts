import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ChecklistItemSource,
  CheckResult,
  Prisma,
  type User,
} from '@prisma/client';
import { DeploymentAccessService } from '../deployments/deployment-access.service';
import { DeploymentChangesService } from '../deployments/deployment-changes.service';
import { FindingsService } from '../findings/findings.service';
import { DEPLOYMENT_REF_SELECT } from '../findings/finding.view';
import { PrismaService } from '../prisma/prisma.service';
import { nextFindingId } from './checklist-summary';
import {
  CHECKLIST_CHECK_SELECT,
  CHECKLIST_ITEM_SELECT,
  toChecklistView,
  toItemView,
  type ChecklistItemView,
  type ChecklistView,
} from './checklist.view';
import { seedRows } from './seed-items';
import type { CheckItemDto } from './dto/check-item.dto';
import type { CreateChecklistItemDto } from './dto/create-checklist-item.dto';

/**
 * A checklist is a hand-kept list, not a feed, so it is read whole. The cap is
 * a backstop against an environment nobody ever prunes; past it the summary
 * describes what was returned, which is the honest reading of a truncated list.
 */
const MAX_CHECKLIST_ITEMS = 500;

// The build being ticked against: the wire reference plus the environment the
// items actually hang off.
const BUILD_SELECT = {
  ...DEPLOYMENT_REF_SELECT,
  environmentId: true,
} satisfies Prisma.DeploymentSelect;

type Build = Prisma.DeploymentGetPayload<{ select: typeof BUILD_SELECT }>;

type CheckRow = Prisma.ChecklistCheckGetPayload<{
  select: typeof CHECKLIST_CHECK_SELECT;
}>;

@Injectable()
export class ChecklistService {
  private readonly logger = new Logger(ChecklistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DeploymentAccessService,
    private readonly changes: DeploymentChangesService,
    private readonly findings: FindingsService,
  ) {}

  /**
   * Pure read. Seeding is a write with a button of its own — a GET that quietly
   * created rows would make every page load a mutation, and the count of what
   * *would* be added is what the UI needs to offer that button anyway.
   */
  async forDeployment(
    deploymentId: string,
    user: User,
  ): Promise<ChecklistView> {
    const build = await this.build(deploymentId, user, 'deployments.read');
    const [items, seedable] = await Promise.all([
      this.itemViews(build, { environmentId: build.environmentId }),
      this.seedableCount(build, user),
    ]);
    return toChecklistView({ deployment: build, items, seedable });
  }

  /**
   * Idempotent by construction: every seeded row carries a `seedKey` under a
   * partial unique index, so seeding the same range twice adds nothing. Running
   * it after a new deploy adds only what that deploy brought.
   */
  async seed(deploymentId: string, user: User): Promise<ChecklistView> {
    const build = await this.build(deploymentId, user, 'deployments.update');
    const commits = await this.rangeCommits(build.id, user);
    const rows = seedRows(
      commits,
      await this.existingSeedKeys(build.environmentId),
    );

    if (rows.length > 0) {
      await this.prisma.checklistItem.createMany({
        data: rows.map((row) => ({
          environmentId: build.environmentId,
          source: ChecklistItemSource.SEEDED,
          ...row,
        })),
        // The unique index is the real guard; this keeps a concurrent second
        // click a no-op rather than a 409 the user cannot act on.
        skipDuplicates: true,
      });
    }

    const [items, remainingKeys] = await Promise.all([
      this.itemViews(build, { environmentId: build.environmentId }),
      this.existingSeedKeys(build.environmentId),
    ]);
    return toChecklistView({
      deployment: build,
      items,
      seedable: seedRows(commits, remainingKeys).length,
    });
  }

  /**
   * Authorized through the build, not the environment, so the caller is always
   * looking at a concrete deployment when they add a chore to its list — the
   * same reason there is no `POST /environments/:id/checklist/items`.
   */
  async createItem(
    deploymentId: string,
    dto: CreateChecklistItemDto,
    user: User,
  ): Promise<ChecklistItemView> {
    const build = await this.build(deploymentId, user, 'deployments.update');
    const item = await this.prisma.checklistItem.create({
      data: {
        environmentId: build.environmentId,
        title: dto.title,
        source: ChecklistItemSource.MANUAL,
        createdByUserId: user.id,
      },
      select: { id: true },
    });
    return this.itemView(build, item.id);
  }

  async deleteItem(itemId: string, user: User): Promise<void> {
    const item = await this.prisma.checklistItem.findUnique({
      where: { id: itemId },
      select: { environmentId: true },
    });
    if (!item) throw new NotFoundException('Checklist item not found');
    await this.access.authorizeEnvironment(
      item.environmentId,
      user,
      'deployments.update',
    );
    await this.prisma.checklistItem.delete({ where: { id: itemId } });
  }

  /**
   * One fact per item per build, so this upserts rather than appends — a second
   * opinion replaces the first and the row records who holds it.
   */
  async check(
    deploymentId: string,
    itemId: string,
    dto: CheckItemDto,
    user: User,
  ): Promise<ChecklistItemView> {
    const build = await this.build(deploymentId, user, 'deployments.update');
    await this.assertItemOn(build.environmentId, itemId);

    const previous = await this.prisma.checklistCheck.findUnique({
      where: { itemId_deploymentId: { itemId, deploymentId } },
      select: { result: true, findingId: true },
    });

    // Filing goes through FindingsService so the log snapshot, the audit trail
    // and the inbox notification happen exactly once, in the place that owns
    // them. Nothing about a finding is written here.
    const filed =
      dto.result === CheckResult.FAIL && dto.finding
        ? await this.findings.create(deploymentId, dto.finding, user)
        : null;

    const findingId = nextFindingId({
      previous,
      result: dto.result,
      filedFindingId: filed?.id ?? null,
    });
    const note = dto.note ?? null;

    await this.prisma.checklistCheck.upsert({
      where: { itemId_deploymentId: { itemId, deploymentId } },
      create: {
        itemId,
        deploymentId,
        result: dto.result,
        note,
        findingId,
        checkedByUserId: user.id,
      },
      update: {
        result: dto.result,
        note,
        findingId,
        checkedByUserId: user.id,
        // The row has no updatedAt: it holds one fact, and when that fact was
        // last asserted is the timestamp worth showing next to who asserted it.
        createdAt: new Date(),
      },
    });
    return this.itemView(build, itemId);
  }

  /** Undoing a tick, not recording a third result — the item goes back to remaining. */
  async uncheck(
    deploymentId: string,
    itemId: string,
    user: User,
  ): Promise<ChecklistItemView> {
    const build = await this.build(deploymentId, user, 'deployments.update');
    await this.assertItemOn(build.environmentId, itemId);
    // deleteMany: unchecking something that was never checked is the state the
    // caller asked for, not a 404.
    await this.prisma.checklistCheck.deleteMany({
      where: { itemId, deploymentId },
    });
    return this.itemView(build, itemId);
  }

  private async build(
    deploymentId: string,
    user: User,
    action: 'deployments.read' | 'deployments.update',
  ): Promise<Build> {
    await this.access.authorize(deploymentId, user, action);
    const build = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: BUILD_SELECT,
    });
    if (!build) throw new NotFoundException('Deployment not found');
    return build;
  }

  private async assertItemOn(
    environmentId: string,
    itemId: string,
  ): Promise<void> {
    const item = await this.prisma.checklistItem.findFirst({
      where: { id: itemId, environmentId },
      select: { id: true },
    });
    // Ticking an item that belongs to a different environment is not a
    // permission problem, it is a nonexistent row on this list.
    if (!item) throw new NotFoundException('Checklist item not found');
  }

  private async itemView(
    build: Build,
    itemId: string,
  ): Promise<ChecklistItemView> {
    const [view] = await this.itemViews(build, { id: itemId });
    if (!view) throw new NotFoundException('Checklist item not found');
    return view;
  }

  private async itemViews(
    build: Build,
    where: Prisma.ChecklistItemWhereInput,
  ): Promise<ChecklistItemView[]> {
    const items = await this.prisma.checklistItem.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_CHECKLIST_ITEMS,
      select: CHECKLIST_ITEM_SELECT,
    });
    if (items.length === 0) return [];

    const checks = await this.relevantChecks(
      items.map((i) => i.id),
      build,
    );
    return items.map((item) => toItemView(item, checks.get(item.id), build.id));
  }

  /**
   * The newest check per item on a build at or before the one being viewed —
   * which is `check` when it landed on this build and `lastCheck` when it did
   * not. Checks made on *later* builds are excluded: looking at an old
   * deployment must not show a tick that had not happened yet.
   *
   * Raw because this is a per-item argmax; the alternative is loading every
   * check every item ever collected and picking in memory, which grows with the
   * environment's whole deploy history.
   */
  private async relevantChecks(
    itemIds: string[],
    build: Build,
  ): Promise<Map<string, CheckRow>> {
    const ids = Prisma.join(itemIds.map((id) => Prisma.sql`${id}::uuid`));
    const picked = await this.prisma.$queryRaw<
      { itemId: string; checkId: string }[]
    >`
      SELECT DISTINCT ON (c.item_id) c.item_id AS "itemId", c.id AS "checkId"
      FROM checklist_checks c
      JOIN deployments d ON d.id = c.deployment_id
      WHERE c.item_id IN (${ids})
        AND d.created_at <= ${build.createdAt}::timestamptz
      ORDER BY c.item_id,
               (c.deployment_id = ${build.id}::uuid) DESC,
               d.created_at DESC,
               d.id DESC
    `;
    if (picked.length === 0) return new Map();

    const rows = await this.prisma.checklistCheck.findMany({
      where: { id: { in: picked.map((p) => p.checkId) } },
      select: CHECKLIST_CHECK_SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const byItem = new Map<string, CheckRow>();
    for (const { itemId, checkId } of picked) {
      const row = byId.get(checkId);
      if (row) byItem.set(itemId, row);
    }
    return byItem;
  }

  private async existingSeedKeys(environmentId: string): Promise<string[]> {
    const rows = await this.prisma.checklistItem.findMany({
      where: { environmentId, seedKey: { not: null } },
      select: { seedKey: true },
    });
    return rows.map((row) => row.seedKey!);
  }

  private async seedableCount(build: Build, user: User): Promise<number> {
    const commits = await this.rangeCommits(build.id, user);
    if (commits.length === 0) return 0;
    return seedRows(commits, await this.existingSeedKeys(build.environmentId))
      .length;
  }

  /**
   * What this build brought. Decoration for the checklist rather than its
   * substance: GitHub being unreachable costs the seed button, never the list.
   */
  private async rangeCommits(deploymentId: string, user: User) {
    try {
      const changes = await this.changes.forDeployment(deploymentId, user.id);
      return changes.commits;
    } catch (err) {
      this.logger.error(
        `resolving the change range for deployment ${deploymentId} failed`,
        err,
      );
      return [];
    }
  }
}
