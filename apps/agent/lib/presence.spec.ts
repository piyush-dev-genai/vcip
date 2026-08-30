import { AGENT_PRESENCES, AGENT_SETTABLE_PRESENCES } from '@vcip/shared';
import { describe, expect, it } from 'vitest';
import { describe as describeStatus, isSelectable, LABELS, SELECTABLE } from './presence';
import type { PresenceStatus } from './presence';

describe('what the portal offers', () => {
  it('offers exactly the presences the domain says are settable', () => {
    expect([...SELECTABLE].sort()).toEqual([...AGENT_SETTABLE_PRESENCES].sort());
  });

  it('never offers BUSY', () => {
    // The client half of R5. The buttons are generated from this list, so
    // there is no hand-written BUSY control to forget to remove.
    expect(SELECTABLE).not.toContain('BUSY');
    expect(isSelectable('BUSY')).toBe(false);
    expect(isSelectable('AVAILABLE')).toBe(true);
    expect(isSelectable('UNAVAILABLE')).toBe(true);
  });

  it('can still display every presence the server may report', () => {
    // Displaying BUSY and setting it are different capabilities: an agent in a
    // verification must be able to see that they are.
    for (const status of AGENT_PRESENCES) {
      const label = describeStatus(status as PresenceStatus);
      expect(label.label.length).toBeGreaterThan(0);
      expect(label.detail.length).toBeGreaterThan(0);
    }
    expect(Object.keys(LABELS).sort()).toEqual([...AGENT_PRESENCES].sort());
  });

  it('describes BUSY as something the system sets', () => {
    expect(LABELS.BUSY.detail).toMatch(/system/i);
  });
});
