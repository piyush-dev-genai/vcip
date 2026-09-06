/**
 * Screen routing.
 *
 * The one place the customer app decides anything about navigation, and it
 * decides it from server state alone. These tests are what stop a second state
 * machine growing here by accident.
 */

import { describe, expect, it } from 'vitest';
import { SESSION_STATUSES, SessionStatus } from '@vcip/shared';
import type { SessionView } from './session';
import {
  Screen,
  canAbort,
  canJoinQueue,
  gatesOf,
  outcomeMessage,
  outcomeOf,
  screenFor,
} from './screen';

const view = (overrides: Partial<SessionView> = {}): SessionView => ({
  session_id: '22222222-2222-4222-8222-222222222222',
  status: SessionStatus.CREATED,
  language: 'en',
  room_name: 'vcip_22222222-2222-4222-8222-222222222222',
  consent_ok: false,
  preflight_ok: false,
  geo_ok: false,
  queue_position: null,
  agent_connected: false,
  queued_at: null,
  connected_at: null,
  ended_at: null,
  verdict: null,
  export_status: 'NOT_STARTED',
  ...overrides,
});

describe('screenFor', () => {
  it('starts at consent', () => {
    expect(screenFor(view())).toBe(Screen.CONSENT);
  });

  it('moves to preflight once consent is recorded as accepted', () => {
    expect(screenFor(view({ consent_ok: true }))).toBe(Screen.PREFLIGHT);
  });

  it('moves to location once preflight has passed', () => {
    expect(screenFor(view({ consent_ok: true, preflight_ok: true }))).toBe(Screen.LOCATION);
  });

  it('reaches ready-for-queue when all three gates have passed', () => {
    expect(screenFor(view({ consent_ok: true, preflight_ok: true, geo_ok: true }))).toBe(
      Screen.READY_FOR_QUEUE,
    );
  });

  it('shows the failure screen for PREFLIGHT_FAILED, whichever gate caused it', () => {
    // A failed location check terminates at the same status as a failed device
    // check, and both must be unable to continue.
    expect(screenFor(view({ status: SessionStatus.PREFLIGHT_FAILED, consent_ok: true }))).toBe(
      Screen.CHECKS_FAILED,
    );
    expect(
      screenFor(
        view({ status: SessionStatus.PREFLIGHT_FAILED, consent_ok: true, preflight_ok: true }),
      ),
    ).toBe(Screen.CHECKS_FAILED);
  });

  it('never routes a PREFLIGHT_FAILED session forward, whatever its flags say', () => {
    // The status is terminal (I11). Even a row whose gate flags all read true
    // must not be offered a next step.
    expect(
      screenFor(
        view({
          status: SessionStatus.PREFLIGHT_FAILED,
          consent_ok: true,
          preflight_ok: true,
          geo_ok: true,
        }),
      ),
    ).toBe(Screen.CHECKS_FAILED);
  });

  it('shows the status screen while the customer is waiting', () => {
    // Queued or offered to an agent: the customer waits, and the status screen
    // is where they wait. Unreachable from the T14 flow, but a stale tab can
    // see it.
    for (const status of [SessionStatus.QUEUED, SessionStatus.OFFERED]) {
      expect(screenFor(view({ status, consent_ok: true, preflight_ok: true, geo_ok: true }))).toBe(
        Screen.SESSION_STATE,
      );
    }
  });

  /**
   * T25. An agent accepted, so both parties belong in the room — and the call
   * gets its own screen rather than a branch of the status view, because it is
   * the only screen that holds a camera and leaving it has to tear that down.
   */
  it('shows the call screen once an agent has accepted', () => {
    expect(
      screenFor(
        view({
          status: SessionStatus.IN_CALL,
          consent_ok: true,
          preflight_ok: true,
          geo_ok: true,
        }),
      ),
    ).toBe(Screen.CALL);
  });

  it('leaves the call screen the moment the session is no longer IN_CALL', () => {
    // The status poll is what notices. A verdict (T35) or a drop (T26) ends the
    // call from the other side, and the screen must not outlive it.
    for (const status of [
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_IN_CALL,
    ]) {
      expect(
        screenFor(view({ status, consent_ok: true, preflight_ok: true, geo_ok: true })),
      ).not.toBe(Screen.CALL);
    }
  });

  it('shows the finished screen for every other terminal status', () => {
    // Not the status screen. That screen exists to say how far along a
    // verification is and what the customer may do next, and a finished one
    // has no next — it offered a live Join Queue button to sessions that were
    // already approved.
    for (const status of [
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
    ]) {
      expect(screenFor(view({ status }))).toBe(Screen.FINISHED);
    }
  });

  it('is a pure function of the view, with no hidden state between calls', () => {
    const first = view({ consent_ok: true });
    expect(screenFor(first)).toBe(screenFor(first));
    expect(screenFor(view())).toBe(Screen.CONSENT);
  });

  it('never routes to a queue screen, because T14 has none', () => {
    const screens = new Set(
      Object.values(SessionStatus).map((status) =>
        screenFor(view({ status, consent_ok: true, preflight_ok: true, geo_ok: true })),
      ),
    );
    expect(screens.has('queue' as Screen)).toBe(false);
  });
});

