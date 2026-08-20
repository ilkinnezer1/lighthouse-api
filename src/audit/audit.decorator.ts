import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit';

/**
 * Every action name the audit log may record. A closed union so a typo is a
 * compile error rather than a row nobody will ever find again — the action
 * column is what audit views filter on.
 */
export type AuditAction =
  | 'backups.schedule'
  | 'backups.schedule-delete'
  | 'backups.schedule-update'
  | 'databases.create'
  | 'databases.delete'
  | 'deployments.action'
  | 'deployments.cancel'
  | 'deployments.create'
  | 'deployments.logs'
  | 'deployments.redeploy'
  | 'deployments.rollback'
  | 'deployments.service-action'
  | 'env-vars.delete'
  | 'env-vars.replace'
  | 'env-vars.update'
  | 'environments.domain-clear'
  | 'environments.domain-set'
  | 'environments.file'
  | 'environments.force_unlock'
  | 'environments.lock'
  | 'environments.reset'
  | 'environments.unlock'
  | 'environments.volume-delete'
  | 'integrations.connect'
  | 'integrations.disconnect'
  | 'invitations.accept'
  | 'invitations.create'
  | 'invitations.decline'
  | 'invitations.revoke'
  | 'members.remove'
  | 'members.update'
  | 'notifications.channel-create'
  | 'notifications.channel-delete'
  | 'notifications.channel-test'
  | 'notifications.channel-update'
  | 'orgs.create'
  | 'orgs.delete'
  | 'orgs.jira-clear'
  | 'orgs.jira-set'
  | 'orgs.update'
  | 'projects.create'
  | 'projects.delete'
  | 'projects.transfer'
  | 'projects.update'
  | 'scheduled-tasks.create'
  | 'scheduled-tasks.delete'
  | 'scheduled-tasks.run'
  | 'scheduled-tasks.update'
  | 'snapshots.create'
  | 'snapshots.delete'
  | 'snapshots.restore'
  | 'snapshots.update'
  | 'templates.instantiate'
  | 'users.login'
  | 'users.logout'
  | 'users.signup'
  | 'volumes.backup'
  | 'volumes.backup-delete'
  | 'volumes.backup-update'
  | 'volumes.restore';

export interface AuditMetadata {
  action: AuditAction;
}

export const Audit = (action: AuditAction) =>
  SetMetadata(AUDIT_KEY, { action });
