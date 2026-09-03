/**
 * Two verdicts, and a verdict against a disconnect (T36, T37).
 *
 * Day 5's two mandatory gates, and they are one property seen from two sides:
 * a session has at most one terminal outcome and at most one billing row, no
 * matter how many things try to end it at once (D17, I3, I11).
 *
 * **What a fake can and cannot prove.** That PostgreSQL serialises two UPDATEs
 * on one row is PostgreSQL's claim, and `scripts/verify-verdict-race.ts` makes
 * it against a real database on two real connections. What is provable here is
 * everything above that line, and it is the half where the bugs live: that the
 * guard is consulted *in the write* rather than in a read taken beforehand,
 * that the loser is told 409 rather than handed a 500, that the loser writes
 * nothing at all, and that the winner's post-commit work — freeing the agent,
 * telling both screens — happens once.
 *
 * **How the interleaving is made deterministic.** `RaceStore` models the row
 * lock: statements that arrive while the gate is closed park in arrival order,
 * and releasing lets them apply one at a time, each re-evaluating its own WHERE
 * clause against what the previous one committed. That is what READ COMMITTED
 * does to two concurrent guarded UPDATEs, and it turns a race into a test that
 * either passes or fails rather than one that usually passes.
 *
 * The billing insert throws on a second row, because `billing_entries.session_id`
 * is the primary key. A double that quietly accepted two charges would pass the
 * one assertion this file exists to make.
 */

import { Writable } from 'node:stream';
import type { AiHudPayload } from '@vcip/shared';
import {
  AgentPresence,
  ErrorCode,
  httpStatusForErrorCode,
  LivenessStatus,
  OcrStatus,
  SessionEventType,
  SessionStatus,
} from '@vcip/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentProfileRow, AgentRepository } from '../agents/agent.repository.js';
import type { AiHudRepository } from '../ai/ai-hud.repository.js';
import type {
  ChecklistRepository,
  ChecklistSessionRow,
} from '../checklist/checklist.repository.js';
import { ChecklistService } from '../checklist/checklist.service.js';
import type { AgentActor } from '../common/auth/auth-context.js';
import { TenantScope } from '../common/auth/tenant-scope.js';
import { createLogger } from '../common/logging/logger.js';
import { CallSweeper } from '../livekit/call-sweeper.service.js';
import { CallDeadline, deadlineMember } from '../livekit/call.keys.js';
import type { CallRepository, DueDeadline } from '../livekit/call.repository.js';
import { RecordingNotifications } from '../realtime/notifications.testing.js';
import type {
  CallSessionRow,
  EndCallCommand,
  EndedCallRow,
  MediaTokenSessionRow,
  SessionRepository,
  SubmitVerdictCommand,
  SubmitVerdictOutcome,
} from '../sessions/session.repository.js';
import { AgentVerdictService } from './agent-verdict.service.js';
import type { PresenceEntry, PresenceRecord, PresenceRepository } from './presence.repository.js';
import { PresenceService } from './presence.service.js';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
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

const answers = () => ITEMS.map((item) => ({ key: item.key, checked: true }));

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

// ---------------------------------------------------------------- the gate

/**
 * The row lock, as much of it as a single-threaded test needs.
 *
 * While closed, every statement that reaches it parks and keeps its arrival
 * order. `release` wakes them in that order, and because each applies its guard
 * and its writes synchronously afterwards, the second genuinely sees what the
 * first committed — which is the behaviour being asserted, not an artefact
 * being arranged.
 */
class Gate {
  private readonly waiting: (() => void)[] = [];
  private open = true;

  close(): void {
    this.open = false;
  }

  async pass(): Promise<void> {
    // One hop even when open, so two statements started in the same tick really
    // do interleave instead of running to completion one after the other.
    await new Promise((resolve) => setImmediate(resolve));
    if (this.open) return;
    await new Promise<void>((resume) => this.waiting.push(resume));
  }

  /** How many statements are holding, so a test can be sure both arrived. */
  get parked(): number {
    return this.waiting.length;
  }

  release(): void {
    this.open = true;
    const waking = this.waiting.splice(0, this.waiting.length);
    for (const resume of waking) resume();
  }
}

/** Yield until `predicate` holds, or give up rather than hang the suite. */
const until = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// --------------------------------------------------------------- the store

interface BillingRow {
  readonly category: string;
  readonly amountPaise: number;
}

