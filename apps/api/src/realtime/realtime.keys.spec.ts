import { describe, expect, it } from 'vitest';
import { queueKey } from '../queue/queue.keys.js';
import type { AgentScope, CustomerScope } from './realtime.keys.js';
import {
  agentChannel,
  channelsFor,
  normaliseLanguage,
  queueChannel,
  sessionChannel,
} from './realtime.keys.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const AGENT_A = '00000000-0000-4000-8000-0000000000a1';
const AGENT_B = '00000000-0000-4000-8000-0000000000a2';
const SESSION = '11111111-1111-4111-8111-111111111111';

const customer = (over: Partial<CustomerScope> = {}): CustomerScope => ({
  audience: 'customer',
  tenantId: TENANT_A,
  sessionId: SESSION,
  ...over,
});

const agent = (over: Partial<AgentScope> = {}): AgentScope => ({
  audience: 'agent',
  tenantId: TENANT_A,
  userId: AGENT_A,
  languages: ['en'],
  ...over,
});

describe('a customer connection', () => {
  it('holds exactly one channel: its own session', () => {
    expect(channelsFor(customer())).toEqual([sessionChannel(SESSION)]);
  });

  /**
   * R8 binds a customer token to one session, and the channel list is what
   * makes that a property of the transport rather than of a later filter.
   */
  it('holds no channel for any other session', () => {
    const channels = channelsFor(customer());
    expect(channels).not.toContain(sessionChannel('22222222-2222-4222-8222-222222222222'));
  });

  it('holds no agent or queue channel', () => {
    for (const channel of channelsFor(customer())) {
      expect(channel).not.toContain(':agent:');
      expect(channel).not.toContain(':queue:');
    }
  });
});

describe('an agent connection', () => {
  it('holds its own channel plus one per configured language', () => {
    expect(channelsFor(agent({ languages: ['en', 'hi'] }))).toEqual([
      agentChannel(TENANT_A, AGENT_A),
      queueChannel(TENANT_A, 'en'),
      queueChannel(TENANT_A, 'hi'),
    ]);
  });

  it('holds no other agent’s channel', () => {
    expect(channelsFor(agent())).not.toContain(agentChannel(TENANT_A, AGENT_B));
  });

  it('holds nothing for a language it cannot work', () => {
    expect(channelsFor(agent({ languages: ['ta'] }))).not.toContain(queueChannel(TENANT_A, 'en'));
  });

  it('holds only its own channel when the profile lists no language', () => {
    // A profile that could not be read connects the agent anyway; they simply
    // hear nothing from the queue.
    expect(channelsFor(agent({ languages: [] }))).toEqual([agentChannel(TENANT_A, AGENT_A)]);
  });

  it('subscribes once when two profile entries normalise the same', () => {
    // Otherwise the agent receives every queue notification twice.
    expect(channelsFor(agent({ languages: ['en', 'EN', ' en '] }))).toEqual([
      agentChannel(TENANT_A, AGENT_A),
      queueChannel(TENANT_A, 'en'),
    ]);
  });

  it('ignores an empty language entry rather than subscribing to a blank channel', () => {
    expect(channelsFor(agent({ languages: ['en', '', '   '] }))).toEqual([
      agentChannel(TENANT_A, AGENT_A),
      queueChannel(TENANT_A, 'en'),
    ]);
  });
});

describe('tenant isolation (I8)', () => {
  it('gives two tenants different agent channels for the same user id', () => {
    expect(agentChannel(TENANT_A, AGENT_A)).not.toBe(agentChannel(TENANT_B, AGENT_A));
  });

  it('gives two tenants different queue channels for the same language', () => {
    expect(queueChannel(TENANT_A, 'en')).not.toBe(queueChannel(TENANT_B, 'en'));
  });

  it('puts the tenant in every agent-side channel a connection holds', () => {
    for (const channel of channelsFor(agent({ languages: ['en', 'hi'] }))) {
      expect(channel).toContain(TENANT_A);
    }
  });
});

describe('language normalisation', () => {
  /**
   * The same rule T17's queue view applies. Asserted against `queueKey` rather
   * than assumed: if the two ever diverge, a session would be queued under one
   * spelling and announced under another, and no agent would hear about it.
   */
  it('matches the queue projection’s rule exactly', () => {
    for (const language of ['en', 'EN', ' En ', 'hi', 'en-IN', 'EN-in']) {
      const fromQueue = queueKey(TENANT_A, language).split(':').slice(2).join(':');
      const fromRealtime = queueChannel(TENANT_A, language).split(':').slice(3).join(':');
      expect(fromRealtime).toBe(fromQueue);
    }
  });

  it('treats case as insignificant', () => {
    expect(normaliseLanguage(' EN ')).toBe('en');
    expect(queueChannel(TENANT_A, 'EN')).toBe(queueChannel(TENANT_A, 'en'));
  });

  it('keeps en distinct from en-IN', () => {
    // A tenant that staffs them separately means it; collapsing would route a
    // session to an agent who cannot serve it.
    expect(queueChannel(TENANT_A, 'en')).not.toBe(queueChannel(TENANT_A, 'en-IN'));
  });
});

describe('channel names', () => {
  it('share one prefix, so every realtime key is greppable', () => {
    expect(sessionChannel(SESSION).startsWith('rt:')).toBe(true);
    expect(agentChannel(TENANT_A, AGENT_A).startsWith('rt:')).toBe(true);
    expect(queueChannel(TENANT_A, 'en').startsWith('rt:')).toBe(true);
  });

  it('never collide across kinds', () => {
    const all = new Set([
      sessionChannel(SESSION),
      agentChannel(TENANT_A, AGENT_A),
      queueChannel(TENANT_A, 'en'),
    ]);
    expect(all.size).toBe(3);
  });
});
