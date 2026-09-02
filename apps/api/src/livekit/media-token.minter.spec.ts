/**
 * What the minted credential actually says.
 *
 * Every assertion here decodes the JWT rather than inspecting the object that
 * built it. A grant is only worth what the SFU reads out of the token, so a
 * test that checked the input would pass while the output was wrong.
 */

import { TokenVerifier } from 'livekit-server-sdk';
import type { ClaimGrants, VideoGrant } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import type { LiveKitConfig } from './livekit.config.js';
import type { MediaParticipantMetadata } from './media-token.minter.js';
import { LiveKitTokenMinter, grantsFor } from './media-token.minter.js';
import { MediaRole } from './media-token.rules.js';
import { isCallRole } from './call.keys.js';

const API_KEY = 'devkey';
const API_SECRET = 'FAKE-livekit-secret-for-tests-0123456789';

const CONFIG: LiveKitConfig = {
  url: 'ws://localhost:7880',
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  tokenTtlSeconds: 900,
};

const SESSION = '11111111-1111-4111-8111-111111111111';
const TENANT = '00000000-0000-4000-8000-00000000000a';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const ROOM = `vcip_${SESSION}`;

const minter = new LiveKitTokenMinter(CONFIG);
const verifier = new TokenVerifier(API_KEY, API_SECRET);

const mintCustomer = (): Promise<string> =>
  minter.mint({
    role: MediaRole.CUSTOMER,
    roomName: ROOM,
    sessionId: SESSION,
    tenantId: TENANT,
    userId: null,
    ttlSeconds: 900,
  });

const mintAgent = (): Promise<string> =>
  minter.mint({
    role: MediaRole.AGENT,
    roomName: ROOM,
    sessionId: SESSION,
    tenantId: TENANT,
    userId: AGENT,
    ttlSeconds: 900,
  });

const mintAnalyzer = (): Promise<string> =>
  minter.mint({
    role: MediaRole.ANALYZER,
    roomName: ROOM,
    sessionId: SESSION,
    tenantId: TENANT,
    userId: null,
    ttlSeconds: 900,
  });

const video = (claims: ClaimGrants): VideoGrant => {
  expect(claims.video).toBeDefined();
  return claims.video as VideoGrant;
};

describe('the minted token', () => {
  it('verifies against the configured key pair', async () => {
    await expect(verifier.verify(await mintCustomer())).resolves.toBeDefined();
  });

  it('does not verify against a different secret', async () => {
    const wrong = new TokenVerifier(API_KEY, 'FAKE-different-secret-for-tests-9876543210');
    await expect(wrong.verify(await mintCustomer())).rejects.toThrow();
  });

  it('is bound to the one room', async () => {
    expect(video(await verifier.verify(await mintCustomer())).room).toBe(ROOM);
    expect(video(await verifier.verify(await mintAgent())).room).toBe(ROOM);
  });

  it('identifies the participant by role, as design §11.2 names them', async () => {
    expect((await verifier.verify(await mintCustomer())).sub).toBe('customer');
    expect((await verifier.verify(await mintAgent())).sub).toBe('agent');
  });

  it('expires at the requested TTL', async () => {
    const claims = await verifier.verify(await mintCustomer());
    const lifetime = (claims.exp as number) - (claims.nbf as number);
    expect(lifetime).toBe(900);
  });
});

describe('the grants', () => {
  it('lets both roles publish and subscribe', async () => {
    for (const token of [await mintCustomer(), await mintAgent()]) {
      const grant = video(await verifier.verify(token));
      expect(grant.roomJoin).toBe(true);
      expect(grant.canPublish).toBe(true);
      expect(grant.canSubscribe).toBe(true);
    }
  });

  /**
   * The denials are the point of the task, so they are asserted on the decoded
   * token for both roles rather than on the object literal.
   */
  it('denies every control-plane and side-channel scope', async () => {
    const denied = [
      'roomCreate',
      'roomAdmin',
      'roomList',
      'roomRecord',
      'recorder',
      'ingressAdmin',
      'canPublishData',
      'canUpdateOwnMetadata',
      'hidden',
      'agent',
      'canSubscribeMetrics',
    ] as const;

    for (const token of [await mintCustomer(), await mintAgent()]) {
      const grant = video(await verifier.verify(token));
      for (const scope of denied) {
        expect(grant[scope] ?? false).toBe(false);
      }
    }
  });

  /**
   * `canPublishData` defaults to true in LiveKit when omitted, so this asserts
   * a value that is genuinely load-bearing rather than a redundant `false`.
   */
  it('states canPublishData explicitly rather than inheriting the permissive default', () => {
    expect(Object.hasOwn(grantsFor(MediaRole.CUSTOMER, ROOM), 'canPublishData')).toBe(true);
    expect(grantsFor(MediaRole.CUSTOMER, ROOM).canPublishData).toBe(false);
  });

  it('never issues a grant without a room, which would be a key to every room', () => {
    for (const role of [MediaRole.CUSTOMER, MediaRole.AGENT, MediaRole.ANALYZER]) {
      expect(grantsFor(role, ROOM).room).toBe(ROOM);
    }
  });
});

