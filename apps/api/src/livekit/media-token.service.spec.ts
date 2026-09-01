/**
 * Issuing a media token, without a server and without a signing key.
 *
 * The minter is a double that records what it was asked for, so these tests are
 * about the decision — who may hold credentials for which session, and what the
 * credential is scoped to. What the JWT actually says is
 * `media-token.minter.spec.ts`, against the real SDK.
 *
 * `TenantScope` is real, so the 404 semantics under test are production code
 * rather than a restatement of them.
 *
 * The session store applies the tenant predicate in its lookup, exactly as the
 * real query has it in the WHERE clause. Dropping it there is the mutation the
 * cross-tenant tests exist to catch.
 */

import { DomainError, ErrorCode, SessionStatus } from '@vcip/shared';
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentActor, CustomerActor } from '../common/auth/auth-context.js';
import { ActorRole } from '../common/auth/auth-context.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import { createLogger } from '../common/logging/logger.js';
import type {
  AcceptCommand,
  AgentWorkRow,
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
} from '../sessions/session.repository.js';
import type { LiveKitConfig } from './livekit.config.js';
import type { MediaTokenGrantRequest, MediaTokenMinter } from './media-token.minter.js';
import { MediaRole } from './media-token.rules.js';
import { MediaTokenService } from './media-token.service.js';

// ------------------------------------------------------------------ fixtures

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const MINE = '00000000-0000-4000-8000-0000000000a1';
const THEIRS = '00000000-0000-4000-8000-0000000000a2';
const SESSION = '00000000-0000-4000-8000-00000000e001';
const OTHER_SESSION = '00000000-0000-4000-8000-00000000e002';
const ROOM = `vcip_${SESSION}`;

const NOW = new Date('2026-09-01T10:00:00.000Z');

const CONFIG: LiveKitConfig = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'FAKE-livekit-secret-for-tests-0123456789',
  tokenTtlSeconds: 900,
};

const customerActor = (sessionId = SESSION, tenantId = TENANT_A): CustomerActor => ({
  kind: 'customer',
  tenantId,
  sessionId,
});

const agentActor = (userId = MINE, tenantId = TENANT_A): AgentActor => ({
  kind: 'agent',
  tenantId,
  userId,
  role: ActorRole.AGENT,
});

const row = (over: Partial<MediaTokenSessionRow> = {}): MediaTokenSessionRow => ({
  id: SESSION,
  tenantId: TENANT_A,
  status: SessionStatus.IN_CALL,
  roomName: ROOM,
  agentId: MINE,
  ...over,
});

// --------------------------------------------------------------------- fakes

class FakeSessions implements SessionRepository {
  readonly rows = new Map<string, MediaTokenSessionRow>();
  /** Proves the invariant: this path writes nothing. */
  writes = 0;

  seed(session: MediaTokenSessionRow): void {
    this.rows.set(session.id, session);
  }

  findForMediaToken(tenantId: string, sessionId: string): Promise<MediaTokenSessionRow | null> {
    const found = this.rows.get(sessionId);
    // The tenant predicate is in the real query's WHERE clause, so a foreign
    // id yields nothing here either.
    if (found === undefined || found.tenantId !== tenantId) return Promise.resolve(null);
    return Promise.resolve(found);
  }

  create(_input: CreateSessionInput): Promise<SessionRow> {
    this.writes += 1;
    throw new Error('issuing a media token must not create a session');
  }

  update(_command: GuardedUpdate): Promise<SessionRow | null> {
    this.writes += 1;
    throw new Error('issuing a media token must not mutate a session');
  }

  claim(_command: ClaimCommand): Promise<SessionClaimOutcome> {
    this.writes += 1;
    throw new Error('issuing a media token must not claim a session');
  }

  accept(_command: AcceptCommand): Promise<SessionAcceptOutcome> {
    this.writes += 1;
    throw new Error('issuing a media token must not accept a session');
  }

  expireOffers(): Promise<readonly ExpiredOfferRow[]> {
    this.writes += 1;
    throw new Error('issuing a media token must not sweep offers');
  }

  findById(): Promise<SessionRow | null> {
    throw new Error('the media-token path reads its own narrow projection');
  }

  findClaimable(): Promise<ClaimableSessionRow | null> {
    throw new Error('the media-token path must not read the claim projection');
  }

  findQueued(): Promise<readonly QueuedSessionRow[]> {
    throw new Error('the media-token path must not read the queue projection');
  }