describe('canAbort', () => {
  it('permits abort exactly where T12 does', () => {
    expect(canAbort(view({ status: SessionStatus.QUEUED }))).toBe(true);
    expect(canAbort(view({ status: SessionStatus.OFFERED }))).toBe(true);
    expect(canAbort(view({ status: SessionStatus.IN_CALL }))).toBe(true);
  });

  it('refuses on CREATED, which is where the whole T14 flow lives', () => {
    // A session that never queued stays CREATED and unbilled (D19); T12
    // answers an abort from CREATED with a 409. Offering the button would be
    // offering a request the server will refuse.
    expect(canAbort(view({ status: SessionStatus.CREATED }))).toBe(false);
    expect(
      canAbort(
        view({ status: SessionStatus.CREATED, consent_ok: true, preflight_ok: true, geo_ok: true }),
      ),
    ).toBe(false);
  });

  it('refuses on every terminal status', () => {
    for (const status of [
      SessionStatus.PREFLIGHT_FAILED,
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
    ]) {
      expect(canAbort(view({ status }))).toBe(false);
    }
  });
});

describe('gatesOf', () => {
  it('reports the three gates from the server flags', () => {
    expect(gatesOf(view({ consent_ok: true, preflight_ok: true }))).toEqual({
      consent: true,
      preflight: true,
      location: false,
    });
  });
});

describe('canJoinQueue', () => {
  const passedGates = { consent_ok: true, preflight_ok: true, geo_ok: true };

  it('offers the queue once all three gates pass and nothing has happened yet', () => {
    expect(canJoinQueue(view({ status: SessionStatus.CREATED, ...passedGates }))).toBe(true);
  });

  it.each([
    ['consent', { ...passedGates, consent_ok: false }],
    ['preflight', { ...passedGates, preflight_ok: false }],
    ['location', { ...passedGates, geo_ok: false }],
  ])('refuses while %s is outstanding', (_gate, gates) => {
    expect(canJoinQueue(view({ status: SessionStatus.CREATED, ...gates }))).toBe(false);
  });

  it('refuses a session already in the queue', () => {
    expect(canJoinQueue(view({ status: SessionStatus.QUEUED, ...passedGates }))).toBe(false);
  });

  it.each([
    SessionStatus.APPROVED,
    SessionStatus.REJECTED,
    SessionStatus.ABORTED,
    SessionStatus.DROPPED_QUEUED,
    SessionStatus.DROPPED_IN_CALL,
    SessionStatus.PREFLIGHT_FAILED,
  ])('refuses a session that has already finished as %s', (status) => {
    // The reported bug. A finished verification has passed its gates and is
    // certainly not queued, so a rule of "gates passed and not queued" — which
    // is what the status screen used to compute for itself — said yes to every
    // one of these and offered a live "Join Queue" button on a session the
    // server would refuse with a 409.
    expect(canJoinQueue(view({ status, ...passedGates }))).toBe(false);
  });

  it.each([SessionStatus.OFFERED, SessionStatus.IN_CALL])(
    'refuses a session already being worked (%s)',
    (status) => {
      expect(canJoinQueue(view({ status, ...passedGates }))).toBe(false);
    },
  );

  it('agrees with the screen the session routes to, by construction', () => {
    // The two cannot drift, because the predicate *is* the routing decision.
    for (const status of SESSION_STATUSES) {
      const session = view({ status, ...passedGates });
      expect(canJoinQueue(session)).toBe(screenFor(session) === Screen.READY_FOR_QUEUE);
    }
  });

  it('is never true at the same time as canAbort', () => {
    // Joining and stopping are mutually exclusive: one is pre-queue, the other
    // needs the session to have left it.
    for (const status of SESSION_STATUSES) {
      const session = view({ status, ...passedGates });
      expect(canJoinQueue(session) && canAbort(session)).toBe(false);
    }
  });
});

