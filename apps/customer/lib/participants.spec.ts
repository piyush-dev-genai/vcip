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
  it('puts the agent in the remote tile of the customer app', () => {
    expect(LOCAL_ROLE).toBe(CallRole.CUSTOMER);
    expect(REMOTE_ROLE).toBe(CallRole.AGENT);
  });

  it('never makes the local role the remote one', () => {
    expect(LOCAL_ROLE).not.toBe(REMOTE_ROLE);
  });

  it('recognises only the other party as remote', () => {
    expect(isRemoteRole('agent')).toBe(true);
    expect(isRemoteRole('customer')).toBe(false);
    expect(isRemoteRole('analyzer')).toBe(false);
  });
});

describe('labels', () => {
  it('names the agent and the customer as a customer would read them', () => {
    expect(labelFor(CallRole.AGENT)).toBe('Verification agent');
    expect(labelFor(CallRole.CUSTOMER)).toBe('You');
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
