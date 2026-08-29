import type { ChangedCommit } from '../deployments/deployment-changes.service';
import { MAX_FALLBACK_ITEMS, seedRows } from './seed-items';

const commit = (
  sha: string,
  message: string,
  jira: Partial<
    Pick<ChangedCommit, 'issueTitle' | 'issueUrl' | 'issueKey'>
  > = {},
): ChangedCommit => ({
  sha,
  message,
  author: 'ruslan',
  date: '2026-08-29T10:00:00Z',
  url: `https://github.com/acme/app/commit/${sha}`,
  issueKey: jira.issueKey ?? null,
  issueTitle: jira.issueTitle ?? null,
  issueUrl: jira.issueUrl ?? null,
});

describe('seedRows', () => {
  describe('grouping by ticket', () => {
    it('makes one item per distinct key, in first-seen order', () => {
      const rows = seedRows(
        [
          commit('a1', 'PROJ-12 add login'),
          commit('a2', 'PROJ-9 fix header'),
          commit('a3', 'PROJ-12 add logout too'),
        ],
        [],
      );
      expect(rows.map((r) => r.seedKey)).toEqual(['PROJ-12', 'PROJ-9']);
    });

    it('reads a key out of a conventional-commit subject', () => {
      const rows = seedRows([commit('a1', 'fix(auth): PROJ-12 add login')], []);
      expect(rows[0]).toMatchObject({
        seedKey: 'PROJ-12',
        issueKey: 'PROJ-12',
      });
    });

    it('uppercases the key the way Jira stores it', () => {
      expect(
        seedRows([commit('a1', 'proj-12 add login')], [])[0],
      ).toMatchObject({ seedKey: 'PROJ-12', issueKey: 'PROJ-12' });
    });
  });

  describe('titles', () => {
    // The whole point of the corrected rule: Jira confirmation is enrichment,
    // never the gate. Without a connection the commit subject still names the
    // work, and the list is populated either way.
    it('falls back to the commit subject when Jira confirmed nothing', () => {
      expect(
        seedRows([commit('a1', 'PROJ-12 add login')], [])[0],
      ).toMatchObject({ title: 'PROJ-12 add login', issueUrl: null });
    });

    it('prefers the confirmed Jira summary and its link', () => {
      const rows = seedRows(
        [
          commit('a1', 'PROJ-12 wip', {
            issueTitle: 'Add a login screen',
            issueUrl: 'https://acme.atlassian.net/browse/PROJ-12',
          }),
        ],
        [],
      );
      expect(rows[0]).toMatchObject({
        title: 'Add a login screen',
        issueUrl: 'https://acme.atlassian.net/browse/PROJ-12',
      });
    });

    // The commit Jira resolved is not always the first one mentioning the key.
    it('takes the summary from whichever commit in the group carries it', () => {
      const rows = seedRows(
        [
          commit('a1', 'PROJ-12 wip'),
          commit('a2', 'PROJ-12 done', {
            issueTitle: 'Add a login screen',
            issueUrl: 'https://acme.atlassian.net/browse/PROJ-12',
          }),
        ],
        [],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        title: 'Add a login screen',
        issueUrl: 'https://acme.atlassian.net/browse/PROJ-12',
      });
    });

    it('uses only the subject line of a multi-line message', () => {
      const rows = seedRows(
        [commit('a1', 'PROJ-12 add login\n\nLong body explaining things.')],
        [],
      );
      expect(rows[0].title).toBe('PROJ-12 add login');
    });

    it('truncates a runaway subject rather than storing it whole', () => {
      const rows = seedRows([commit('a1', 'x'.repeat(500))], []);
      expect(rows[0].title).toHaveLength(200);
      expect(rows[0].title.endsWith('…')).toBe(true);
    });
  });

  describe('the no-keys fallback', () => {
    it('seeds one item per commit when the range has no ticket keys', () => {
      const rows = seedRows(
        [commit('a1', 'fix typo'), commit('a2', 'bump deps')],
        [],
      );
      expect(rows).toEqual([
        { seedKey: 'a1', title: 'fix typo', issueKey: null, issueUrl: null },
        { seedKey: 'a2', title: 'bump deps', issueKey: null, issueUrl: null },
      ]);
    });

    // A merge is bookkeeping about how the changes arrived, not a change.
    it('skips merge commits', () => {
      const rows = seedRows(
        [
          commit('a1', "Merge branch 'main' into feature"),
          commit('a2', 'Merge pull request #12 from acme/feature'),
          commit('a3', 'fix typo'),
        ],
        [],
      );
      expect(rows.map((r) => r.seedKey)).toEqual(['a3']);
    });

    it('does not mistake a real subject for a merge', () => {
      const rows = seedRows([commit('a1', 'merged-cells rendering fix')], []);
      expect(rows.map((r) => r.seedKey)).toEqual(['a1']);
    });

    it('caps the fallback so a big range stays a checklist', () => {
      const commits = Array.from({ length: 40 }, (_, i) =>
        commit(`sha${i}`, `change ${i}`),
      );
      expect(seedRows(commits, [])).toHaveLength(MAX_FALLBACK_ITEMS);
    });

    // One commit shown twice — once as its ticket, once as itself — is worse
    // than either mode alone.
    it('never mixes the two modes: one key anywhere wins', () => {
      const rows = seedRows(
        [
          commit('a1', 'fix typo'),
          commit('a2', 'PROJ-12 add login'),
          commit('a3', 'bump deps'),
        ],
        [],
      );
      expect(rows.map((r) => r.seedKey)).toEqual(['PROJ-12']);
    });

    it('seeds nothing from an empty range', () => {
      expect(seedRows([], [])).toEqual([]);
    });
  });

  describe('idempotence', () => {
    it('adds nothing on a second seed of the same range', () => {
      const commits = [
        commit('a1', 'PROJ-12 add login'),
        commit('a2', 'PROJ-9 fix header'),
      ];
      const first = seedRows(commits, []);
      const second = seedRows(
        commits,
        first.map((r) => r.seedKey),
      );
      expect(second).toEqual([]);
    });

    it('adds only what a later deploy brought', () => {
      const rows = seedRows(
        [commit('a1', 'PROJ-12 add login'), commit('a2', 'PROJ-9 fix header')],
        ['PROJ-12'],
      );
      expect(rows.map((r) => r.seedKey)).toEqual(['PROJ-9']);
    });

    it('dedupes the commit fallback on the sha', () => {
      const rows = seedRows(
        [commit('a1', 'fix typo'), commit('a2', 'bump deps')],
        ['a1'],
      );
      expect(rows.map((r) => r.seedKey)).toEqual(['a2']);
    });

    // Already-seeded keys must not push a fallback into keyed mode or back:
    // the mode is decided by the range, then filtered.
    it('decides the mode from the range, not from what survives the filter', () => {
      const rows = seedRows(
        [commit('a1', 'PROJ-12 add login'), commit('a2', 'fix typo')],
        ['PROJ-12'],
      );
      expect(rows).toEqual([]);
    });
  });
});
