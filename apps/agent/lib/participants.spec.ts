import { describe, expect, it } from 'vitest';
import { CallRole, LOCAL_ROLE, REMOTE_ROLE, isRemoteRole, labelFor, roleOf } from './participants';

describe('roleOf', () => {
  it('reads the two identities T24 mints', () => {
    expect(roleOf('customer')).toBe(CallRole.CUSTOMER);
    expect(roleOf('agent')).toBe(CallRole.AGENT);
  });

  /**
   * Null rather than a default. An unrecognised identity is something to
   * render neutrally, not to guess about — T30's analyzer will be exactly
   * that, and it publishes nothing to show.
   */
  it('returns null for anything else', () => {
    for (const identity of ['analyzer', 'Agent', 'CUSTOMER', '', 'agent ', 'egress']) {
      expect(roleOf(identity)).toBeNull();
    }
  });

  it('does not treat a prefix or a substring as a match', () => {
    expect(roleOf('agent-1')).toBeNull();
    expect(roleOf('the-customer')).toBeNull();
  });
});

describe('which tile is large', () => {
  /**
   * The mirror image of the customer app, and the only difference between the
   * two modules. The agent needs to see the person being verified, not
   * themselves.
   */
  it('puts the customer in the remote tile of the agent portal', () => {
    expect(LOCAL_ROLE).toBe(CallRole.AGENT);
    expect(REMOTE_ROLE).toBe(CallRole.CUSTOMER);
  });

  it('never makes the local role the remote one', () => {
    expect(LOCAL_ROLE).not.toBe(REMOTE_ROLE);
  });

  it('recognises only the other party as remote', () => {
    expect(isRemoteRole('customer')).toBe(true);
    expect(isRemoteRole('agent')).toBe(false);
    expect(isRemoteRole('analyzer')).toBe(false);
  });
});

describe('labels', () => {
  it('names the two parties as an agent would read them', () => {
    expect(labelFor(CallRole.CUSTOMER)).toBe('Customer');
    expect(labelFor(CallRole.AGENT)).toBe('You');
  });

  it('has a neutral label for an unknown participant', () => {
    expect(labelFor(null)).toBe('Participant');
  });

  it('never renders a raw identity string', () => {
    for (const role of [CallRole.AGENT, CallRole.CUSTOMER, null]) {
      expect(labelFor(role)).not.toMatch(/^(customer|agent)$/);
    }
  });
});