/**
 * The analyzer's credential (T30).
 *
 * Held by a service that watches a customer's identity verification, so what
 * it cannot do matters more than what it can. Every assertion decodes the
 * token: what the SFU enforces is what is in the JWT, not what the object that
 * built it looked like.
 */
describe('the analyzer credential', () => {
  it('can subscribe', async () => {
    const grant = video(await verifier.verify(await mintAnalyzer()));

    expect(grant.canSubscribe).toBe(true);
    expect(grant.roomJoin).toBe(true);
  });

  it('cannot publish', async () => {
    // A token that could publish into a KYC call could impersonate the
    // customer in the recording that is the evidence of it.
    const grant = video(await verifier.verify(await mintAnalyzer()));

    expect(grant.canPublish).toBe(false);
    expect(grant.canPublishData ?? false).toBe(false);
  });

  it('is hidden, so it is not a participant anyone sees or records', async () => {
    // Three things ride on this: the customer is not shown a silent third
    // party, T28's grid composite records two people and not three, and T26's
    // participant bookkeeping cannot mistake it for one of them.
    const grant = video(await verifier.verify(await mintAnalyzer()));

    expect(grant.hidden).toBe(true);
  });

  it('is bound to one room', async () => {
    const grant = video(await verifier.verify(await mintAnalyzer()));

    expect(grant.room).toBe(ROOM);
    expect(grant.roomList ?? false).toBe(false);
  });

  it('denies every control-plane scope, as the other two do', async () => {
    const grant = video(await verifier.verify(await mintAnalyzer()));

    for (const scope of [
      'roomCreate',
      'roomAdmin',
      'roomList',
      'roomRecord',
      'recorder',
      'ingressAdmin',
      'canUpdateOwnMetadata',
      'agent',
      'canSubscribeMetrics',
    ] as const) {
      expect(grant[scope] ?? false).toBe(false);
    }
  });

  it('joins under an identity T26 does not treat as a participant', async () => {
    // `isCallRole` knows `customer` and `agent`. The analyzer arriving must
    // not read as the call starting, and its leaving must not read as a drop.
    const claims = await verifier.verify(await mintAnalyzer());

    expect(claims.sub).toBe('analyzer');
    expect(isCallRole(claims.sub as string)).toBe(false);
  });

  it('carries no user id, because it is not a person', async () => {
    const claims = await verifier.verify(await mintAnalyzer());
    const metadata = JSON.parse(claims.metadata as string) as MediaParticipantMetadata;

    expect(metadata).toEqual({
      role: MediaRole.ANALYZER,
      session_id: SESSION,
      tenant_id: TENANT,
      user_id: null,
    });
  });
});

describe('the participant metadata T26 will read', () => {
  it('names the session, tenant, and role for the customer', async () => {
    const claims = await verifier.verify(await mintCustomer());
    const metadata = JSON.parse(claims.metadata as string) as MediaParticipantMetadata;
    expect(metadata).toEqual({
      role: MediaRole.CUSTOMER,
      session_id: SESSION,
      tenant_id: TENANT,
      user_id: null,
    });
  });

  it('carries the agent’s user id, so T26 need not query by room name', async () => {
    const claims = await verifier.verify(await mintAgent());
    const metadata = JSON.parse(claims.metadata as string) as MediaParticipantMetadata;
    expect(metadata).toEqual({
      role: MediaRole.AGENT,
      session_id: SESSION,
      tenant_id: TENANT,
      user_id: AGENT,
    });
  });

  it('holds nothing about the customer beyond the identifiers', async () => {
    const claims = await verifier.verify(await mintCustomer());
    expect(Object.keys(JSON.parse(claims.metadata as string) as object).sort()).toEqual([
      'role',
      'session_id',
      'tenant_id',
      'user_id',
    ]);
  });
});
