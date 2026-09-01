/**
 * Screen routing.
 *
 * The one place the customer app decides anything about navigation, and it
 * decides it from server state alone. These tests are what stop a second state
 * machine growing here by accident.
 */

import { describe, expect, it } from 'vitest';
import { SessionStatus } from '@vcip/shared';
import type { SessionView } from './session';
import { Screen, canAbort, gatesOf, screenFor } from './screen';

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

  it('shows the status screen for every other terminal status', () => {
    for (const status of [
      SessionStatus.APPROVED,
      SessionStatus.REJECTED,
      SessionStatus.ABORTED,
      SessionStatus.DROPPED_QUEUED,
      SessionStatus.DROPPED_IN_CALL,
    ]) {
      expect(screenFor(view({ status }))).toBe(Screen.SESSION_STATE);
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