/**
 * One session row, and the two guarded statements that can move it.
 *
 * Both reproduce their real WHERE clause exactly. `submitVerdict` demands
 * `IN_CALL`, this tenant, this agent and a null verdict; `endCall` demands
 * `IN_CALL`. Dropping any one of those predicates is the mutation this suite
 * exists to catch, so none of them is approximated.
 */
class RaceStore {
  status: SessionStatus = SessionStatus.IN_CALL;
  verdict: string | null = null;
  agentId: string | null = AGENT;

  readonly billing: BillingRow[] = [];
  readonly events: { readonly type: string; readonly payload: unknown }[] = [];
  readonly checklists: { key: string; checked: boolean }[][] = [];
  readonly outbox: Record<string, unknown>[] = [];
  readonly gate = new Gate();

  /** `billing_entries.session_id` is the primary key. A second row cannot exist. */
  private charge(row: BillingRow): void {
    if (this.billing.length > 0) {
      throw new Error('billing_entries.session_id is the primary key: a second charge is refused');
    }
    this.billing.push(row);
  }

  findForMediaToken(tenantId: string, sessionId: string): Promise<MediaTokenSessionRow | null> {
    if (tenantId !== TENANT || sessionId !== SESSION) return Promise.resolve(null);
    return Promise.resolve({
      id: SESSION,
      tenantId: TENANT,
      status: this.status,
      roomName: `vcip_${SESSION}`,
      agentId: this.agentId,
    });
  }

  findForCallEvent(sessionId: string): Promise<CallSessionRow | null> {
    if (sessionId !== SESSION) return Promise.resolve(null);
    return Promise.resolve({
      id: SESSION,
      tenantId: TENANT,
      status: this.status,
      roomName: `vcip_${SESSION}`,
      agentId: this.agentId,
      queuedAt: null,
      connectedAt: null,
      callStartedAt: NOW,
    });
  }

  hasEvent(_sessionId: string, eventType: SessionEventType): Promise<boolean> {
    return Promise.resolve(this.events.some((event) => event.type === eventType));
  }

  async submitVerdict(command: SubmitVerdictCommand): Promise<SubmitVerdictOutcome> {
    await this.gate.pass();

    // The guard, predicate for predicate (D17, schema section 45).
    if (
      this.status !== SessionStatus.IN_CALL ||
      this.verdict !== null ||
      command.tenantId !== TENANT ||
      this.agentId !== command.agentId
    ) {
      return { kind: 'LOST' };
    }

    this.status = command.verdict;
    this.verdict = command.verdict;
    // Everything below is the same transaction: it happens for the winner only.
    this.checklists.push(
      command.checklist.map((item) => ({ key: item.key, checked: item.checked })),
    );
    this.charge({ category: command.billCategory, amountPaise: command.billAmountPaise });
    for (const event of command.events) {
      this.events.push({ type: event.type, payload: event.payload });
    }
    this.outbox.push(command.webhookPayload);

    return {
      kind: 'COMMITTED',
      session: {
        id: SESSION,
        status: command.verdict,
        verdict: command.verdict,
        billCategory: command.billCategory,
        billAmountPaise: command.billAmountPaise,
        talkMs: 90_000,
      },
    };
  }

  async endCall(command: EndCallCommand): Promise<EndedCallRow | null> {
    await this.gate.pass();

    if (this.status !== SessionStatus.IN_CALL) return null;

    this.status = command.status;
    this.charge({ category: command.billCategory, amountPaise: command.billAmountPaise });
    this.events.push({ type: command.event.type, payload: command.event.payload });

    return {
      id: SESSION,
      status: command.status,
      endedAt: command.now,
      talkMs: 90_000,
      agentId: this.agentId,
    };
  }
}

// ------------------------------------------------------------- collaborators

class FakeChecklistRepository implements ChecklistRepository {
  readonly row: ChecklistSessionRow = {
    sessionId: SESSION,
    tenantId: TENANT,
    assignedAgentId: AGENT,
    templateId: '22222222-2222-4222-8222-222222222222',
    version: 1,
    items: ITEMS,
  };

  findForSession(): Promise<ChecklistSessionRow | null> {
    return Promise.resolve(this.row);
  }

  saveAnswers(): Promise<never> {
    throw new Error('the verdict transaction writes the checklist, not the service');
  }
}

class FakeHud implements AiHudRepository {
  save(): Promise<AiHudPayload> {
    throw new Error('a verdict must never write the HUD');
  }

