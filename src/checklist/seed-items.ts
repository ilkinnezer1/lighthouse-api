import type { ChangedCommit } from '../deployments/deployment-changes.service';
import { issueKeyFromBranch } from '../jira/issue-key';

/**
 * Turning a build's change range into checklist items. Pure, so the one
 * decision the feature actually rests on — *what is there to test* — can be
 * read and tested without a database, a GitHub token or a Jira connection in
 * the way.
 *
 * The grouping key is parsed here rather than read off `ChangedCommit.issueKey`.
 * That field is only populated when Jira *confirms* the ticket exists, so an org
 * with no Atlassian connection — the common case — would seed nothing at all.
 * Confirmation is enrichment (a real title, a deep link); it is not the gate.
 */

/** One row to insert. `seedKey` is what re-seeding dedupes on. */
export interface SeedRow {
  seedKey: string;
  title: string;
  issueKey: string | null;
  issueUrl: string | null;
}

/**
 * The fallback is a courtesy, not a changelog: past a score of commits the list
 * stops being a checklist and becomes the compare view with tickboxes.
 */
export const MAX_FALLBACK_ITEMS = 20;

const MAX_TITLE = 200;

export function seedRows(
  commits: readonly ChangedCommit[],
  existingSeedKeys: Iterable<string>,
): SeedRow[] {
  const existing = new Set(existingSeedKeys);
  const keyed = byIssueKey(commits);
  const rows = keyed.length > 0 ? keyed : perCommit(commits);
  return rows.filter((row) => !existing.has(row.seedKey));
}

/**
 * One item per distinct ticket, in the order the range first mentions it. A
 * ticket touched by six commits is one thing to test, not six.
 */
function byIssueKey(commits: readonly ChangedCommit[]): SeedRow[] {
  const rows = new Map<string, SeedRow>();
  for (const commit of commits) {
    const key = issueKeyFromBranch(commit.message);
    if (!key) continue;

    const row = rows.get(key);
    if (!row) {
      rows.set(key, {
        seedKey: key,
        // The confirmed Jira summary when there is one; the commit subject is
        // the honest stand-in, and beats showing a bare key nobody can read.
        title: title(commit.issueTitle ?? subject(commit.message) ?? key),
        issueKey: key,
        issueUrl: commit.issueUrl,
      });
      continue;
    }
    // A later commit may be the one Jira resolved — take the better title and
    // the link whichever commit carries them.
    if (commit.issueTitle) row.title = title(commit.issueTitle);
    if (!row.issueUrl && commit.issueUrl) row.issueUrl = commit.issueUrl;
  }
  return [...rows.values()];
}

/**
 * No ticket keys anywhere in the range: seed the commits themselves rather than
 * leave a repo that does not use ticket numbers with an empty list. Never mixed
 * with the keyed mode — one commit shown twice, once as its ticket and once as
 * itself, is worse than either.
 */
function perCommit(commits: readonly ChangedCommit[]): SeedRow[] {
  const rows: SeedRow[] = [];
  for (const commit of commits) {
    // A merge commit is not a change to test; it is bookkeeping about how the
    // changes arrived.
    if (isMerge(commit.message)) continue;
    const line = subject(commit.message);
    if (!line) continue;
    rows.push({
      seedKey: commit.sha,
      title: title(line),
      issueKey: null,
      issueUrl: null,
    });
    if (rows.length === MAX_FALLBACK_ITEMS) break;
  }
  return rows;
}

function isMerge(message: string): boolean {
  return /^merge\b/i.test(message.trimStart());
}

function subject(message: string): string | null {
  return message.split('\n')[0].trim() || null;
}

function title(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TITLE) return trimmed;
  return `${trimmed.slice(0, MAX_TITLE - 1).trimEnd()}…`;
}
