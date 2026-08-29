import {
  chooseOrgCredential,
  mayAddPersonalCredential,
  type MembershipPolicy,
} from './git-auth';

const ORG_CRED = { id: 'cred-org', secretEnc: 'enc(org)' };
const PERSONAL_CRED = { id: 'cred-personal', secretEnc: 'enc(personal)' };

describe('chooseOrgCredential', () => {
  it('uses the organization’s own credential first', () => {
    expect(
      chooseOrgCredential({
        orgCredential: ORG_CRED,
        isPersonalOrg: false,
        ownerPersonalCredential: PERSONAL_CRED,
      }),
    ).toEqual({ credential: ORG_CRED, source: 'organization' });
  });

  it('prefers the org credential even in a personal org', () => {
    expect(
      chooseOrgCredential({
        orgCredential: ORG_CRED,
        isPersonalOrg: true,
        ownerPersonalCredential: PERSONAL_CRED,
      }),
    ).toMatchObject({ credential: ORG_CRED, source: 'organization' });
  });

  // Every user gets a personal org at signup; solo use has to stay
  // frictionless, and there is nobody to be isolated from.
  it('falls back to the owner’s own credential in a personal org', () => {
    expect(
      chooseOrgCredential({
        orgCredential: null,
        isPersonalOrg: true,
        ownerPersonalCredential: PERSONAL_CRED,
      }),
    ).toEqual({ credential: PERSONAL_CRED, source: 'personal-org-owner' });
  });

  // THE point of the feature. A member's personal token must never quietly
  // become the company's deploy credential just because they created a project.
  it('refuses to borrow a personal credential in a shared org', () => {
    expect(
      chooseOrgCredential({
        orgCredential: null,
        isPersonalOrg: false,
        ownerPersonalCredential: PERSONAL_CRED,
      }),
    ).toEqual({ credential: null, source: 'none' });
  });

  it('is none for a shared org with nothing configured anywhere', () => {
    expect(
      chooseOrgCredential({
        orgCredential: null,
        isPersonalOrg: false,
        ownerPersonalCredential: null,
      }),
    ).toEqual({ credential: null, source: 'none' });
  });

  it('is none for a personal org whose owner has no credential', () => {
    expect(
      chooseOrgCredential({
        orgCredential: null,
        isPersonalOrg: true,
        ownerPersonalCredential: null,
      }),
    ).toEqual({ credential: null, source: 'none' });
  });
});

describe('mayAddPersonalCredential', () => {
  const member = (
    role: MembershipPolicy['role'],
    allow: boolean,
  ): MembershipPolicy => ({ role, allowMemberGitCredentials: allow });

  it('allows it when every org permits it', () => {
    expect(
      mayAddPersonalCredential([
        member('MEMBER', true),
        member('VIEWER', true),
      ]),
    ).toBe(true);
  });

  it('allows it for a user in no org at all', () => {
    expect(mayAddPersonalCredential([])).toBe(true);
  });

  it.each(['MEMBER', 'VIEWER'] as const)(
    'blocks a %s of an org that disabled it',
    (role) => {
      expect(mayAddPersonalCredential([member(role, false)])).toBe(false);
    },
  );

  // They are who sets the policy; locking them out of their own setting would
  // make it unrecoverable.
  it.each(['OWNER', 'ADMIN'] as const)('never blocks an %s', (role) => {
    expect(mayAddPersonalCredential([member(role, false)])).toBe(true);
  });

  // A company that disables personal tokens means it — "but I am also in a
  // laxer org" must not defeat the stricter policy.
  it('takes the strictest policy for a multi-org user', () => {
    expect(
      mayAddPersonalCredential([
        member('MEMBER', true),
        member('MEMBER', false),
      ]),
    ).toBe(false);
  });

  // ...but being an admin somewhere else does not exempt them where they are
  // only a member.
  it('still blocks a member who is an admin of a different org', () => {
    expect(
      mayAddPersonalCredential([
        member('ADMIN', true),
        member('MEMBER', false),
      ]),
    ).toBe(false);
  });
});
