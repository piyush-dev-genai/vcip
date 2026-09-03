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
import { DocumentCheckRefusal, DocumentType, ErrorCode, SessionStatus } from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DocumentReadOutcome } from '../ai/ai-document.client.js';
import type { AiConfig } from '../ai/ai.config.js';
import type { AgentActor } from '../common/auth/auth-context.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import { createLogger } from '../common/logging/logger.js';
import type { MediaTokenSessionRow, SessionRepository } from '../sessions/session.repository.js';
import { AgentDocumentService } from './agent-document.service.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_AGENT = '00000000-0000-4000-8000-0000000000a2';
const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';

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
      reason: null,
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

  it('names which of the two it was, rather than blurring them', async () => {
    // These used to report identically, and the portal therefore said the same
    // sentence for both. An agent cannot act on "something went wrong": AI
    // switched off is permanent, an unreachable service is worth retrying.
    const disabled = await check(build(false));

    reader.failWith = new Error('down');
    const unreachable = await check();

    expect(disabled.reason).toBe(DocumentCheckRefusal.AI_DISABLED);
    expect(unreachable.reason).toBe(DocumentCheckRefusal.UNREACHABLE);
  });

  it('reports an absent analyzer as NO_ANALYSIS', async () => {
    reader.outcome = { accepted: false };

    await expect(check()).resolves.toMatchObject({
      accepted: false,
      reason: DocumentCheckRefusal.NO_ANALYSIS,
    });
  });
});

describe('one check at a time, and no more than that', () => {
  /**
   * A reader that stalls one session and answers every other immediately.
   *
   * Stalling everything would deadlock the cross-session case below, which is
   * the one that has to prove the guard is per session rather than global.
   */
  class SlowReader extends FakeReader {
    release: (() => void) | null = null;
    stalls = SESSION;

    override read(sessionId: string, documentType: DocumentType): Promise<DocumentReadOutcome> {
      this.calls.push({ sessionId, documentType });
      if (sessionId !== this.stalls) return Promise.resolve(this.outcome);
      return new Promise((resolve) => {
        this.release = () => {
          resolve(this.outcome);
        };
      });
    }
  }

  it('refuses a second press while the first is still running', async () => {
    const slow = new SlowReader();
    reader = slow;
    const service = build();

    const first = check(service);
    await until(() => slow.release !== null);
    const second = await check(service);

    // The guard's whole purpose: one card, one registry lookup, however many
    // times an impatient agent presses the button.
    expect(second).toMatchObject({
      accepted: false,
      reason: DocumentCheckRefusal.IN_PROGRESS,
    });
    expect(slow.calls).toHaveLength(1);

    slow.release?.();
    await first;
  });

  it('allows a retry as soon as the first has answered', async () => {
    const service = build();

    await check(service);
    const retried = await check(service);

    // The behaviour the first design got wrong. It refused for three seconds
    // after a check, which is exactly the window in which an agent reads
    // "could not read", asks the customer to reposition the card, and presses
    // again. Nothing is in flight, so nothing is refused.
    expect(retried.accepted).toBe(true);
    expect(reader.calls).toHaveLength(2);
  });

  it('releases the session when a check fails', async () => {
    const service = build();
    reader.failWith = new Error('down');
    await check(service);

    reader.failWith = null;
    const retried = await check(service);

    // A session left marked in-flight would be permanently unable to check a
    // document again -- a worse failure than the duplicate lookup the guard
    // exists to prevent.
    expect(retried.accepted).toBe(true);
  });

  it('guards each session separately', async () => {
    const slow = new SlowReader();
    reader = slow;
    const service = build();

    const first = check(service);
    await until(() => slow.release !== null);

    // A different session is a different card and a different agent's screen.
    sessions.row = { ...sessions.row!, id: OTHER_SESSION };
    const other = await service.check(actor, OTHER_SESSION, DocumentType.PAN);

    expect(other.accepted).toBe(true);
    slow.release?.();
    await first;
  });
});

/** Yield until `predicate` holds, or give up rather than hang the suite. */
const until = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
