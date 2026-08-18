// Pulls a Jira issue key out of a git branch name. Pure + dependency-free so it
// is unit-testable without Nest, and so the same rules can be reasoned about in
// one place — every caller that labels a branch goes through here.

// A Jira project key is 2-10 chars, starting with a letter, then the issue
// number after a hyphen. It has to sit on a non-alphanumeric boundary at both
// ends, which covers a branch (`feature/PROJ-12-add-login`) and a commit subject
// (`fix(auth): PROJ-12 add login`) alike, while keeping `release/v1.2-3` and
// bare dates out — those fail the "starts with a letter, 2 chars minimum" rule.
//
// The pattern cannot avoid also matching things like `utf-8`. That is fine and
// deliberate: nothing is labelled until Jira confirms the key exists, so a false
// positive costs one unmatched key in a batch lookup and nothing else.
const ISSUE_KEY =
  /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?=$|[^A-Za-z0-9])/;

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

/**
 * Every distinct key across a set of strings, in first-seen order. Works for
 * branch names and commit subjects — the pattern accepts both.
 */
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
