import {
  hasRepoScope,
  isPlausibleToken,
  normalizeToken,
  parseOauthScopes,
} from './github-token';

describe('normalizeToken', () => {
  it.each([
    ['ghp_abc123def456', 'ghp_abc123def456'],
    ['  ghp_abc123def456  ', 'ghp_abc123def456'],
    ['ghp_abc123def456\n', 'ghp_abc123def456'],
    ['\tghp_abc123def456\r\n', 'ghp_abc123def456'],
  ])('trims what the clipboard carried: %j', (raw, expected) => {
    expect(normalizeToken(raw)).toBe(expected);
  });
});

describe('isPlausibleToken', () => {
  // Deliberately format-agnostic: GitHub has shipped several token shapes and
  // the authoritative check is asking GitHub, not a regex here.
  it.each([
    'ghp_16CharactersLong',
    'github_pat_11ABCDEFG0abcdefghijklmn',
    'gho_16CharactersLong',
    '0123456789abcdef0123456789abcdef01234567',
  ])('accepts %s', (token) => {
    expect(isPlausibleToken(token)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['too short', 'ghp_1'],
    ['containing a space', 'ghp_abc def'],
    ['containing a newline', 'ghp_abc\ndef'],
    ['absurdly long', 'g'.repeat(513)],
  ])('rejects one %s', (_label, token) => {
    expect(isPlausibleToken(token)).toBe(false);
  });
});

describe('parseOauthScopes', () => {
  it('splits the comma-separated header', () => {
    expect(parseOauthScopes('repo, read:org, gist')).toEqual([
      'repo',
      'read:org',
      'gist',
    ]);
  });

  it('handles a single scope and stray whitespace', () => {
    expect(parseOauthScopes('  repo  ')).toEqual(['repo']);
    expect(parseOauthScopes('repo,,read:org')).toEqual(['repo', 'read:org']);
  });

  // A classic token with every scope removed genuinely reports an empty string.
  it('reads an empty header as an empty scope list', () => {
    expect(parseOauthScopes('')).toEqual([]);
  });

  // The distinction that matters: a fine-grained PAT sends no header at all,
  // and its per-repository permissions are invisible to this API.
  it.each([null, undefined])('reads an absent header (%p) as unknown', (h) => {
    expect(parseOauthScopes(h)).toBeNull();
  });
});

describe('hasRepoScope', () => {
  it('is true when the token may read private repos', () => {
    expect(hasRepoScope(['repo', 'read:org'])).toBe(true);
  });

  it('is false for a token that reported scopes without repo', () => {
    expect(hasRepoScope(['public_repo', 'gist'])).toBe(false);
  });

  // `public_repo` is not `repo` — it is exactly the token that clones public
  // repos happily and 404s on the private one someone actually wanted.
  it('does not accept public_repo as private access', () => {
    expect(hasRepoScope(['public_repo'])).toBe(false);
  });

  // Warning that a working fine-grained token "lacks the repo scope" would
  // send people chasing a problem they do not have.
  it('is unknown, not false, when no scopes were reported', () => {
    expect(hasRepoScope([])).toBeNull();
  });
});
