import { CheckResult } from '@prisma/client';

/**
 * What the progress numbers mean. Pure, because the subtle rule the whole
 * feature rests on lives here: **remaining is "no check on THIS build"**, not
 * "not passed".
 *
 * A FAIL is tested and broken — work for a developer, not work for a tester —
 * so counting it as outstanding would tell QA to go and retest a thing that is
 * known to be broken. And an item checked two builds ago is remaining again the
 * moment the code moves, which is the entire point of binding the tick to a
 * deployment.
 */
export interface ChecklistSummary {
  total: number;
  passed: number;
  failed: number;
  remaining: number;
}

/** Only the check made against the build being viewed counts. */
export interface Checkable {
  check: { result: CheckResult } | null;
}

export function summarize(items: readonly Checkable[]): ChecklistSummary {
  let passed = 0;
  let failed = 0;
  for (const item of items) {
    if (!item.check) continue;
    if (item.check.result === CheckResult.PASS) passed++;
    else failed++;
  }
  return {
    total: items.length,
    passed,
    failed,
    remaining: items.length - passed - failed,
  };
}

/**
 * Which finding a check should point at after it is written.
 *
 * A PASS never carries one: a green row linking to a bug report reads as "works,
 * see the bug", which is nonsense. A FAIL that files nothing new keeps the
 * report the previous fail already produced, so re-wording a note does not
 * orphan it.
 */
export function nextFindingId(input: {
  previous: { result: CheckResult; findingId: string | null } | null;
  result: CheckResult;
  filedFindingId: string | null;
}): string | null {
  if (input.filedFindingId) return input.filedFindingId;
  if (input.result !== CheckResult.FAIL) return null;
  if (input.previous?.result !== CheckResult.FAIL) return null;
  return input.previous.findingId;
}
