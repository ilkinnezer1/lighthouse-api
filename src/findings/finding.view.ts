import type {
  DeploymentStatus,
  FindingStatus,
  LogSnapshotStatus,
  Prisma,
} from '@prisma/client';
import { USER_REF_SELECT, type UserRef } from '../common/user-ref';

/**
 * A build, as a finding points at it. `foundOn` is on every finding in every
 * response — the client compares its id against what is currently deployed to
 * tell "still on this build" from "found two builds ago", which is the whole
 * reason findings bind to a deployment.
 */
export interface DeploymentRef {
  id: string;
  status: DeploymentStatus;
  commitSha: string | null;
  commitMessage: string | null;
  createdAt: string;
}

export interface FindingView {
  id: string;
  title: string;
  body: string | null;
  status: FindingStatus;
  foundOn: DeploymentRef;
  fixedIn: DeploymentRef | null;
  reportedBy: UserRef | null;
  resolvedBy: UserRef | null;
  resolvedAt: string | null;
  logSnapshotStatus: LogSnapshotStatus;
  createdAt: string;
  updatedAt: string;
}

/** The single-finding payload. Lists never carry the snapshot text. */
export interface FindingDetail extends FindingView {
  logSnapshot: string | null;
  logSnapshotTruncated: boolean;
}

// Exported: the checklist renders the same build reference, and a second
// near-identical shape is how a client ends up with two "a build" types.
export const DEPLOYMENT_REF_SELECT = {
  id: true,
  status: true,
  commitSha: true,
  commitMessage: true,
  createdAt: true,
} satisfies Prisma.DeploymentSelect;

export const FINDING_SELECT = {
  id: true,
  title: true,
  body: true,
  status: true,
  resolvedAt: true,
  logSnapshotStatus: true,
  createdAt: true,
  updatedAt: true,
  foundOn: { select: DEPLOYMENT_REF_SELECT },
  fixedIn: { select: DEPLOYMENT_REF_SELECT },
  reportedBy: { select: USER_REF_SELECT },
  resolvedBy: { select: USER_REF_SELECT },
} satisfies Prisma.FindingSelect;

export const FINDING_DETAIL_SELECT = {
  ...FINDING_SELECT,
  logSnapshot: true,
  logSnapshotTruncated: true,
} satisfies Prisma.FindingSelect;

type FindingRow = Prisma.FindingGetPayload<{ select: typeof FINDING_SELECT }>;
type FindingDetailRow = Prisma.FindingGetPayload<{
  select: typeof FINDING_DETAIL_SELECT;
}>;

export function toFindingView(row: FindingRow): FindingView {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    foundOn: toDeploymentRef(row.foundOn),
    fixedIn: row.fixedIn ? toDeploymentRef(row.fixedIn) : null,
    reportedBy: row.reportedBy,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    logSnapshotStatus: row.logSnapshotStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toFindingDetail(row: FindingDetailRow): FindingDetail {
  return {
    ...toFindingView(row),
    logSnapshot: row.logSnapshot,
    logSnapshotTruncated: row.logSnapshotTruncated,
  };
}

export function toDeploymentRef(
  d: Prisma.DeploymentGetPayload<{ select: typeof DEPLOYMENT_REF_SELECT }>,
): DeploymentRef {
  return {
    id: d.id,
    status: d.status,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage,
    createdAt: d.createdAt.toISOString(),
  };
}
