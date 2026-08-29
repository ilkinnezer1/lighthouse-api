import { CheckResult } from '@prisma/client';
import { nextFindingId, summarize, type Checkable } from './checklist-summary';

const pass = (): Checkable => ({ check: { result: CheckResult.PASS } });
const fail = (): Checkable => ({ check: { result: CheckResult.FAIL } });
const untouched = (): Checkable => ({ check: null });

describe('summarize', () => {
  it('is all zeroes for an empty list', () => {
    expect(summarize([])).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      remaining: 0,
    });
  });

  it('splits the three states of a build', () => {
    expect(summarize([pass(), pass(), fail(), untouched()])).toEqual({
      total: 4,
      passed: 2,
      failed: 1,
      remaining: 1,
    });
  });

  // The rule the whole feature rests on: a FAIL is tested and broken, which is
  // work for a developer. Counting it as outstanding would send QA back to
  // retest something already known not to work.
  it('never counts a failure as remaining', () => {
    expect(summarize([fail(), fail()])).toMatchObject({
      failed: 2,
      remaining: 0,
    });
  });

  // `check` is the tick on THIS build only; a tick made two deploys ago arrives
  // as `lastCheck` and leaves `check` null, so it is outstanding again.
  it('counts an item checked on an earlier build as remaining', () => {
    expect(summarize([untouched(), untouched()])).toEqual({
      total: 2,
      passed: 0,
      failed: 0,
      remaining: 2,
    });
  });

  it('always accounts for every item exactly once', () => {
    const items = [pass(), fail(), untouched(), pass(), untouched()];
    const { total, passed, failed, remaining } = summarize(items);
    expect(passed + failed + remaining).toBe(total);
  });
});

describe('nextFindingId', () => {
  it('records the bug a failure just filed', () => {
    expect(
      nextFindingId({
        previous: null,
        result: CheckResult.FAIL,
        filedFindingId: 'finding-1',
      }),
    ).toBe('finding-1');
  });

  it('carries the earlier bug when a failure is re-stated without filing', () => {
    expect(
      nextFindingId({
        previous: { result: CheckResult.FAIL, findingId: 'finding-1' },
        result: CheckResult.FAIL,
        filedFindingId: null,
      }),
    ).toBe('finding-1');
  });

  it('replaces the earlier bug when the new failure files its own', () => {
    expect(
      nextFindingId({
        previous: { result: CheckResult.FAIL, findingId: 'finding-1' },
        result: CheckResult.FAIL,
        filedFindingId: 'finding-2',
      }),
    ).toBe('finding-2');
  });

  // "Passes, see the bug report" is nonsense. The finding still exists and is
  // still tracked as a finding; the tick simply stops claiming it.
  it('drops the bug when the item is passed on re-check', () => {
    expect(
      nextFindingId({
        previous: { result: CheckResult.FAIL, findingId: 'finding-1' },
        result: CheckResult.PASS,
        filedFindingId: null,
      }),
    ).toBeNull();
  });

  it('leaves a plain pass with no bug at all', () => {
    expect(
      nextFindingId({
        previous: null,
        result: CheckResult.PASS,
        filedFindingId: null,
      }),
    ).toBeNull();
  });

  it('does not resurrect a bug from a check that had passed', () => {
    expect(
      nextFindingId({
        previous: { result: CheckResult.PASS, findingId: null },
        result: CheckResult.FAIL,
        filedFindingId: null,
      }),
    ).toBeNull();
  });
});
