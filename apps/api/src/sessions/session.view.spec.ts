import { describe, expect, it } from 'vitest';
import { SessionStatus } from '@vcip/shared';
import type { SessionRow } from './session.repository.js';
import { SESSION_VIEW_KEYS, toSessionView } from './session.view.js';

/**
 * A row with every column populated, including the ones that must not be
 * returned. Sentinel values are distinctive so a leak test can look for them.
 */
const ROW: SessionRow = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'TENANT-SENTINEL-0001',
  externalRef: 'EXTREF-SENTINEL-loan-99',
  status: SessionStatus.QUEUED,
  version: 7,
  language: 'en',
  roomName: 'vcip_11111111-1111-4111-8111-111111111111',
  checklistTemplateId: 'CHECKLIST-SENTINEL-0001',
  consentOk: true,
  consentVersion: 'v3',
  consentAt: new Date('2026-08-27T10:00:00.000Z'),
  preflightOk: true,
  preflightAt: new Date('2026-08-27T10:01:00.000Z'),
  geoOk: true,
  gpsAccuracyM: 42,
  geoCheckedAt: new Date('2026-08-27T10:02:00.000Z'),
  ipCountry: 'IN',
  queuedAt: new Date('2026-08-27T10:03:00.000Z'),
  connectedAt: null,
  endedAt: null,
  verdict: null,
  exportStatus: 'NOT_STARTED',
  createdAt: new Date('2026-08-27T09:59:00.000Z'),
  updatedAt: new Date('2026-08-27T10:03:00.000Z'),
};

describe('projection', () => {
  it('returns exactly the declared key set', () => {
    expect(Object.keys(toSessionView(ROW)).sort()).toEqual([...SESSION_VIEW_KEYS].sort());
  });

  it('reports the PostgreSQL state', () => {
    const view = toSessionView(ROW);
    expect(view.session_id).toBe(ROW.id);
    expect(view.status).toBe('QUEUED');
    expect(view.language).toBe('en');
    expect(view.room_name).toBe(ROW.roomName);
    expect(view.consent_ok).toBe(true);
    expect(view.preflight_ok).toBe(true);
    expect(view.geo_ok).toBe(true);
    expect(view.export_status).toBe('NOT_STARTED');
    expect(view.verdict).toBeNull();
  });

  it('serialises timestamps as ISO strings and nulls as null', () => {
    const view = toSessionView(ROW);
    expect(view.queued_at).toBe('2026-08-27T10:03:00.000Z');
    expect(view.connected_at).toBeNull();
    expect(view.ended_at).toBeNull();
  });

  it('leaves queue_position null until T15 exists', () => {
    // Null means "not available", never "position zero". Redis is not consulted
    // here, and PostgreSQL does not hold a position.
    expect(toSessionView(ROW).queue_position).toBeNull();
  });

  it('derives agent_connected from the call timestamps', () => {
    expect(toSessionView(ROW).agent_connected).toBe(false);
    expect(
      toSessionView({ ...ROW, connectedAt: new Date('2026-08-27T10:05:00.000Z') }).agent_connected,
    ).toBe(true);
    expect(
      toSessionView({
        ...ROW,
        connectedAt: new Date('2026-08-27T10:05:00.000Z'),
        endedAt: new Date('2026-08-27T10:25:00.000Z'),
      }).agent_connected,
    ).toBe(false);
  });
});

describe('nothing sensitive leaves in the view', () => {
  const serialised = JSON.stringify(toSessionView(ROW));

  it('omits raw location detail', () => {
    // Coordinates have no column at all; accuracy and country do, and are still
    // not echoed back to the client.
    expect(serialised).not.toContain('42');
    expect(serialised).not.toContain('"IN"');
    expect(serialised).not.toContain('gps');
    expect(serialised).not.toContain('ip_country');
  });

  it('omits the tenant id and the enterprise reference', () => {
    expect(serialised).not.toContain('TENANT-SENTINEL-0001');
    expect(serialised).not.toContain('EXTREF-SENTINEL-loan-99');
  });

  it('omits internal identifiers and the row version', () => {
    expect(serialised).not.toContain('CHECKLIST-SENTINEL-0001');
    expect(serialised).not.toContain('version');
  });

  it("omits billing fields, which are not the customer's business", () => {
    expect(serialised).not.toContain('bill');
  });

  it('never carries a credential', () => {
    for (const marker of ['token', 'Bearer', 'secret', 'authorization', 'key_hash']) {
      expect(serialised.toLowerCase()).not.toContain(marker.toLowerCase());
    }
  });

  it('fails closed: a new column is invisible until it is named in the view', () => {
    const withNewColumn = { ...ROW, someFutureSecret: 'FUTURE-SENTINEL' } as SessionRow;
    expect(JSON.stringify(toSessionView(withNewColumn))).not.toContain('FUTURE-SENTINEL');
  });
});
