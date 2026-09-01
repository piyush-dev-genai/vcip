/**
 * Who the other person in the room is (T25).
 *
 * T24 mints the participant identity from the role, per design §11.2: one
 * session is one room, so `customer` and `agent` are unique within it. That
 * makes the identity a reliable label — but only because the *server* wrote it
 * into a signed token. It is read here, never constructed, and never trusted
 * for anything but choosing which tile to make large.
 *
 * Nothing in this file grants or withholds anything. Publish and subscribe
 * permissions are in the token's grants and are enforced by the SFU; a browser
 * that decided to ignore this file could still only do what its grant allows.
 */

export const CallRole = {
  CUSTOMER: 'customer',
  AGENT: 'agent',
} as const;

export type CallRole = (typeof CallRole)[keyof typeof CallRole];

/**
 * The role behind a participant identity, or null if it is not one we know.
 *
 * Null rather than a default: an unrecognised identity in the room is
 * something to render neutrally, not something to guess about. T30's analyzer
 * will be exactly that — a third identity this app has no tile for, and which
 * publishes nothing to show.
 */
export function roleOf(identity: string): CallRole | null {
  if (identity === CallRole.CUSTOMER) return CallRole.CUSTOMER;
  if (identity === CallRole.AGENT) return CallRole.AGENT;
  return null;
}

/** The role this app's own participant holds. */
export const LOCAL_ROLE: CallRole = CallRole.CUSTOMER;

/** The role whose video belongs in the large tile. */
export const REMOTE_ROLE: CallRole = CallRole.AGENT;

/** Is this the participant this screen is built around? */
export function isRemoteRole(identity: string): boolean {
  return roleOf(identity) === REMOTE_ROLE;
}

/** A label for a participant, for the tile caption and for assistive text. */
export function labelFor(role: CallRole | null): string {
  switch (role) {
    case CallRole.AGENT:
      return 'Verification agent';
    case CallRole.CUSTOMER:
      return 'You';
    default:
      return 'Participant';
  }
}
