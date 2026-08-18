// Pulls a Jira issue key out of a git branch name. Pure + dependency-free so it
// is unit-testable without Nest, and so the same rules can be reasoned about in
// one place — every caller that labels a branch goes through here.

// A Jira project key is 2-10 chars, starts with a letter, then letters/digits;
// the issue number follows a hyphen. The key must sit on a `/`, `-` or `_`
// boundary so `release/v1.2-3` and a bare SHA never look like tickets.
const ISSUE_KEY = /(?:^|[/_-])([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?=$|[/_-])/;

/**
 * Extract the issue key from a branch name, uppercased as Jira stores it.
 * Returns null when the branch carries no key. A false positive (`feat/v2-2024`)
 * costs one unmatched key in a batch lookup, which resolves to no title — the
 * branch still renders, so loose matching is the safer direction to err in.
 */
export function issueKeyFromBranch(branch: string): string | null {
  const match = ISSUE_KEY.exec(branch.trim());
  return match ? match[1].toUpperCase() : null;
}

/** Every distinct key across a set of branch names, in first-seen order. */
export function issueKeysFromBranches(branches: string[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const branch of branches) {
    const key = issueKeyFromBranch(branch);
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** Deep link to the ticket on its Jira site. `siteUrl` has no trailing slash. */
export function issueUrl(siteUrl: string, key: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`;
}
