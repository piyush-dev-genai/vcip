/**
 * Starting an AI analysis (T30).
 *
 * The subject is one decision — what happens on the call-start path when the
 * AI service is there, is not there, or refuses — so everything it touches is
 * a double. No SFU, no Python process, no database.
 */

import { SessionEventType } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../common/logging/logger.js';
import type { LiveKitConfig } from '../livekit/livekit.config.js';
import type { MediaTokenGrantRequest, MediaTokenMinter } from '../livekit/media-token.minter.js';
import { MediaRole } from '../livekit/media-token.rules.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import type { AnalysisStarter } from './ai-analysis.client.js';
import { AiAnalysisOutcome, AiAnalysisService } from './ai-analysis.service.js';
import type { AiConfig } from './ai.config.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
const TENANT = 'tenant-1';
const ROOM = `vcip_${SESSION}`;

const LIVEKIT = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'a'.repeat(32),
  tokenTtlSeconds: 900,
} as unknown as LiveKitConfig;

class FakeSessions {
  readonly appended: { type: string; payload: unknown }[] = [];
  events = new Set<string>();

  hasEvent(_sessionId: string, type: string): Promise<boolean> {
    return Promise.resolve(this.events.has(type));
  }

  appendCallEvent(_sessionId: string, event: { type: string; payload: unknown }): Promise<void> {
    this.appended.push(event);
    this.events.add(event.type);
    return Promise.resolve();
  }
}

class FakeMinter implements MediaTokenMinter {
  readonly requests: MediaTokenGrantRequest[] = [];
  fails = false;

  mint(request: MediaTokenGrantRequest): Promise<string> {
    this.requests.push(request);
    if (this.fails) return Promise.reject(new Error('no signing key'));
    return Promise.resolve('an.analyzer.token');
  }
}

class FakeStarter implements AnalysisStarter {
  readonly calls: { sessionId: string; request: Record<string, unknown> }[] = [];
  failWith: Error | null = null;

  start(sessionId: string, request: Record<string, unknown>): Promise<void> {
    this.calls.push({ sessionId, request });
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve();
  }
}

let sessions: FakeSessions;
let minter: FakeMinter;
let starter: FakeStarter;

const build = (config: Partial<AiConfig> = {}): AiAnalysisService => {
  const sink = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });

  return new AiAnalysisService(
    sessions as unknown as SessionRepository,
    minter,
    starter as unknown as AnalysisStarter,
    { enabled: true, baseUrl: 'http://ai.test', startTimeoutMs: 2_000, ...config },
    LIVEKIT,
    createLogger({ level: 'silent', destination: sink }),
  );
};

beforeEach(() => {
  sessions = new FakeSessions();
  minter = new FakeMinter();
  starter = new FakeStarter();
});

describe('starting an analysis', () => {
  it('asks the AI service to analyse the session room', async () => {
    const outcome = await build().start(SESSION, TENANT, ROOM);

    expect(outcome).toBe(AiAnalysisOutcome.STARTED);
    expect(starter.calls).toHaveLength(1);
    expect(starter.calls[0]!.sessionId).toBe(SESSION);
    expect(starter.calls[0]!.request).toEqual({
      room_name: ROOM,
      token: 'an.analyzer.token',
      livekit_url: LIVEKIT.url,
    });
  });

  it('mints the analyzer role and no other', async () => {
    await build().start(SESSION, TENANT, ROOM);

    expect(minter.requests[0]!.role).toBe(MediaRole.ANALYZER);
    expect(minter.requests[0]!.roomName).toBe(ROOM);
  });

  it('mints a token bound to this session and tenant', async () => {
    await build().start(SESSION, TENANT, ROOM);

    expect(minter.requests[0]).toMatchObject({
      sessionId: SESSION,
      tenantId: TENANT,
      // The analyzer is not a person; `user_id` is the agent's or nothing.
      userId: null,
    });
  });

  it('records nothing when it succeeds', async () => {
    await build().start(SESSION, TENANT, ROOM);

    expect(sessions.appended).toEqual([]);
  });
});

describe('when there is no AI', () => {
  it('does nothing at all when AI is disabled', async () => {
    const outcome = await build({ enabled: false }).start(SESSION, TENANT, ROOM);

    expect(outcome).toBe(AiAnalysisOutcome.DISABLED);
    expect(minter.requests).toEqual([]);
    expect(starter.calls).toEqual([]);
    // Disabled on purpose is not an incident, so it is not in the history.
    expect(sessions.appended).toEqual([]);
  });

  it('refuses to analyse a session with no room', async () => {
    const outcome = await build().start(SESSION, TENANT, null);

    expect(outcome).toBe(AiAnalysisOutcome.NO_ROOM);
    expect(starter.calls).toEqual([]);
  });
});

describe('when the AI service will not take it', () => {
  it('does not throw — the call is never affected (D6)', async () => {
    starter.failWith = new Error('connect ECONNREFUSED');

    await expect(build().start(SESSION, TENANT, ROOM)).resolves.toBe(AiAnalysisOutcome.FAILED);
  });

  it('records AI_UNAVAILABLE so the history says why the HUD was blank', async () => {
    starter.failWith = new Error('connect ECONNREFUSED');

    await build().start(SESSION, TENANT, ROOM);

    expect(sessions.appended).toHaveLength(1);
    expect(sessions.appended[0]!.type).toBe(SessionEventType.AI_UNAVAILABLE);
  });

  it('records it once, however many times a start is attempted', async () => {
    starter.failWith = new Error('connect ECONNREFUSED');
    const service = build();

    await service.start(SESSION, TENANT, ROOM);
    await service.start(SESSION, TENANT, ROOM);

    expect(sessions.appended).toHaveLength(1);
  });

  it('records the message and not the error object', async () => {
    // A fetch failure stringifies with the request it failed on, and that
    // request carried a LiveKit join token and the internal credential.
    starter.failWith = new Error('connect ECONNREFUSED');

    await build().start(SESSION, TENANT, ROOM);

    expect(sessions.appended[0]!.payload).toEqual({ reason: 'connect ECONNREFUSED' });
  });

  it('survives the token minting failing too', async () => {
    minter.fails = true;

    const outcome = await build().start(SESSION, TENANT, ROOM);

    expect(outcome).toBe(AiAnalysisOutcome.FAILED);
    expect(starter.calls).toEqual([]);
    expect(sessions.appended[0]!.type).toBe(SessionEventType.AI_UNAVAILABLE);
  });
});

describe('what it never does', () => {
  it('never changes a session status', async () => {
    // The fake would record any write. Only `session_events` is ever touched,
    // and only with a non-terminal, non-billable name (I7, I11).
    await build().start(SESSION, TENANT, ROOM);
    starter.failWith = new Error('gone');
    await build().start(SESSION, TENANT, ROOM);

    expect(sessions.appended.map((e) => e.type)).toEqual([SessionEventType.AI_UNAVAILABLE]);
  });
});
