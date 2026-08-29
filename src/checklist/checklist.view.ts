import type { ChecklistItemSource, CheckResult, Prisma } from '@prisma/client';
import { USER_REF_SELECT, type UserRef } from '../common/user-ref';
import {
  DEPLOYMENT_REF_SELECT,
  toDeploymentRef,
  type DeploymentRef,
} from '../findings/finding.view';
import { summarize, type ChecklistSummary } from './checklist-summary';

/**
 * A tick, and the build it was made against. The build is on every check for
 * the same reason it is on every finding: the client compares its id with the
 * build being viewed to tell "checked here" from "checked two deploys ago".
 */
export interface ChecklistCheckView {
  id: string;
  result: CheckResult;
  note: string | null;
  findingId: string | null;
  checkedBy: UserRef | null;
  createdAt: string;
  build: DeploymentRef;
}

export interface ChecklistItemView {
  id: string;
  title: string;
  source: ChecklistItemSource;
  issueKey: string | null;
  issueUrl: string | null;
  createdBy: UserRef | null;
  createdAt: string;
  /** The check on the build being viewed. */
  check: ChecklistCheckView | null;
  /** Newest check on an earlier build. Always null when `check` is set. */
  lastCheck: ChecklistCheckView | null;
}

export interface ChecklistView {
  deployment: DeploymentRef;
  items: ChecklistItemView[];
  summary: ChecklistSummary;
  /** Rows a seed would add right now. Zero means the button has nothing to do. */
  seedable: number;
}

export const CHECKLIST_CHECK_SELECT = {
  id: true,
  result: true,
  note: true,
  findingId: true,
  createdAt: true,
  checkedBy: { select: USER_REF_SELECT },
  build: { select: DEPLOYMENT_REF_SELECT },
} satisfies Prisma.ChecklistCheckSelect;

export const CHECKLIST_ITEM_SELECT = {
  id: true,
  title: true,
  source: true,
  issueKey: true,
  issueUrl: true,
  createdAt: true,
  createdBy: { select: USER_REF_SELECT },
} satisfies Prisma.ChecklistItemSelect;

type ChecklistCheckRow = Prisma.ChecklistCheckGetPayload<{
  select: typeof CHECKLIST_CHECK_SELECT;
}>;
type ChecklistItemRow = Prisma.ChecklistItemGetPayload<{
  select: typeof CHECKLIST_ITEM_SELECT;
}>;

export function toCheckView(row: ChecklistCheckRow): ChecklistCheckView {
  return {
    id: row.id,
    result: row.result,
    note: row.note,
    findingId: row.findingId,
    checkedBy: row.checkedBy,
    createdAt: row.createdAt.toISOString(),
    build: toDeploymentRef(row.build),
  };
}

/**
 * One query answers both `check` and `lastCheck`: the newest check on a build
 * at or before the one being viewed is either on that build or on an earlier
 * one, and which it is decides the field it lands in.
 */
export function toItemView(
  row: ChecklistItemRow,
  relevant: ChecklistCheckRow | undefined,
  deploymentId: string,
): ChecklistItemView {
  const check = relevant ? toCheckView(relevant) : null;
  const onThisBuild = check?.build.id === deploymentId;
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    issueKey: row.issueKey,
    issueUrl: row.issueUrl,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    check: onThisBuild ? check : null,
    lastCheck: onThisBuild ? null : check,
  };
}

export function toChecklistView(input: {
  deployment: Prisma.DeploymentGetPayload<{
    select: typeof DEPLOYMENT_REF_SELECT;
  }>;
  items: ChecklistItemView[];
  seedable: number;
}): ChecklistView {
  return {
    deployment: toDeploymentRef(input.deployment),
    items: input.items,
    summary: summarize(input.items),
    seedable: input.seedable,
  };
}
