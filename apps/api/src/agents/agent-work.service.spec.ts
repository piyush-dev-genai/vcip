/**
 * "What am I holding" — the read that stops an agent being stranded.
 *
 * The service is thin on purpose: the predicate that decides what counts as
 * held work lives in one SQL clause shared with the capacity count, so what is
 * worth testing here is the projection and the shape, and that the agent and
 * tenant come from the credential rather than from anything a caller supplies.
 */

import { SessionStatus } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentActor } from '../common/auth/auth-context.js';
import { ActorRole } from '../common/auth/auth-context.js';
import type {
  AcceptCommand,
  AgentWorkRow,
  CallSessionRow,
  EndedCallRow,
  ClaimCommand,
  ClaimableSessionRow,
  CreateSessionInput,
  ExpiredOfferRow,
  GuardedUpdate,
  MediaTokenSessionRow,
  QueuedSessionRow,
  SessionAcceptOutcome,
  SessionClaimOutcome,
  SessionRepository,
  SessionRow,
  UnrecordedCallRow,
} from '../sessions/session.repository.js';
import { AgentWorkService } from './agent-work.service.js';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const MINE = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '00000000-0000-4000-8000-00000000e001';
const OTHER = '00000000-0000-4000-8000-00000000e002';

const NOW = new Date('2026-09-01T12:00:00.000Z');

const actor = (userId = MINE, tenantId = TENANT_A): AgentActor => ({
  kind: 'agent',
  tenantId,
  userId,
  role: ActorRole.AGENT,
});

const row = (over: Partial<AgentWorkRow> = {}): AgentWorkRow => ({
  id: SESSION,
  tenantId: TENANT_A,
  status: SessionStatus.IN_CALL,
  roomName: `vcip_${SESSION}`,
  offerExpiresAt: null,
  heldSince: NOW,
  ...over,
});

/** Records what it was asked, so the credential-only rule is assertable. */
class FakeSessions implements SessionRepository {
  rows: readonly AgentWorkRow[] = [];
  readonly asked: { tenantId: string; agentId: string }[] = [];

  findUnrecordedCalls(): Promise<readonly UnrecordedCallRow[]> {
    throw new Error('reading work must not look for unrecorded calls');
  }

  findForCallEvent(): Promise<CallSessionRow | null> {
    throw new Error('reading work must not drive call lifecycle');
  }

  appendCallEvent(): Promise<boolean> {
    throw new Error('reading work must not drive call lifecycle');
  }

  hasEvent(): Promise<boolean> {
    throw new Error('reading work must not drive call lifecycle');
  }

  submitVerdict(): Promise<never> {
    throw new Error('listing work must not submit a verdict');
  }

  endCall(): Promise<EndedCallRow | null> {
    throw new Error('reading work must not drive call lifecycle');
  }

  findActiveWork(tenantId: string, agentId: string): Promise<readonly AgentWorkRow[]> {
    this.asked.push({ tenantId, agentId });
    return Promise.resolve(this.rows);
  }

  create(_i: CreateSessionInput): Promise<SessionRow> {
    throw new Error('reading work must not create a session');
  }
  update(_c: GuardedUpdate): Promise<SessionRow | null> {
    throw new Error('reading work must not mutate a session');
  }

  abortSession(): Promise<SessionRow | null> {
    throw new Error('reading work must not abort a session');
  }
  claim(_c: ClaimCommand): Promise<SessionClaimOutcome> {
    throw new Error('reading work must not claim a session');
  }
  accept(_c: AcceptCommand): Promise<SessionAcceptOutcome> {
    throw new Error('reading work must not accept a session');
  }
  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    throw new Error('reading work must not sweep offers');
  }
  findById(): Promise<SessionRow | null> {
    throw new Error('reading work uses its own narrow projection');
  }
  findClaimable(): Promise<ClaimableSessionRow | null> {
    throw new Error('reading work must not read the claim projection');
  }
  findQueued(): Promise<readonly QueuedSessionRow[]> {
    throw new Error('reading work must not read the queue projection');
  }
  findForMediaToken(): Promise<MediaTokenSessionRow | null> {
    throw new Error('reading work must not mint a media token');
  }
  countActiveWork(): Promise<number> {
    throw new Error('reading work lists it rather than counting it');
  }
}

let sessions: FakeSessions;
let service: AgentWorkService;

