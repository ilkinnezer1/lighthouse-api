import type { FindingStatus } from '@prisma/client';
import {
  INBOX_ONLY_EVENTS,
  NOTIFICATION_EVENTS,
  type InboxKind,
} from './notifications.constants';

/**
 * Who, if anyone, an event is addressed to — and what they should read.
 *
 * Pure on purpose: this predicate decides whether a person is told at all, so
 * a bug here either spams everybody or silently tells nobody. Every DB lookup
 * happens in the consumer and arrives here as facts.
 *
 * The rule the whole feature rests on: **only send what has a name attached.**
 * A missing recipient returns no drafts and the event stays a channel concern —
 * there is deliberately no org-wide fan-out anywhere in this file.
 */

/** Flat and denormalised so the client renders a sentence without resolving ids. */
export interface InboxContext {
  projectId?: string;
  projectName?: string;
  environmentId?: string;
  environmentName?: string;
  deploymentId?: string;
  commitSha?: string;
  findingId?: string;
}

export interface NotificationDraft {
  userId: string;
  kind: InboxKind;
  title: string;
  body: string | null;
  link: string | null;
  context: InboxContext;
}

interface Place {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
}

export interface DeploymentFacts extends Place {
  deploymentId: string;
  /**
   * The solid FK for "whose deploy is this". `commitAuthor` is a free-text git
   * name with no reliable route to a Lighthouse user, so it is never consulted.
   */
  triggeredByUserId: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  failure: string | null;
}

export interface LockFacts extends Place {
  lockedByUserId: string | null;
  /** Who walked through the lock; null for an automatic deploy nobody triggered. */
  overriddenByUserId: string | null;
  overriddenByName: string | null;
  reason: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  /** The deploy that went ahead anyway; absent when the push was skipped instead. */
  deploymentId: string | null;
}

export interface DatabaseFacts extends Place {
  databaseId: string;
  databaseName: string;
  /** Owner of the work: the actor who asked for it, else the project's owner. */
  ownerUserId: string | null;
  failure: string | null;
}

export interface FindingFacts extends Place {
  findingId: string;
  title: string;
  status: FindingStatus;
  /** The build it was found on — the whole point of a finding. */
  deploymentId: string;
  commitSha: string | null;
  /**
   * Who triggered the build the finding sits on. Not the commit author: that is
   * a free-text git name with no route to a Lighthouse user.
   */
  deployedByUserId: string | null;
  reportedByUserId: string | null;
  reportedByName: string | null;
  /** Who moved it out of OPEN; null while it is still open. */
  resolvedByUserId: string | null;
  resolvedByName: string | null;
  /** The build recorded as the fix, for the sentence the resolver's message reads. */
  fixedInCommitSha: string | null;
}

type DeployEvent =
  | typeof NOTIFICATION_EVENTS.DeploySucceeded
  | typeof NOTIFICATION_EVENTS.DeployFailed
  | typeof NOTIFICATION_EVENTS.DeployCancelled;

type LockEvent =
  | typeof NOTIFICATION_EVENTS.DeploySkippedLocked
  | typeof NOTIFICATION_EVENTS.LockOverridden;

type DatabaseEvent =
  | typeof NOTIFICATION_EVENTS.DatabaseProvisionFailed
  | typeof NOTIFICATION_EVENTS.SnapshotFailed;

type FindingEvent =
  | typeof INBOX_ONLY_EVENTS.FindingCreated
  | typeof INBOX_ONLY_EVENTS.FindingResolved;

export type NotificationSubject =
  | { event: DeployEvent; deployment: DeploymentFacts }
  | { event: LockEvent; lock: LockFacts }
  | { event: DatabaseEvent; database: DatabaseFacts }
  | { event: FindingEvent; finding: FindingFacts };

export function draftsFor(subject: NotificationSubject): NotificationDraft[] {
  switch (subject.event) {
    case NOTIFICATION_EVENTS.DeploySucceeded:
    case NOTIFICATION_EVENTS.DeployFailed:
    case NOTIFICATION_EVENTS.DeployCancelled:
      return deployDrafts(subject.event, subject.deployment);
    case NOTIFICATION_EVENTS.DeploySkippedLocked:
      return skippedLockedDrafts(subject.lock);
    case NOTIFICATION_EVENTS.LockOverridden:
      return lockOverriddenDrafts(subject.lock);
    case NOTIFICATION_EVENTS.DatabaseProvisionFailed:
    case NOTIFICATION_EVENTS.SnapshotFailed:
      return databaseDrafts(subject.event, subject.database);
    case INBOX_ONLY_EVENTS.FindingCreated:
      return findingCreatedDrafts(subject.finding);
    case INBOX_ONLY_EVENTS.FindingResolved:
      return findingResolvedDrafts(subject.finding);
  }
}

/** The person who asked for the deploy is the only one with a stake in it. */
function deployDrafts(
  event: DeployEvent,
  d: DeploymentFacts,
): NotificationDraft[] {
  if (!d.triggeredByUserId) return [];

  const where = `${d.projectName} / ${d.environmentName}`;
  const commit = commitText(d.commitSha, d.commitMessage);
  const title =
    event === NOTIFICATION_EVENTS.DeploySucceeded
      ? `Deploy succeeded — ${where}`
      : event === NOTIFICATION_EVENTS.DeployFailed
        ? `Deploy failed — ${where}`
        : `Deploy cancelled — ${where}`;

  return [
    {
      userId: d.triggeredByUserId,
      kind: event,
      title,
      body: event === NOTIFICATION_EVENTS.DeployFailed ? d.failure : commit,
      link: `/deployments/${d.deploymentId}`,
      context: {
        ...place(d),
        deploymentId: d.deploymentId,
        ...(d.commitSha ? { commitSha: d.commitSha } : {}),
      },
    },
  ];
}

