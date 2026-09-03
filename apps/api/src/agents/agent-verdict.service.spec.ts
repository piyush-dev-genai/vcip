/**
 * Submitting a verdict (T35).
 *
 * The transaction itself is PostgreSQL's job and is asserted through its
 * command: what this suite proves is that the command is built correctly, that
 * the guard's refusal becomes a 409 rather than an exception nobody expects,
 * and — most of all — the ordering. Billing follows the outcome table, the
 * checklist is validated before anything opens a transaction, the AI is read
 * and never consulted, and nothing after the commit can fail the verdict.
 */

import { Writable } from 'node:stream';
import type { AiHudPayload } from '@vcip/shared';
import {
  ErrorCode,
  LivenessStatus,
  OcrStatus,
  SessionEventType,
  SessionStatus,
} from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AiHudRepository } from '../ai/ai-hud.repository.js';
import type {
  ChecklistRepository,
  ChecklistSessionRow,
} from '../checklist/checklist.repository.js';
import { ChecklistService } from '../checklist/checklist.service.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import type { AgentActor } from '../common/auth/auth-context.js';
import { createLogger } from '../common/logging/logger.js';
import { RecordingNotifications } from '../realtime/notifications.testing.js';
import type {
  MediaTokenSessionRow,
  SessionRepository,
  SubmitVerdictCommand,
  SubmitVerdictOutcome,
} from '../sessions/session.repository.js';
import { AgentVerdictService, SESSION_COMPLETED_EVENT } from './agent-verdict.service.js';
import type { PresenceService } from './presence.service.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_AGENT = '00000000-0000-4000-8000-0000000000a2';
const SESSION = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-03T12:00:00.000Z');

const ITEMS = [
  { key: 'face_visible', label: 'Customer face visible', required: true },
  { key: 'document_shown', label: 'Original document shown', required: true },
];

const actor: AgentActor = {
  kind: 'agent',
  tenantId: TENANT,
  userId: AGENT,
  role: 'AGENT',
} as unknown as AgentActor;

const answers = (over: Record<string, boolean> = {}) =>
  ITEMS.map((item) => ({ key: item.key, checked: over[item.key] ?? true }));

const HUD: AiHudPayload = {
  session_id: SESSION,
  liveness_score: 97,
  liveness_status: LivenessStatus.LIVE,
  face_match_score: 95,
  ocr_status: OcrStatus.PASS,
  model_versions: { liveness: 'demo-v1' },
  updated_at: NOW.toISOString(),
  document_type: null,
  document_status: null,
  document_checked_at: null,
};

// --------------------------------------------------------------------- fakes

class FakeSessions {
  row: MediaTokenSessionRow | null = {
    id: SESSION,
    tenantId: TENANT,
    status: SessionStatus.IN_CALL,
    roomName: `vcip_${SESSION}`,
    agentId: AGENT,
  };

  readonly commands: SubmitVerdictCommand[] = [];
  outcome: SubmitVerdictOutcome | null = null;

  findForMediaToken(tenantId: string, sessionId: string): Promise<MediaTokenSessionRow | null> {
    const found = this.row?.tenantId === tenantId && this.row.id === sessionId ? this.row : null;
    return Promise.resolve(found);
  }

  submitVerdict(command: SubmitVerdictCommand): Promise<SubmitVerdictOutcome> {
    this.commands.push(command);
    if (this.outcome !== null) return Promise.resolve(this.outcome);

    return Promise.resolve({
      kind: 'COMMITTED',
      session: {
        id: command.sessionId,
        status: command.verdict,
        verdict: command.verdict,
        billCategory: command.billCategory,
        billAmountPaise: command.billAmountPaise,
        talkMs: 90_000,
      },
    });
  }
}

class FakeChecklistRepository implements ChecklistRepository {
  stored: ChecklistSessionRow | null = {
    sessionId: SESSION,
    tenantId: TENANT,
    assignedAgentId: AGENT,
    templateId: '22222222-2222-4222-8222-222222222222',
    version: 1,
    items: ITEMS,
  };

  findForSession(): Promise<ChecklistSessionRow | null> {
    return Promise.resolve(this.stored);
  }

  saveAnswers(): Promise<never> {
    throw new Error('the verdict transaction writes the checklist, not the service');
  }
}

class FakeHud implements AiHudRepository {
  payload: AiHudPayload | null = HUD;
  fails = false;

  save(): Promise<AiHudPayload> {
    throw new Error('a verdict must never write the HUD');
  }

  saveDocument(): Promise<AiHudPayload | null> {
    throw new Error('a verdict must never write a document check');
  }

  read(): Promise<AiHudPayload | null> {
    if (this.fails) return Promise.reject(new Error('redis is not answering'));
    return Promise.resolve(this.payload);
  }
}

class FakePresence {
  readonly freed: string[] = [];
  fails = false;

  markAvailable(agentId: string): Promise<void> {
    if (this.fails) return Promise.reject(new Error('redis is not answering'));
    this.freed.push(agentId);
    return Promise.resolve();
  }
}

