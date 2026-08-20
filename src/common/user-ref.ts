import type { Prisma } from '@prisma/client';

/**
 * The one shape a person is rendered as anywhere in the API — a lock holder, a
 * finding's reporter, whoever resolved it. Neutral on purpose: the moment each
 * feature picks its own subset, the client ends up with four near-identical
 * user types that drift.
 */
export interface UserRef {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
}

export const USER_REF_SELECT = {
  id: true,
  username: true,
  displayName: true,
  email: true,
} satisfies Prisma.UserSelect;

/** What to call someone in prose. Never an id, never an empty string. */
export function displayNameOf(user: UserRef | null | undefined): string | null {
  return user ? (user.displayName ?? user.username) : null;
}