describe('outcomeMessage', () => {
  it('says something a customer can read for every terminal outcome', () => {
    for (const status of [
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
    ]) {
      const message = outcomeMessage(view({ status }));
      expect(message).not.toBeNull();
      // Not the status code. `DROPPED_IN_CALL` means nothing to the person it
      // happened to.
      expect(message).not.toContain(status);
    }
  });

  it('distinguishes an approval from a rejection', () => {
    expect(outcomeMessage(view({ status: SessionStatus.APPROVED }))).not.toBe(
      outcomeMessage(view({ status: SessionStatus.REJECTED })),
    );
  });

  it('says nothing about a verification still running', () => {
    for (const status of [
      SessionStatus.CREATED,
      SessionStatus.QUEUED,
      SessionStatus.OFFERED,
      SessionStatus.IN_CALL,
    ]) {
      expect(outcomeMessage(view({ status }))).toBeNull();
    }
  });

  it('leaves PREFLIGHT_FAILED to its own screen', () => {
    expect(outcomeMessage(view({ status: SessionStatus.PREFLIGHT_FAILED }))).toBeNull();
  });
});

describe('outcomeOf', () => {
  it('describes every terminal outcome the customer can reach', () => {
    for (const status of [
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
    ]) {
      const outcome = outcomeOf(view({ status }));
      expect(outcome).not.toBeNull();
      // Every field is words, never the server's vocabulary.
      expect(outcome?.headline).not.toContain(status);
      expect(outcome?.detail).not.toContain(status);
      expect(outcome?.next).not.toContain(status);
    }
  });

  it('gives approval, rejection, and a stop three different tones', () => {
    expect(outcomeOf(view({ status: SessionStatus.APPROVED }))?.tone).toBe('approved');
    expect(outcomeOf(view({ status: SessionStatus.REJECTED }))?.tone).toBe('rejected');
    expect(outcomeOf(view({ status: SessionStatus.ABORTED }))?.tone).toBe('stopped');
  });

  it('treats a stop and a dropped connection as the same outcome', () => {
    // They differ in why, which matters to billing and to support. They do not
    // differ in what the customer does next, and the screen says what to do.
    const stopped = [
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
    ].map((status) => outcomeOf(view({ status })));

    for (const outcome of stopped) expect(outcome?.tone).toBe('stopped');
    // The sentence still distinguishes a deliberate stop from a lost link.
    expect(stopped[0]?.detail).not.toBe(stopped[1]?.detail);
  });

  it('reuses outcomeMessage rather than wording the outcome twice', () => {
    for (const status of [SessionStatus.APPROVED, SessionStatus.REJECTED, SessionStatus.ABORTED]) {
      const session = view({ status });
      expect(outcomeOf(session)?.detail).toBe(outcomeMessage(session));
    }
  });

  it('says nothing about a verification still running', () => {
    for (const status of [
      SessionStatus.CREATED,
      SessionStatus.QUEUED,
      SessionStatus.OFFERED,
      SessionStatus.IN_CALL,
    ]) {
      expect(outcomeOf(view({ status }))).toBeNull();
    }
  });

  it('leaves PREFLIGHT_FAILED to the screen that names the failed check', () => {
    expect(outcomeOf(view({ status: SessionStatus.PREFLIGHT_FAILED }))).toBeNull();
  });
});