beforeEach(() => {
  sessions = new FakeSessions();
  service = new AgentWorkService(sessions);
});

describe('an agent holding nothing', () => {
  it('gets an empty list, not an error', () => {
    // The ordinary case: a signed-in agent with no work. It is not a 404 —
    // "you hold nothing" is a true answer, and the portal renders the queue.
    return expect(service.work(actor())).resolves.toEqual({ sessions: [] });
  });
});

describe('an agent on a call', () => {
  it('reports the session, its status, and its room', async () => {
    sessions.rows = [row()];

    const result = await service.work(actor());

    expect(result.sessions).toEqual([
      {
        session_id: SESSION,
        status: SessionStatus.IN_CALL,
        room_name: `vcip_${SESSION}`,
        offer_expires_at: null,
      },
    ]);
  });

  /**
   * The recovery this endpoint exists for. Before it, a fresh login had no way
   * to learn this id, so the agent sat on the queue screen while their
   * availability was refused for holding it.
   */
  it('gives the portal the id it needs to rejoin the room', async () => {
    sessions.rows = [row()];
    const [held] = (await service.work(actor())).sessions;
    expect(held?.session_id).toBe(SESSION);
    expect(held?.room_name).toBe(`vcip_${SESSION}`);
  });
});

describe('an agent holding an offer', () => {
  it('reports the offer window, which GET /v1/sessions/{id} does not carry', async () => {
    const expires = new Date('2026-09-01T12:00:30.000Z');
    sessions.rows = [row({ status: SessionStatus.OFFERED, offerExpiresAt: expires })];

    const [held] = (await service.work(actor())).sessions;

    expect(held?.status).toBe(SessionStatus.OFFERED);
    expect(held?.offer_expires_at).toBe('2026-09-01T12:00:30.000Z');
  });

  it('reports a call with no window rather than inventing one', async () => {
    sessions.rows = [row({ status: SessionStatus.IN_CALL, offerExpiresAt: null })];
    const [held] = (await service.work(actor())).sessions;
    expect(held?.offer_expires_at).toBeNull();
  });

  /**
   * The case a fake with a tidy null would have missed, and the real database
   * does not: T19's accept keeps `offer_expires_at` as history, so a live call
   * carries the instant its offer would have lapsed. Reporting it would put a
   * running countdown on a call that has no deadline.
   */
  it('hides the offer window a call inherited from its claim', async () => {
    sessions.rows = [
      row({
        status: SessionStatus.IN_CALL,
        offerExpiresAt: new Date('2026-09-01T12:00:30.000Z'),
      }),
    ];

    const [held] = (await service.work(actor())).sessions;

    expect(held?.status).toBe(SessionStatus.IN_CALL);
    expect(held?.offer_expires_at).toBeNull();
  });
});

describe('the agent is the credential, never a parameter', () => {
  it('asks only about the tenant and agent in the JWT', async () => {
    await service.work(actor(MINE, TENANT_A));
    expect(sessions.asked).toEqual([{ tenantId: TENANT_A, agentId: MINE }]);
  });

  it('cannot be pointed at another agent — there is no argument for one', () => {
    // A compile-time property as much as a runtime one: `work` takes an actor
    // and nothing else, so no caller can widen what it returns.
    expect(service.work.length).toBe(1);
  });
});

describe('more than one held session', () => {
  /**
   * `agent_profiles.max_concurrent` may exceed one, so the response is a list.
   * The portal is single-session and takes the first; a shape promising exactly
   * one would be a lie the schema already permits breaking.
   */
  it('reports every session, in the order the repository gave them', async () => {
    sessions.rows = [row(), row({ id: OTHER, status: SessionStatus.OFFERED })];
    const result = await service.work(actor());
    expect(result.sessions.map((s) => s.session_id)).toEqual([SESSION, OTHER]);
  });
});

describe('what reading work does not do', () => {
  it('touches no write path at all', async () => {
    // Every mutating method on the fake throws. Reaching one fails the test
    // rather than passing quietly.
    sessions.rows = [row()];
    await expect(service.work(actor())).resolves.toBeDefined();
  });

  it('exposes nothing about the customer', async () => {
    sessions.rows = [row()];
    const [held] = (await service.work(actor())).sessions;
    expect(Object.keys(held ?? {}).sort()).toEqual([
      'offer_expires_at',
      'room_name',
      'session_id',
      'status',
    ]);
  });
});
