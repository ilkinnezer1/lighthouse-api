/**
 * Which GitHub credential authenticates work done ON BEHALF OF AN ORGANIZATION
 * — cloning, comparing commits, commenting on a PR.
 *
 * Pure, because this ordering IS the isolation guarantee the feature exists
 * for, and it should be readable without a database in the way.
 *
 * The rule that matters is the last one: a real (multi-member) organization
 * with no credential of its own resolves to NOTHING. It must never fall back to
 * a member's personal token — that is precisely the bug this replaces, where a
 * project created by a member silently made that member's personal credential
 * into company infrastructure.
 */

export type GitAuthSource =
  /** The organization's own credential — the normal answer for a company. */
  | 'organization'
  /**
   * A personal org's owner falling back to their own credential. Every user
   * gets a personal org at signup, and solo use has to stay frictionless —
   * there is no one else to isolate them from.
   */
  | 'personal-org-owner'
  /** Nothing available. For a shared org this is a refusal, not an accident. */
  | 'none';

export interface CredentialRef {
  id: string;
  secretEnc: string;
}

export interface OrgCredentialInput {
  /** The credential owned by this organization, if it has one. */
  orgCredential: CredentialRef | null;
  isPersonalOrg: boolean;
  /** The personal credential of the personal org's owner. */
  ownerPersonalCredential: CredentialRef | null;
}

export interface OrgCredentialChoice {
  credential: CredentialRef | null;
  source: GitAuthSource;
}

export function chooseOrgCredential(
  input: OrgCredentialInput,
): OrgCredentialChoice {
  if (input.orgCredential) {
    return { credential: input.orgCredential, source: 'organization' };
  }

  // Only a personal org may reach for a person's own credential, and only its
  // own owner's. In a shared org this branch is not taken even when a member
  // has a perfectly good token sitting there — borrowing it is the failure.
  if (input.isPersonalOrg && input.ownerPersonalCredential) {
    return {
      credential: input.ownerPersonalCredential,
      source: 'personal-org-owner',
    };
  }

  return { credential: null, source: 'none' };
}

/**
 * Whether a member may add a personal credential of their own.
 *
 * Blocked when they are a MEMBER or VIEWER of ANY organization that has turned
 * personal credentials off. Multi-org users get the strictest rule that applies
 * to them: a company that disables personal tokens is making a statement about
 * what may touch its code, and "but I am also in a laxer org" should not defeat
 * it. Admins and owners are never blocked — they are who sets the policy.
 */
export interface MembershipPolicy {
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  allowMemberGitCredentials: boolean;
}

export function mayAddPersonalCredential(
  memberships: MembershipPolicy[],
): boolean {
  return !memberships.some(
    (m) =>
      !m.allowMemberGitCredentials &&
      (m.role === 'MEMBER' || m.role === 'VIEWER'),
  );
}