/**
 * The holder, not the pusher: they are the reason it did not ship, and nobody
 * else can act on it. There is no deployment row to link to, so this lands on
 * the environment.
 */
function skippedLockedDrafts(l: LockFacts): NotificationDraft[] {
  if (!l.lockedByUserId) return [];

  const commit = commitText(l.commitSha, l.commitMessage);
  const because = l.reason ? ` (${l.reason})` : '';
  return [
    {
      userId: l.lockedByUserId,
      kind: NOTIFICATION_EVENTS.DeploySkippedLocked,
      title: `Push not deployed — ${l.projectName} / ${l.environmentName} is locked`,
      body: `${commit ?? 'A push'} was not deployed because you hold the lock${because}.`,
      link: `/projects/${l.projectId}/env/${l.environmentId}`,
      context: {
        ...place(l),
        ...(l.commitSha ? { commitSha: l.commitSha } : {}),
      },
    },
  ];
}

/** Also the holder — and never themselves, whoever ends up in the payload. */
function lockOverriddenDrafts(l: LockFacts): NotificationDraft[] {
  if (!l.lockedByUserId) return [];
  if (l.lockedByUserId === l.overriddenByUserId) return [];

  const who = l.overriddenByName ?? 'Somebody';
  return [
    {
      userId: l.lockedByUserId,
      kind: NOTIFICATION_EVENTS.LockOverridden,
      title: `Lock overridden — ${l.projectName} / ${l.environmentName}`,
      body: `${who} deployed to ${l.environmentName} while you held the lock.`,
      link: l.deploymentId
        ? `/deployments/${l.deploymentId}`
        : `/projects/${l.projectId}/env/${l.environmentId}`,
      context: {
        ...place(l),
        ...(l.deploymentId ? { deploymentId: l.deploymentId } : {}),
        ...(l.commitSha ? { commitSha: l.commitSha } : {}),
      },
    },
  ];
}

function databaseDrafts(
  event: DatabaseEvent,
  d: DatabaseFacts,
): NotificationDraft[] {
  if (!d.ownerUserId) return [];

  const verb =
    event === NOTIFICATION_EVENTS.DatabaseProvisionFailed
      ? 'Database provisioning failed'
      : 'Snapshot failed';
  return [
    {
      userId: d.ownerUserId,
      kind: event,
      title: `${verb} — ${d.databaseName}`,
      body: d.failure,
      link: `/projects/${d.projectId}/env/${d.environmentId}/databases/${d.databaseId}`,
      context: place(d),
    },
  ];
}

/**
 * The person whose deploy it is. QA files against a build; the only person who
 * can act on it is whoever put that build there — and if that is the filer
 * themselves, nobody is told.
 */
function findingCreatedDrafts(f: FindingFacts): NotificationDraft[] {
  if (!f.deployedByUserId) return [];
  if (f.deployedByUserId === f.reportedByUserId) return [];

  const who = f.reportedByName ?? 'Someone';
  const on = f.commitSha ? ` on ${f.commitSha.slice(0, 7)}` : '';
  return [
    {
      userId: f.deployedByUserId,
      kind: INBOX_ONLY_EVENTS.FindingCreated,
      title: `New finding — ${f.projectName} / ${f.environmentName}`,
      body: `${f.title} — reported by ${who}${on}`,
      link: findingLink(f),
      context: findingContext(f),
    },
  ];
}

/**
 * Back to the filer: they are the one who has to retest, and "it's ready" is
 * the other half of the round-trip this feature exists to delete. Closing your
 * own finding tells nobody.
 */
function findingResolvedDrafts(f: FindingFacts): NotificationDraft[] {
  if (!f.reportedByUserId) return [];
  if (f.reportedByUserId === f.resolvedByUserId) return [];

  const who = f.resolvedByName ?? 'Someone';
  const fixed = f.status === 'FIXED';
  const fixedIn = f.fixedInCommitSha
    ? ` in ${f.fixedInCommitSha.slice(0, 7)}`
    : '';
  const verb = fixed ? `marked it fixed${fixedIn}` : 'could not reproduce it';

  return [
    {
      userId: f.reportedByUserId,
      kind: INBOX_ONLY_EVENTS.FindingResolved,
      title: `${fixed ? 'Finding fixed' : 'Finding closed'} — ${f.projectName} / ${f.environmentName}`,
      body: `${f.title} — ${who} ${verb}`,
      link: findingLink(f),
      context: findingContext(f),
    },
  ];
}

// The finding lives on its deployment's page; the id is a query param so the
// page can open straight onto it without needing a route of its own.
function findingLink(f: FindingFacts): string {
  return `/deployments/${f.deploymentId}?finding=${f.findingId}`;
}

function findingContext(f: FindingFacts): InboxContext {
  return {
    ...place(f),
    deploymentId: f.deploymentId,
    findingId: f.findingId,
    ...(f.commitSha ? { commitSha: f.commitSha } : {}),
  };
}

function place(p: Place): InboxContext {
  return {
    projectId: p.projectId,
    projectName: p.projectName,
    environmentId: p.environmentId,
    environmentName: p.environmentName,
  };
}

function commitText(sha: string | null, message: string | null): string | null {
  if (!sha) return null;
  return `${sha.slice(0, 7)}${message ? ` ${message.split('\n')[0]}` : ''}`;
}