  findActiveWork(): Promise<readonly AgentWorkRow[]> {
    throw new Error('the media-token path must not read an agent’s work');
  }

  countActiveWork(): Promise<number> {
    throw new Error('the media-token path must not count an agent’s work');
  }
}

class RecordingMinter implements MediaTokenMinter {
  readonly requests: MediaTokenGrantRequest[] = [];

  mint(request: MediaTokenGrantRequest): Promise<string> {
    this.requests.push(request);
    return Promise.resolve(`FAKE-TOKEN-${request.role}`);
  }

  get last(): MediaTokenGrantRequest {
    const request = this.requests.at(-1);
    if (request === undefined) throw new Error('nothing was minted');
    return request;
  }
}

let sessions: FakeSessions;
let minter: RecordingMinter;
let service: MediaTokenService;

beforeEach(() => {
  sessions = new FakeSessions();
  minter = new RecordingMinter();
  service = new MediaTokenService(
    sessions,
    minter,
    CONFIG,
    new TenantScope(),
    createLogger({ level: 'silent' }),
    () => NOW,
  );
});

const expectDomainError = async (promise: Promise<unknown>, code: string): Promise<DomainError> => {
  try {
    await promise;
    expect.unreachable('expected a DomainError');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return error as DomainError;
  }
};

// --------------------------------------------------------------------- tests