let sessions: FakeSessions;
let checklistRepo: FakeChecklistRepository;
let hud: FakeHud;
let presence: FakePresence;
let notify: RecordingNotifications;
let service: AgentVerdictService;

/** A logger that writes nowhere. Built per call, so no state is shared. */
const silentLogger = () =>
  createLogger({
    level: 'silent',
    destination: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  });

beforeEach(() => {
  const silent = silentLogger();

  sessions = new FakeSessions();
  checklistRepo = new FakeChecklistRepository();
  hud = new FakeHud();
  presence = new FakePresence();
  notify = new RecordingNotifications();

  service = new AgentVerdictService(
    sessions as unknown as SessionRepository,
    new ChecklistService(checklistRepo, new TenantScope(), silent),
    hud,
    presence as unknown as PresenceService,
    new TenantScope(),
    notify,
    silent,
    () => NOW,
  );
});

const submit = (verdict: SessionStatus = SessionStatus.APPROVED, checklist = answers()) =>
  service.submit(actor, SESSION, { verdict, checklist } as never);

const command = (): SubmitVerdictCommand => sessions.commands[0] as SubmitVerdictCommand;

// -------------------------------------------------------------------- tests

describe('a verdict that commits', () => {
  it('reports what was written, not what was asked for', async () => {
    await expect(submit()).resolves.toEqual({
      session_id: SESSION,
      status: SessionStatus.APPROVED,
      verdict: SessionStatus.APPROVED,
      bill_category: 'SUCCESS',
      bill_amount_paise: 2500,
    });
  });

  it.each([
    [SessionStatus.APPROVED, 'SUCCESS', 2500],
    [SessionStatus.REJECTED, 'FAILED', 500],
    [SessionStatus.ABORTED, 'FAILED', 500],
  ])('bills %s as %s', async (verdict, category, amount) => {
    // Straight from `@vcip/shared`'s outcome table. Nothing in this service
    // decides an amount, which is why there is no arithmetic here to get wrong.
    await submit(verdict);

    expect(command().billCategory).toBe(category);
    expect(command().billAmountPaise).toBe(amount);
  });

  it('uses one clock reading for the verdict, the end, and the invoice month', async () => {
    // Four jobs, one value. Two readings could straddle midnight and bill a
    // verification to a month its verdict does not fall in.
    await submit();

    expect(command().now).toBe(NOW);
  });

  it('appends the verdict and the billing row as history, in that order', async () => {
    await submit();

    expect(command().events.map((event) => event.type)).toEqual([
      SessionEventType.VERDICT_SUBMITTED,
      SessionEventType.BILLING_CREATED,
    ]);
  });

  it('records who decided, and that the charge was the system', async () => {
    await submit();

    expect(command().events[0]?.actorId).toBe(AGENT);
    expect(command().events[1]?.actorType).toBe('SYSTEM');
  });

  it('frees the agent', async () => {
    // R5: BUSY is cleared when the session ends.
    await submit();

    expect(presence.freed).toEqual([AGENT]);
  });

  it('tells both screens the session is over', async () => {
    await submit();

    expect(notify.of('sessionCompleted')[0]?.args).toEqual([
      SESSION,
      SessionStatus.APPROVED,
      SessionStatus.APPROVED,
      { tenantId: TENANT, userId: AGENT },
    ]);
  });
});

describe('the checklist', () => {
  it('is validated against the pinned template before anything is written', async () => {
    await expect(
      submit(SessionStatus.APPROVED, answers({ document_shown: false })),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE });

    expect(sessions.commands).toEqual([]);
  });

  it('travels into the transaction in template order', async () => {
    await submit(SessionStatus.APPROVED, [...answers()].reverse());

    expect(command().checklist).toEqual([
      { key: 'face_visible', checked: true },
      { key: 'document_shown', checked: true },
    ]);
  });

  it('lets a rejection through with a required item unchecked', async () => {
    // An agent rejects *because* a check failed. T34's reading of §18.
    await expect(
      submit(SessionStatus.REJECTED, answers({ face_visible: false })),
    ).resolves.toMatchObject({ verdict: SessionStatus.REJECTED });
  });

  it('records the unchecked item rather than dropping it', async () => {
    await submit(SessionStatus.REJECTED, answers({ face_visible: false }));

    expect(command().checklist[0]).toEqual({ key: 'face_visible', checked: false });
  });

  it('is in the history as well as the row set', async () => {
    await submit();

    expect(command().events[0]?.payload).toMatchObject({
      checklist: [
        { key: 'face_visible', checked: true },
        { key: 'document_shown', checked: true },
      ],
    });
  });
});

