import {
  issueKeyFromBranch,
  issueKeysFromBranches,
  issueUrl,
} from './issue-key';

describe('issueKeyFromBranch', () => {
  it('reads the key out of the usual prefixed branch shapes', () => {
    expect(issueKeyFromBranch('feature/PROJ-123-add-login')).toBe('PROJ-123');
    expect(issueKeyFromBranch('bugfix/PROJ-7')).toBe('PROJ-7');
    expect(issueKeyFromBranch('feature/PROJ-123_add_login')).toBe('PROJ-123');
    expect(issueKeyFromBranch('hotfix/AB-1-urgent')).toBe('AB-1');
  });

  it('reads a bare key with no prefix', () => {
    expect(issueKeyFromBranch('PROJ-123')).toBe('PROJ-123');
    expect(issueKeyFromBranch('PROJ-123-add-login')).toBe('PROJ-123');
  });

  it('uppercases what it finds, since Jira keys are uppercase', () => {
    expect(issueKeyFromBranch('feature/proj-45-thing')).toBe('PROJ-45');
  });

  // Pieman required two or more digits, which silently dropped every ticket
  // numbered under ten.
  it('matches single-digit issue numbers', () => {
    expect(issueKeyFromBranch('feature/PROJ-5')).toBe('PROJ-5');
  });

  it('takes the first key when a branch name carries several', () => {
    expect(issueKeyFromBranch('feature/PROJ-12-blocks-OTHER-34')).toBe(
      'PROJ-12',
    );
  });

  // The same pattern reads commit subjects, where the key is followed by
  // punctuation rather than a path separator.
  it('reads a key out of a commit subject', () => {
    expect(issueKeyFromBranch('PROJ-12: add login')).toBe('PROJ-12');
    expect(issueKeyFromBranch('PROJ-12 add login')).toBe('PROJ-12');
    expect(issueKeyFromBranch('fix(auth): PROJ-12 add login')).toBe('PROJ-12');
    expect(
      issueKeyFromBranch('Merge pull request #4 from acme/PROJ-12-login'),
    ).toBe('PROJ-12');
  });

  it('returns null for branches that carry no ticket', () => {
    expect(issueKeyFromBranch('main')).toBeNull();
    expect(issueKeyFromBranch('develop')).toBeNull();
    expect(issueKeyFromBranch('feature/add-login')).toBeNull();
    expect(issueKeyFromBranch('release/1.2.3')).toBeNull();
    expect(issueKeyFromBranch('')).toBeNull();
  });

  it('does not treat a version or date fragment as a key', () => {
    expect(issueKeyFromBranch('release/v1.2-3')).toBeNull();
    expect(issueKeyFromBranch('archive/2024-01')).toBeNull();
  });

  it('rejects a one-character project key', () => {
    expect(issueKeyFromBranch('feature/A-12')).toBeNull();
  });
});

describe('issueKeysFromBranches', () => {
  it('dedupes and keeps first-seen order', () => {
    expect(
      issueKeysFromBranches([
        'feature/PROJ-2-a',
        'main',
        'feature/PROJ-1-b',
        'hotfix/proj-2-c',
      ]),
    ).toEqual(['PROJ-2', 'PROJ-1']);
  });

  it('is empty when nothing matches', () => {
    expect(issueKeysFromBranches(['main', 'develop'])).toEqual([]);
  });
});

describe('issueUrl', () => {
  it('builds a browse link and tolerates a trailing slash', () => {
    expect(issueUrl('https://acme.atlassian.net', 'PROJ-1')).toBe(
      'https://acme.atlassian.net/browse/PROJ-1',
    );
    expect(issueUrl('https://acme.atlassian.net/', 'PROJ-1')).toBe(
      'https://acme.atlassian.net/browse/PROJ-1',
    );
  });
});
