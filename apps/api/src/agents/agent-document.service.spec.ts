/**
 * The agent asking for a document check (§19).
 *
 * Three things this proves, and all three are about restraint rather than
 * capability:
 *
 *   - **Only the agent on the call may ask.** A colleague, another tenant, or a
 *     session that is not in a call each get the refusal that reveals least.
 *   - **Nothing can fail the call.** An AI service that is down, disabled, or
 *     has no analysis produces `accepted: false` and never an exception, which
 *     is D6 and T32's property applied to a new trigger.
 *   - **No image crosses the boundary.** The request carries a session id and a
 *     document type. That is the whole of it.
 */

import { Writable } from 'node:stream';
import { DocumentType, ErrorCode, SessionStatus } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DocumentReadOutcome } from '../ai/ai-document.client.js';
import type { AiConfig } from '../ai/ai.config.js';
import type { AgentActor } from '../common/auth/auth-context.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import { createLogger } from '../common/logging/logger.js';
import type { MediaTokenSessionRow, SessionRepository } from '../sessions/session.repository.js';
import { AgentDocumentService, DOCUMENT_CHECK_COOLDOWN_MS } from './agent-document.service.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_AGENT = '00000000-0000-4000-8000-0000000000a2';
const SESSION = '11111111-1111-4111-8111-111111111111';

const actor: AgentActor = {
  kind: 'agent',
  tenantId: TENANT,
  userId: AGENT,
  role: 'AGENT',
} as unknown as AgentActor;

class FakeSessions {
  row: MediaTokenSessionRow | null = {
    id: SESSION,
    tenantId: TENANT,
    status: SessionStatus.IN_CALL,
    roomName: `vcip_${SESSION}`,
    agentId: AGENT,
  };

  findForMediaToken(tenantId: string, sessionId: string): Promise<MediaTokenSessionRow | null> {
    const found = this.row?.tenantId === tenantId && this.row.id === sessionId ? this.row : null;
    return Promise.resolve(found);
  }
}

class FakeReader {
  readonly calls: { sessionId: string; documentType: DocumentType }[] = [];
  outcome: DocumentReadOutcome = { accepted: true };
  failWith: Error | null = null;

  read(sessionId: string, documentType: DocumentType): Promise<DocumentReadOutcome> {
    this.calls.push({ sessionId, documentType });
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.outcome);
  }
}

const config = (enabled = true): AiConfig => ({
  enabled,
  baseUrl: 'http://ai.test',
  startTimeoutMs: 2_000,
  documentTimeoutMs: 15_000,
});

let sessions: FakeSessions;
let reader: FakeReader;
let clockMs: number;

const build = (enabled = true) =>
  new AgentDocumentService(
    sessions as unknown as SessionRepository,
    reader,
    config(enabled),
    new TenantScope(),
    createLogger({
      level: 'silent',
      destination: new Writable({
        write(_c, _e, done) {
          done();
        },
      }),
    }),
    () => new Date(clockMs),
  );

beforeEach(() => {
  sessions = new FakeSessions();
  reader = new FakeReader();
  clockMs = Date.parse('2026-09-03T12:00:00.000Z');
});

const check = (service = build(), documentType: DocumentType = DocumentType.PAN) =>
  service.check(actor, SESSION, documentType);

const codeOf = (error: unknown): string =>
  (error as { code?: string; response?: { code?: string } }).code ??
  (error as { response?: { code?: string } }).response?.code ??
  'UNKNOWN';