describe('the AI summary', () => {
  it('carries the HUD as it stood', async () => {
    await submit();

    expect(command().aiSummary).toEqual(HUD);
  });

  it('is null when the AI never ran, rather than an all-zero summary', async () => {
    // T32: a killed analyzer writes no HUD. "No AI" and "the models decided
    // nothing" are different claims, and only one of them is true.
    hud.payload = null;
    await submit();

    expect(command().aiSummary).toBeNull();
  });

  it('is null when Redis will not answer, and the verdict still commits', async () => {
    // AI is assistive (D6). Losing the summary is strictly better than losing
    // the verdict.
    hud.fails = true;

    await expect(submit()).resolves.toMatchObject({ verdict: SessionStatus.APPROVED });
    expect(command().aiSummary).toBeNull();
  });

  it('never changes the outcome (I7)', async () => {
    // The same verdict, the same billing, whatever the model said.
    hud.payload = { ...HUD, liveness_score: 3, liveness_status: LivenessStatus.NOT_LIVE };
    const withBadScores = await submit();

    hud.payload = HUD;
    sessions.commands.length = 0;
    const withGoodScores = await submit();

    expect(withBadScores).toEqual(withGoodScores);
  });
});

describe('the webhook outbox (D21)', () => {
  it('is written with the verdict', async () => {
    await submit();

    expect(command().webhookEventType).toBe(SESSION_COMPLETED_EVENT);
  });

  it('carries the outcome and what it cost', async () => {
    await submit();

    expect(command().webhookPayload).toMatchObject({
      event: SESSION_COMPLETED_EVENT,
      session_id: SESSION,
      verdict: SessionStatus.APPROVED,
      bill_category: 'SUCCESS',
      bill_amount_paise: 2500,
    });
  });

  it('carries no evidence keys, because they do not exist yet', async () => {
    // D21: the payload is enriched in place when the export resolves (T42).
    await submit();

    const payload = command().webhookPayload;
    for (const key of ['video_key', 'audit_key', 'signature_key', 'evidence_available']) {
      expect(payload).not.toHaveProperty(key);
    }
  });
});

describe('who may submit one', () => {
  it('refuses an agent who does not hold the session', async () => {
    sessions.row = { ...sessions.row, agentId: OTHER_AGENT } as MediaTokenSessionRow;

    await expect(submit()).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('refuses a session that is not in call', async () => {
    sessions.row = { ...sessions.row, status: SessionStatus.QUEUED } as MediaTokenSessionRow;

    await expect(submit()).rejects.toMatchObject({ code: ErrorCode.SESSION_INVALID_STATE });
  });

  it('reports the wrong state before the wrong agent', async () => {
    // Telling an agent a queued session belongs to someone else would be a
    // statement about a session they have no relationship with.
    sessions.row = {
      ...sessions.row,
      status: SessionStatus.QUEUED,
      agentId: OTHER_AGENT,
    } as MediaTokenSessionRow;

    await expect(submit()).rejects.toMatchObject({ code: ErrorCode.SESSION_INVALID_STATE });
  });

  it('answers 404 for another tenant, never 403', async () => {
    // `TenantScope` decides this, and it answers "not found" for both missing
    // and not-yours. A 403 would confirm the id exists somewhere.
    sessions.row = null;

    await expect(submit()).rejects.toMatchObject({
      response: { code: ErrorCode.NOT_FOUND },
    });
  });

  it('writes nothing when it refuses', async () => {
    sessions.row = { ...sessions.row, agentId: OTHER_AGENT } as MediaTokenSessionRow;
    await submit().catch(() => undefined);

    expect(sessions.commands).toEqual([]);
    expect(presence.freed).toEqual([]);
  });
});

describe('losing the race (D17)', () => {
  it('answers 409 when the guard matched nothing', async () => {
    // The customer dropped and the sweeper got there first, or a duplicate
    // arrived behind the winner. Same fact from the loser's side.
    sessions.outcome = { kind: 'LOST' };

    await expect(submit()).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('does not free an agent whose verdict did not commit', async () => {
    // The winner's path frees them. Doing it here too would clear a BUSY that
    // belongs to whatever outcome actually committed.
    sessions.outcome = { kind: 'LOST' };
    await submit().catch(() => undefined);

    expect(presence.freed).toEqual([]);
  });

  it('announces nothing', async () => {
    sessions.outcome = { kind: 'LOST' };
    await submit().catch(() => undefined);

    expect(notify.kinds()).toEqual([]);
  });
});

describe('after the commit, nothing may fail the verdict', () => {
  it('survives the presence key refusing to clear', async () => {
    // The transaction has committed and the money is recorded. An exception
    // here would tell an agent their verdict failed when it is already law.
    presence.fails = true;

    await expect(submit()).resolves.toMatchObject({ verdict: SessionStatus.APPROVED });
  });

  it('survives the notification failing', async () => {
    // T27 owns the transport, and a socket nobody is listening on must not
    // throw at an agent whose verdict has already been recorded.
    const broken = Object.assign(new RecordingNotifications(), {
      sessionCompleted: () => Promise.reject(new Error('redis pub/sub is down')),
    });
    const withBrokenNotify = new AgentVerdictService(
      sessions as unknown as SessionRepository,
      new ChecklistService(checklistRepo, new TenantScope(), silentLogger()),
      hud,
      presence as unknown as PresenceService,
      new TenantScope(),
      broken,
      silentLogger(),
      () => NOW,
    );

    await expect(
      withBrokenNotify.submit(actor, SESSION, {
        verdict: SessionStatus.APPROVED,
        checklist: answers(),
      } as never),
    ).resolves.toMatchObject({ verdict: SessionStatus.APPROVED });
  });
});
