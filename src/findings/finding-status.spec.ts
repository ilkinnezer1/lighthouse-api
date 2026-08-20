import { FindingStatus } from '@prisma/client';
import { isResolution, resolveTransition } from './finding-status';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const ACTOR = 'ruslan-id';
const FOUND_ON = 'deploy-found';
const LATEST_SUCCEEDED = 'deploy-latest';

const transition = (
  current: FindingStatus,
  next: FindingStatus,
  latestSucceededDeploymentId: string | null = LATEST_SUCCEEDED,
) =>
  resolveTransition({
    current,
    next,
    actorUserId: ACTOR,
    latestSucceededDeploymentId,
    now: NOW,
  });

describe('resolveTransition', () => {
  describe('recording which build fixed it', () => {
    it('pins the fix to the environment’s latest succeeded build', () => {
      expect(transition(FindingStatus.OPEN, FindingStatus.FIXED)).toEqual({
        status: FindingStatus.FIXED,
        fixedByDeploymentId: LATEST_SUCCEEDED,
        resolvedByUserId: ACTOR,
        resolvedAt: NOW,
      });
    });

    // A config or data fix genuinely is fixed on the build it was found on;
    // recording it is truthful, and an empty range is what would be wrong.
    it('records the found-on build when it is still the latest succeeded one', () => {
      expect(
        transition(FindingStatus.OPEN, FindingStatus.FIXED, FOUND_ON),
      ).toMatchObject({ fixedByDeploymentId: FOUND_ON });
    });

    it('leaves the fixing build empty when the environment has never succeeded', () => {
      expect(
        transition(FindingStatus.OPEN, FindingStatus.FIXED, null),
      ).toMatchObject({
        status: FindingStatus.FIXED,
        fixedByDeploymentId: null,
        resolvedByUserId: ACTOR,
      });
    });

    // "Can't reproduce" is a resolution, not a fix — pointing it at a build
    // would invent a commit range that fixed nothing.
    it('never pins a build for CANNOT_REPRODUCE', () => {
      expect(
        transition(FindingStatus.OPEN, FindingStatus.CANNOT_REPRODUCE),
      ).toEqual({
        status: FindingStatus.CANNOT_REPRODUCE,
        fixedByDeploymentId: null,
        resolvedByUserId: ACTOR,
        resolvedAt: NOW,
      });
    });

    it('drops the fixing build when a fixed finding turns out not to be fixed', () => {
      expect(
        transition(FindingStatus.FIXED, FindingStatus.CANNOT_REPRODUCE),
      ).toMatchObject({ fixedByDeploymentId: null });
    });
  });

  describe('reopening', () => {
    it('clears the whole resolution, fixing build included', () => {
      expect(transition(FindingStatus.FIXED, FindingStatus.OPEN)).toEqual({
        status: FindingStatus.OPEN,
        fixedByDeploymentId: null,
        resolvedByUserId: null,
        resolvedAt: null,
      });
    });

    it('clears the resolver of a cannot-reproduce too', () => {
      expect(
        transition(FindingStatus.CANNOT_REPRODUCE, FindingStatus.OPEN),
      ).toMatchObject({ resolvedByUserId: null, resolvedAt: null });
    });
  });

  describe('no-ops', () => {
    // A repeated click must not re-stamp the resolver or fire a second
    // notification at the person who filed it.
    it.each([
      FindingStatus.OPEN,
      FindingStatus.FIXED,
      FindingStatus.CANNOT_REPRODUCE,
    ])('writes nothing when the status is already %s', (status) => {
      expect(transition(status, status)).toBeNull();
    });
  });
});

describe('isResolution', () => {
  it('is true for both ways of closing a finding', () => {
    expect(
      isResolution(transition(FindingStatus.OPEN, FindingStatus.FIXED)!),
    ).toBe(true);
    expect(
      isResolution(
        transition(FindingStatus.OPEN, FindingStatus.CANNOT_REPRODUCE)!,
      ),
    ).toBe(true);
  });

  it('is false for reopening', () => {
    expect(
      isResolution(transition(FindingStatus.FIXED, FindingStatus.OPEN)!),
    ).toBe(false);
  });
});