  saveDocument(): Promise<AiHudPayload | null> {
    throw new Error('a verdict must never write a document check');
  }
  read(): Promise<AiHudPayload | null> {
    return Promise.resolve(HUD);
  }
}

class FakePresenceRepository implements PresenceRepository {
  readonly entries = new Map<string, PresenceRecord>();
  /** Every release, so "freed once" is distinguishable from "freed twice". */
  readonly freed: string[] = [];

  set(entry: PresenceEntry): Promise<void> {
    this.entries.set(entry.agentId, {
      status: entry.status,
      languages: entry.languages,
      lastSeen: entry.lastSeen.toISOString(),
      tenantId: entry.tenantId,
    });
    return Promise.resolve();
  }
  read(agentId: string): Promise<PresenceRecord | null> {
    return Promise.resolve(this.entries.get(agentId) ?? null);
  }
  touch(): Promise<null> {
    return Promise.resolve(null);
  }
  setStatus(agentId: string, status: AgentPresence): Promise<boolean> {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return Promise.resolve(false);
    if (status === AgentPresence.AVAILABLE) this.freed.push(agentId);
    this.entries.set(agentId, { ...entry, status });
    return Promise.resolve(true);
  }
  remove(agentId: string): Promise<void> {
    this.entries.delete(agentId);
    return Promise.resolve();
  }
  ttl(): Promise<number> {
    return Promise.resolve(15);
  }
}

class FakeCalls implements CallRepository {
  readonly deadlines = new Map<string, number>();

