/**
 * Pure helpers for a pasted GitHub Personal Access Token.
 *
 * Kept free of Nest and Prisma so the two things most likely to be wrong —
 * what GitHub's scope header actually means, and whether a token can read
 * private repos — can be read and tested on their own.
 */

/** Display-only prefix length of the peppered digest stored as `fingerprint`. */
export const FINGERPRINT_CHARS = 12;

/** The scope a classic token needs to read private repositories. */
export const PRIVATE_REPO_SCOPE = 'repo';

/**
 * Tokens are pasted, so they arrive with whatever the clipboard carried —
 * a trailing newline from a terminal, or spaces from a wrapped line.
 */
export function normalizeToken(raw: string): string {
  return raw.trim();
}

/**
 * A cheap shape check, deliberately NOT a format check: GitHub has shipped
 * `ghp_`, `github_pat_`, `gho_` and bare 40-hex tokens, and pinning a prefix
 * here would reject the next format it invents. The real check is asking
 * GitHub, so this only rules out input that cannot be a credential at all.
 */
export function isPlausibleToken(token: string): boolean {
  return token.length >= 8 && token.length <= 512 && !/\s/.test(token);
}

/**
 * GitHub reports a classic token's grants in the `x-oauth-scopes` response
 * header, as a comma-separated list.
 *
 * `null` means the header was absent, which is NOT the same as no scopes: a
 * fine-grained PAT never sends it, and its permissions live per-repository
 * where this API cannot see them. Callers must not read absence as "no access".
 */
export function parseOauthScopes(
  header: string | null | undefined,
): string[] | null {
  if (header === null || header === undefined) return null;
  return header
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/**
 * Whether the token can read private repositories.
 *
 * `null` is "cannot tell" — an empty scope list is what both a fine-grained PAT
 * and a scopeless classic token look like once stored, and warning that a
 * perfectly good fine-grained token "lacks the repo scope" would send people
 * chasing a problem they do not have. A missing `repo` on a token that DID
 * report its scopes is worth saying out loud: it is the difference between
 * working now and a confusing 404 at clone time.
 */
export function hasRepoScope(scopes: string[]): boolean | null {
  if (scopes.length === 0) return null;
  return scopes.includes(PRIVATE_REPO_SCOPE);
}
