import { signState, verifyState } from './oauth-state';

describe('oauth-state', () => {
  it('round-trips for the same user', () => {
    const s = signState('user-1');
    expect(verifyState(s, 'user-1')).toBe(true);
  });

  it('rejects a different user (CSRF)', () => {
    expect(verifyState(signState('user-1'), 'user-2')).toBe(false);
  });

  it('rejects a tampered token', () => {
    expect(verifyState(signState('user-1') + 'x', 'user-1')).toBe(false);
  });

  it('rejects a malformed token', () => {
    expect(verifyState('not-a-real-token', 'user-1')).toBe(false);
    expect(verifyState('', 'user-1')).toBe(false);
  });

  it('rejects an expired token', () => {
    const realNow = Date.now;
    const issuedAt = realNow();
    Date.now = () => issuedAt;
    const token = signState('user-1');
    Date.now = () => issuedAt + 11 * 60 * 1000;
    try {
      expect(verifyState(token, 'user-1')).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});