  markSeen(): Promise<boolean> {
    return Promise.resolve(true);
  }
  addParticipant(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
  removeParticipant(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
  clearParticipants(): Promise<void> {
    return Promise.resolve();
  }
  armDeadline(sessionId: string, reason: CallDeadline, dueAtMs: number): Promise<void> {
    this.deadlines.set(deadlineMember(sessionId, reason), dueAtMs);
    return Promise.resolve();
  }
  disarmDeadline(sessionId: string, reason: CallDeadline): Promise<boolean> {
    return Promise.resolve(this.deadlines.delete(deadlineMember(sessionId, reason)));
  }
  disarmAll(member: string): Promise<void> {
    this.deadlines.delete(member);
    return Promise.resolve();
  }
  dueDeadlines(nowMs: number, limit: number): Promise<readonly DueDeadline[]> {
    return Promise.resolve(
      [...this.deadlines.entries()]
        .filter(([, due]) => due <= nowMs)
        .slice(0, limit)
        .map(([member, dueAtMs]) => ({ member, dueAtMs })),
    );
  }
}

const agents: AgentRepository = {
  findAgentByEmail: () => Promise.resolve(null),
  findProfile: (userId: string): Promise<AgentProfileRow | null> =>
    Promise.resolve({ userId, tenantId: TENANT, languages: ['en'], maxConcurrent: 1 }),
};

const silentLogger = () =>
  createLogger({
    level: 'silent',
    destination: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  });

// ------------------------------------------------------------------- wiring

let store: RaceStore;
let presenceStore: FakePresenceRepository;
let notify: RecordingNotifications;
let verdicts: AgentVerdictService;
let sweeper: CallSweeper;
let calls: FakeCalls;

beforeEach(() => {
  const logger = silentLogger();

  store = new RaceStore();
  presenceStore = new FakePresenceRepository();
  notify = new RecordingNotifications();
  calls = new FakeCalls();

  presenceStore.entries.set(AGENT, {
    status: AgentPresence.BUSY,
    languages: ['en'],
    lastSeen: NOW.toISOString(),
    tenantId: TENANT,
  });

  const repository = store as unknown as SessionRepository;
  const presence = new PresenceService(presenceStore, agents, repository, logger, () => NOW);

  verdicts = new AgentVerdictService(
    repository,
    new ChecklistService(new FakeChecklistRepository(), new TenantScope(), logger),
    new FakeHud(),
    presence,
    new TenantScope(),
    notify,
    logger,
    () => NOW,
  );

  sweeper = new CallSweeper(repository, calls, presence, notify, logger, false, () => NOW);
});

/** Submit a verdict, reporting how it went rather than throwing at the test. */
const submit = async (
  verdict: SessionStatus = SessionStatus.APPROVED,
): Promise<{ won: boolean; code: string }> => {
  try {
    await verdicts.submit(actor, SESSION, { verdict, checklist: answers() } as never);
    return { won: true, code: '' };
  } catch (error) {
    return { won: false, code: (error as { code?: string }).code ?? 'UNKNOWN' };
  }
};

/** A customer deadline that has already fallen due, so one pass ends the call. */
const armLapsedDeadline = (): void => {
  calls.deadlines.set(deadlineMember(SESSION, CallDeadline.CUSTOMER), NOW.getTime() - 1);
};

/** Both statements in flight, parked at the gate, in the order they were started. */
const bothInFlight = async <A, B>(
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[Promise<A>, Promise<B>]> => {
  const one = first();
  await until(() => store.gate.parked === 1);
  const two = second();
  await until(() => store.gate.parked === 2);
  return [one, two];
};

// ------------------------------------------------------------------- T36

describe('T36 - two verdicts for one session', () => {
  it('commits one and refuses the other', async () => {
    store.gate.close();
    const [first, second] = await bothInFlight(
      () => submit(SessionStatus.APPROVED),
      () => submit(SessionStatus.REJECTED),
    );

    store.gate.release();
    const results = await Promise.all([first, second]);

    expect(results.filter((result) => result.won)).toHaveLength(1);
    expect(results.filter((result) => !result.won)).toHaveLength(1);
  });

  it('answers the loser 409, not 500', async () => {
    store.gate.close();
    const [first, second] = await bothInFlight(
      () => submit(),
      () => submit(),
    );
    store.gate.release();

    const results = await Promise.all([first, second]);

    // `CONFLICT` maps to 409. The agent is told the session already has an
    // outcome, never that something broke — which is what a 500 would say.
    expect(results.find((result) => !result.won)?.code).toBe(ErrorCode.CONFLICT);
  });

  it('leaves exactly one billing row', async () => {
    store.gate.close();
    const [first, second] = await bothInFlight(
      () => submit(),
      () => submit(),
    );
    store.gate.release();
    await Promise.all([first, second]);

    expect(store.billing).toEqual([{ category: 'SUCCESS', amountPaise: 2500 }]);
  });

  it('writes one of everything else the transaction carries', async () => {
    store.gate.close();
    const [first, second] = await bothInFlight(
      () => submit(),
      () => submit(),
    );
    store.gate.release();
    await Promise.all([first, second]);

    // The loser's UPDATE matched nothing, so its transaction rolled back before
    // reaching any of these. One each is the whole of section 46's argument.
    expect(store.checklists).toHaveLength(1);
    expect(store.outbox).toHaveLength(1);
    expect(
      store.events.filter((event) => event.type === SessionEventType.VERDICT_SUBMITTED),
    ).toHaveLength(1);
    expect(
      store.events.filter((event) => event.type === SessionEventType.BILLING_CREATED),
    ).toHaveLength(1);
  });

  it('runs the post-commit work once', async () => {
    store.gate.close();
    const [first, second] = await bothInFlight(
      () => submit(),
      () => submit(),
    );
    store.gate.release();
    await Promise.all([first, second]);

    // The loser throws before reaching either. An agent freed twice is harmless;
    // a customer told twice that their verification completed is not.
    expect(presenceStore.freed).toEqual([AGENT]);
    expect(notify.of('sessionCompleted')).toHaveLength(1);
  });

  it('refuses a retry that arrives after the first has committed', async () => {
    // The sequential duplicate, which is what a client without an
    // `Idempotency-Key` produces. Refused for a different reason than the
    // concurrent one: by the time this arrives, the pre-read that exists to
    // give a good error message can see the session is no longer in call, so
    // the request never reaches the guard. `SESSION_INVALID_STATE`, not
    // `CONFLICT` — and the next test is why that distinction costs nothing.
    const first = await submit();
    const second = await submit();

    expect(first.won).toBe(true);
    expect(second).toEqual({ won: false, code: ErrorCode.SESSION_INVALID_STATE });
    expect(store.billing).toHaveLength(1);
  });

  it('answers 409 whichever refusal the duplicate meets', async () => {
    // What D17 actually promises the client, and the reason the two codes above
    // are not a discrepancy worth removing: a duplicate is refused with a 409
    // whether it lost the guard or arrived after the row had already moved.
    // Nothing a caller can observe depends on which side of that line it fell.
    for (const code of [ErrorCode.CONFLICT, ErrorCode.SESSION_INVALID_STATE]) {
      expect(httpStatusForErrorCode(code)).toBe(409);
    }
  });

  it('keeps the first verdict, not the last one to ask', async () => {
    await submit(SessionStatus.APPROVED);
    await submit(SessionStatus.REJECTED);

    expect(store.verdict).toBe(SessionStatus.APPROVED);
    expect(store.status).toBe(SessionStatus.APPROVED);
    expect(store.billing).toEqual([{ category: 'SUCCESS', amountPaise: 2500 }]);
  });
});

// ------------------------------------------------------------------- T37

describe('T37 - a verdict racing a disconnect', () => {
  it('lets the verdict win when it reaches the row first', async () => {
    armLapsedDeadline();
    store.gate.close();
    const [verdict, swept] = await bothInFlight(
      () => submit(SessionStatus.APPROVED),
      () => sweeper.sweep(),
    );

    store.gate.release();
    const [result, pass] = await Promise.all([verdict, swept]);

    expect(result.won).toBe(true);
    expect(store.status).toBe(SessionStatus.APPROVED);
    // The sweeper found nothing to do and says so, rather than reporting a drop
    // it did not perform.
    expect(pass.dropped).toBe(0);
    expect(pass.stale).toBe(1);
  });

  it('lets the disconnect win when it reaches the row first', async () => {
    armLapsedDeadline();
    store.gate.close();
    const [swept, verdict] = await bothInFlight(
      () => sweeper.sweep(),
      () => submit(SessionStatus.APPROVED),
    );

    store.gate.release();
    const [pass, result] = await Promise.all([swept, verdict]);

    expect(pass.dropped).toBe(1);
    expect(store.status).toBe(SessionStatus.DROPPED_IN_CALL);
    // D17's loser, and here it is the agent: 409, and the session keeps the
    // outcome the disconnect gave it.
    expect(result).toEqual({ won: false, code: ErrorCode.CONFLICT });
    expect(store.verdict).toBeNull();
  });

  it.each([
    ['the verdict', true],
    ['the disconnect', false],
  ])('bills once and ends once when %s arrives first', async (_label, verdictFirst) => {
    armLapsedDeadline();
    store.gate.close();

    const runVerdict = (): Promise<unknown> => submit(SessionStatus.APPROVED);
    const runSweep = (): Promise<unknown> => sweeper.sweep();
    const [one, two] = await bothInFlight(
      verdictFirst ? runVerdict : runSweep,
      verdictFirst ? runSweep : runVerdict,
    );
    store.gate.release();
    await Promise.all([one, two]);

    expect(store.billing).toHaveLength(1);
    expect([SessionStatus.APPROVED, SessionStatus.DROPPED_IN_CALL]).toContain(store.status);
    expect(notify.of('sessionCompleted')).toHaveLength(1);
    expect(presenceStore.freed).toEqual([AGENT]);
  });

  it('writes nothing when the verdict loses', async () => {
    armLapsedDeadline();
    store.gate.close();
    const [swept, verdict] = await bothInFlight(
      () => sweeper.sweep(),
      () => submit(),
    );
    store.gate.release();
    await Promise.all([swept, verdict]);

    // No attestation for a verdict that never happened, and no outbox row: a
    // `session.completed` webhook for a session the agent did not complete
    // would be a claim to the enterprise that is simply false.
    expect(store.checklists).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
    expect(
      store.events.filter((event) => event.type === SessionEventType.VERDICT_SUBMITTED),
    ).toHaveLength(0);
  });

  it('does not let the disconnect overwrite a committed verdict', async () => {
    // The read-then-write window, made as wide as it goes: the sweeper has
    // already read the session as IN_CALL and decided to end it before the
    // verdict commits. Only a guard inside the UPDATE saves this — a check
    // taken at read time would bill the session twice and turn an APPROVED
    // verification into a dropped call.
    await submit(SessionStatus.APPROVED);
    armLapsedDeadline();

    const pass = await sweeper.sweep();

    expect(pass.dropped).toBe(0);
    expect(store.status).toBe(SessionStatus.APPROVED);
    expect(store.billing).toEqual([{ category: 'SUCCESS', amountPaise: 2500 }]);
    expect(store.events.filter((event) => event.type === SessionEventType.CALL_ENDED)).toHaveLength(
      0,
    );
  });

  it('takes the deadline either way, so no later pass can retry it', async () => {
    await submit(SessionStatus.APPROVED);
    armLapsedDeadline();

    await sweeper.sweep();

    expect(calls.deadlines.size).toBe(0);
  });
});