describe('the customer path', () => {
  it('issues a token while QUEUED, because R2 named the room at creation', async () => {
    sessions.seed(row({ status: SessionStatus.QUEUED, agentId: null }));

    const result = await service.issue(customerActor(), SESSION);

    expect(result.room_name).toBe(ROOM);
    expect(result.token).toBe('FAKE-TOKEN-customer');
    expect(minter.last.role).toBe(MediaRole.CUSTOMER);
  });

  it('issues a token while IN_CALL', async () => {
    sessions.seed(row());
    await expect(service.issue(customerActor(), SESSION)).resolves.toMatchObject({
      token: 'FAKE-TOKEN-customer',
    });
  });

  it('refuses CREATED with a 409 code', async () => {
    sessions.seed(row({ status: SessionStatus.CREATED, agentId: null }));
    await expectDomainError(
      service.issue(customerActor(), SESSION),
      ErrorCode.SESSION_INVALID_STATE,
    );
  });

  it.each([
    SessionStatus.OFFERED,
    SessionStatus.PREFLIGHT_FAILED,
    SessionStatus.APPROVED,
    SessionStatus.REJECTED,
    SessionStatus.ABORTED,
    SessionStatus.DROPPED_QUEUED,
    SessionStatus.DROPPED_IN_CALL,
  ])('refuses %s', async (status) => {
    sessions.seed(row({ status, agentId: null }));
    await expectDomainError(
      service.issue(customerActor(), SESSION),
      ErrorCode.SESSION_INVALID_STATE,
    );
  });

  it('mints no token when it refuses', async () => {
    sessions.seed(row({ status: SessionStatus.CREATED, agentId: null }));
    await expect(service.issue(customerActor(), SESSION)).rejects.toBeInstanceOf(DomainError);
    expect(minter.requests).toHaveLength(0);
  });

  /** R8: a customer token is bound to one session and can do nothing outside it. */
  it('404s a customer reaching for a sibling session, without querying', async () => {
    sessions.seed(row({ id: OTHER_SESSION }));
    await expect(service.issue(customerActor(SESSION), OTHER_SESSION)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('carries no agent id into the token for a customer', async () => {
    sessions.seed(row());
    await service.issue(customerActor(), SESSION);
    expect(minter.last.userId).toBeNull();
  });
});

describe('the agent path', () => {
  it('issues a token to the assigned agent on an IN_CALL session', async () => {
    sessions.seed(row({ agentId: MINE }));

    const result = await service.issue(agentActor(MINE), SESSION);

    expect(result.token).toBe('FAKE-TOKEN-agent');
    expect(minter.last.role).toBe(MediaRole.AGENT);
    expect(minter.last.userId).toBe(MINE);
  });

  /**
   * The negative this task exists for. Every agent in a tenant can already read
   * every session through `GET /v1/sessions/:id`; reading a status is not the
   * same permission as publishing video into someone else's live verification.
   */
  it('refuses another agent’s IN_CALL session', async () => {
    sessions.seed(row({ agentId: THEIRS }));
    await expectDomainError(
      service.issue(agentActor(MINE), SESSION),
      ErrorCode.SESSION_ALREADY_ASSIGNED,
    );
    expect(minter.requests).toHaveLength(0);
  });

  it('refuses an IN_CALL session that names no agent', async () => {
    sessions.seed(row({ agentId: null }));
    await expectDomainError(
      service.issue(agentActor(MINE), SESSION),
      ErrorCode.SESSION_ALREADY_ASSIGNED,
    );
  });

  it('refuses OFFERED, even to the agent holding the offer', async () => {
    sessions.seed(row({ status: SessionStatus.OFFERED, agentId: null }));
    await expectDomainError(
      service.issue(agentActor(MINE), SESSION),
      ErrorCode.SESSION_INVALID_STATE,
    );
  });

  it('refuses QUEUED', async () => {
    sessions.seed(row({ status: SessionStatus.QUEUED, agentId: null }));
    await expectDomainError(
      service.issue(agentActor(MINE), SESSION),
      ErrorCode.SESSION_INVALID_STATE,
    );
  });

  it('refuses a finished call, so a token cannot outlive the verification', async () => {
    sessions.seed(row({ status: SessionStatus.APPROVED, agentId: MINE }));
    await expectDomainError(
      service.issue(agentActor(MINE), SESSION),
      ErrorCode.SESSION_INVALID_STATE,
    );
  });
});

describe('tenant isolation', () => {
  it('404s another tenant’s session for an agent', async () => {
    sessions.seed(row({ tenantId: TENANT_A, agentId: MINE }));
    await expect(service.issue(agentActor(MINE, TENANT_B), SESSION)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s another tenant’s session for a customer', async () => {
    sessions.seed(row({ tenantId: TENANT_A }));
    await expect(service.issue(customerActor(SESSION, TENANT_B), SESSION)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /**
   * A session that never existed and one belonging to somebody else must be
   * indistinguishable, or the endpoint becomes an oracle for enumerating other
   * tenants' identifiers.
   */
  it('answers an unknown id exactly as it answers a foreign one', async () => {
    sessions.seed(row({ tenantId: TENANT_A }));

    const foreign = await service
      .issue(agentActor(MINE, TENANT_B), SESSION)
      .catch((error: unknown) => error);
    const unknown = await service
      .issue(agentActor(MINE, TENANT_B), OTHER_SESSION)
      .catch((error: unknown) => error);

    expect(foreign).toBeInstanceOf(NotFoundException);
    expect(unknown).toBeInstanceOf(NotFoundException);
    expect((foreign as NotFoundException).getResponse()).toEqual(
      (unknown as NotFoundException).getResponse(),
    );
  });
});

describe('what the token is scoped to', () => {
  beforeEach(() => {
    sessions.seed(row());
  });

  it('binds it to the room on the session row', async () => {
    await service.issue(agentActor(MINE), SESSION);
    expect(minter.last.roomName).toBe(ROOM);
  });

  it('falls back to the derived room name for a row written without one', async () => {
    sessions.seed(row({ roomName: null }));
    const result = await service.issue(agentActor(MINE), SESSION);
    expect(result.room_name).toBe(ROOM);
    expect(minter.last.roomName).toBe(ROOM);
  });

  it('passes the session and tenant through for T26’s metadata', async () => {
    await service.issue(agentActor(MINE), SESSION);
    expect(minter.last.sessionId).toBe(SESSION);
    expect(minter.last.tenantId).toBe(TENANT_A);
  });

  it('mints for the configured TTL', async () => {
    await service.issue(agentActor(MINE), SESSION);
    expect(minter.last.ttlSeconds).toBe(900);
  });

  it('reports an expiry fifteen minutes out, from the same clock reading', async () => {
    const result = await service.issue(agentActor(MINE), SESSION);
    expect(result.expires_at).toBe('2026-09-01T10:15:00.000Z');
  });

  it('returns exactly the three fields contract §13 documents', async () => {
    const result = await service.issue(agentActor(MINE), SESSION);
    expect(Object.keys(result).sort()).toEqual(['expires_at', 'room_name', 'token']);
  });
});

describe('what issuing a token does not do', () => {
  it('writes nothing', async () => {
    sessions.seed(row());
    await service.issue(agentActor(MINE), SESSION);
    await service.issue(customerActor(), SESSION);
    expect(sessions.writes).toBe(0);
  });

  it('is repeatable, because it changes no state', async () => {
    sessions.seed(row());
    const first = await service.issue(agentActor(MINE), SESSION);
    const second = await service.issue(agentActor(MINE), SESSION);
    expect(second).toEqual(first);
    expect(sessions.writes).toBe(0);
  });
});