describe('who may ask', () => {
  it('accepts the agent on the call', async () => {
    await expect(check()).resolves.toEqual({
      session_id: SESSION,
      document_type: DocumentType.PAN,
      accepted: true,
    });
  });

  it('refuses a session that is not in a call', async () => {
    sessions.row = { ...sessions.row!, status: SessionStatus.QUEUED };

    await expect(check()).rejects.toMatchObject({ code: ErrorCode.SESSION_INVALID_STATE });
    expect(reader.calls).toHaveLength(0);
  });

  it('refuses an agent who does not hold the session', async () => {
    sessions.row = { ...sessions.row!, agentId: OTHER_AGENT };

    await expect(check()).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    expect(reader.calls).toHaveLength(0);
  });

  it('checks the status before the assignment', async () => {
    // A queued session belonging to somebody else reports the state, not the
    // ownership: the second would be a statement about a session this agent has
    // no relationship with. Same ordering as the verdict and media-token paths.
    sessions.row = { ...sessions.row!, status: SessionStatus.QUEUED, agentId: OTHER_AGENT };

    await expect(check()).rejects.toMatchObject({ code: ErrorCode.SESSION_INVALID_STATE });
  });

  it("answers another tenant's session as though it did not exist", async () => {
    sessions.row = null;

    // 404, not 403: an id must not be probeable across tenants (I8).
    await expect(check()).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === ErrorCode.NOT_FOUND,
    );
    expect(reader.calls).toHaveLength(0);
  });
});

describe('what crosses the boundary', () => {
  it('sends the session and the document type, and nothing else', async () => {
    await check(build(), DocumentType.AADHAAR);

    expect(reader.calls).toEqual([{ sessionId: SESSION, documentType: DocumentType.AADHAAR }]);
  });

  it('takes the document type from the caller rather than guessing', async () => {
    await check(build(), DocumentType.PAN);
    clockMs += DOCUMENT_CHECK_COOLDOWN_MS;
    await check(build(), DocumentType.AADHAAR);

    expect(reader.calls.map((call) => call.documentType)).toEqual([
      DocumentType.PAN,
      DocumentType.AADHAAR,
    ]);
  });
});

describe('nothing can fail the call (D6)', () => {
  it('reports a refusal from the AI service as not accepted', async () => {
    reader.outcome = { accepted: false };

    await expect(check()).resolves.toMatchObject({ accepted: false });
  });

  it('reports an unreachable AI service as not accepted', async () => {
    reader.failWith = new Error('connect ECONNREFUSED');

    // Never a 500 at an agent who pressed a button: they are told the check did
    // not run, and the verification carries on.
    await expect(check()).resolves.toMatchObject({ accepted: false });
  });

  it('does not call the AI service at all when AI is disabled', async () => {
    const result = await check(build(false));

    expect(result.accepted).toBe(false);
    expect(reader.calls).toHaveLength(0);
  });

  it('reports the same shape whether AI is off or unreachable', async () => {
    // From the agent's side these are one fact: no AI on this call. Reporting
    // them differently would invite a portal to branch on infrastructure.
    const disabled = await check(build(false));

    reader.failWith = new Error('down');
    clockMs += DOCUMENT_CHECK_COOLDOWN_MS;
    const unreachable = await check();

    expect(disabled).toEqual(unreachable);
  });
});

describe('a double press is not two registry lookups', () => {
  it('refuses a second check inside the cooldown', async () => {
    const service = build();
    await check(service);

    clockMs += DOCUMENT_CHECK_COOLDOWN_MS - 1;
    const second = await check(service);

    expect(second.accepted).toBe(false);
    expect(reader.calls).toHaveLength(1);
  });

  it('allows one once the cooldown has passed', async () => {
    const service = build();
    await check(service);

    clockMs += DOCUMENT_CHECK_COOLDOWN_MS;
    await check(service);

    // Short by design: an agent who asked the customer to reposition the card
    // is several seconds away already, so this guards a double-click and
    // nothing more.
    expect(reader.calls).toHaveLength(2);
  });

  it('does not start a cooldown for a check that never ran', async () => {
    const service = build();
    reader.failWith = new Error('down');
    await check(service);

    reader.failWith = null;
    const retried = await check(service);

    // The AI service was unreachable, so nothing was spent and an immediate
    // retry is exactly what the agent should be able to do.
    expect(retried.accepted).toBe(true);
  });
});
