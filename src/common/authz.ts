import { ForbiddenException } from '@nestjs/common';
import { OrgRole, type User } from '@prisma/client';

// Capabilities, scoped to an organization. A caller's OrgMembership role in the
// resource's org is matched against ROLE_CAPABILITIES (see AuthzService).
export type Action =
  // reads — every role, membership is the gate
  | 'projects.read'
  | 'environments.read'
  | 'deployments.read'
  | 'databases.read'
  | 'snapshots.read'
  | 'members.read'
  // writes / manage — Owner, Admin, Member (not Viewer)
  | 'projects.create'
  | 'projects.update'
  | 'environments.update'
  | 'environments.delete'
  | 'deployments.create'
  | 'deployments.update'
  | 'deployments.cancel'
  | 'deployments.exec'
  | 'databases.create'
  | 'databases.delete'
  | 'snapshots.create'
  | 'snapshots.restore'
  | 'snapshots.delete'
  // admin-level — Owner, Admin
  | 'projects.delete'
  | 'projects.transfer'
  | 'members.manage'
  | 'audit.read'
  | 'notifications.read'
  | 'notifications.manage'
  | 'jira.read'
  | 'jira.manage'
  | 'git.manage'
  // owner-only — rename/delete org, transfer ownership
  | 'org.update'
  | 'org.delete'
  | 'org.transfer';

// Approved role → capability matrix (teams-orgs-rbac spec). OWNER is a strict
// superset of ADMIN, which is a strict superset of MEMBER, which adds writes
// over VIEWER's read-only set. Built additively so the layering is obvious.
const READ_ACTIONS: Action[] = [
  'projects.read',
  'environments.read',
  'deployments.read',
  'databases.read',
  'snapshots.read',
  'members.read',
];

const WRITE_ACTIONS: Action[] = [
  'projects.create',
  'projects.update',
  'environments.update',
  'environments.delete',
  'deployments.create',
  'deployments.update',
  'deployments.cancel',
  'deployments.exec',
  'databases.create',
  'databases.delete',
  'snapshots.create',
  'snapshots.restore',
  'snapshots.delete',
];

// Notification channels hold a webhook URL, which is a bearer credential for
// posting into someone's Slack — so both reading and managing them are
// admin-level, not a Member write.
const ADMIN_ACTIONS: Action[] = [
  'projects.delete',
  'projects.transfer',
  'members.manage',
  'audit.read',
  'notifications.read',
  'notifications.manage',
  // Pointing an org at a Jira site decides where every member's branch labels
  // are resolved from, so it sits with the other admin-level settings. Members
  // never read this directly — the API resolves labels for them.
  'jira.read',
  'jira.manage',
  // The org's GitHub credential is the same class of thing, one step sharper:
  // it is the single account every member's deploys clone and comment as, and
  // it decides whether members may add their own at all. Members never touch
  // it — the API resolves it for them.
  'git.manage',
];

const OWNER_ACTIONS: Action[] = ['org.update', 'org.delete', 'org.transfer'];

const VIEWER = READ_ACTIONS;
const MEMBER = [...VIEWER, ...WRITE_ACTIONS];
const ADMIN = [...MEMBER, ...ADMIN_ACTIONS];
const OWNER = [...ADMIN, ...OWNER_ACTIONS];

export const ROLE_CAPABILITIES: Record<OrgRole, ReadonlySet<Action>> = {
  [OrgRole.OWNER]: new Set(OWNER),
  [OrgRole.ADMIN]: new Set(ADMIN),
  [OrgRole.MEMBER]: new Set(MEMBER),
  [OrgRole.VIEWER]: new Set(VIEWER),
};

// Org-scoped resources expose the organization that owns them; the resource's
// org is resolved (often via its parent project) before authorizing.
export interface OrgScopedResource {
  organizationId: string;
}

// Personal resources are not org-scoped: a user's GitHub integration token and
// their own audit trail belong to the user, regardless of any org role. Only
// the owner (or a platform admin) may act on them.
export function ensureSelf(
  user: Pick<User, 'id' | 'role'>,
  ownerId: string,
): void {
  if (user.role !== 'ADMIN' && ownerId !== user.id) {
    throw new ForbiddenException('Not allowed');
  }
}
