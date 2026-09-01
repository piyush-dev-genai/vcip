/**
 * Minting room credentials, behind an interface (T24).
 *
 * The seam exists for the reason `GeoProvider`'s does: the service above it
 * decides *whether* a caller may hold credentials, and that decision is worth
 * testing without a signing key, an SDK, or a running SFU. It also gives T28's
 * egress token and T30's analyzer token one place to be added rather than three
 * places that each build a grant by hand.
 *
 * Everything this file puts in a token is server-derived. The room comes from
 * the session row, the identity from the role, the metadata from the session
 * and the verified credential. No field of any request reaches a grant.
 */

import { Inject, Injectable } from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';
import type { VideoGrant } from 'livekit-server-sdk';
import type { LiveKitConfig } from './livekit.config.js';
import { InjectLiveKitConfig } from './livekit.config.js';
import type { MediaRole } from './media-token.rules.js';

/** What the caller asks to be minted. All of it server-derived. */
export interface MediaTokenGrantRequest {
  readonly role: MediaRole;
  readonly roomName: string;
  readonly sessionId: string;
  readonly tenantId: string;
  /** The agent's user id, or null for a customer. */
  readonly userId: string | null;
  /** Seconds the credential may be used to join. */
  readonly ttlSeconds: number;
}

export interface MediaTokenMinter {
  /** A signed, room-scoped, role-scoped join credential. */
  mint(request: MediaTokenGrantRequest): Promise<string>;
}

export const MEDIA_TOKEN_MINTER = Symbol('MEDIA_TOKEN_MINTER');

export const InjectMediaTokenMinter = (): ParameterDecorator => Inject(MEDIA_TOKEN_MINTER);

/**
 * Participant metadata, for the LiveKit webhook (T26).
 *
 * T26 receives participant lifecycle events carrying an identity and this
 * blob, and has to answer "which session, and was that the agent?" without
 * trusting anything a client said. Both facts are written here, by the server,
 * at mint time, from a verified credential — so T26 reads them rather than
 * parsing an identity string or querying by room name.
 *
 * Snake case, matching every other JSON surface in this API. No customer data:
 * the metadata is visible to every participant in the room.
 */
export interface MediaParticipantMetadata {
  readonly role: MediaRole;
  readonly session_id: string;
  readonly tenant_id: string;
  /** The agent's user id, or null for a customer. */
  readonly user_id: string | null;
}

/**
 * The grants each role gets (design §11.3).
 *
 * Every field is stated, including the ones set to `false`. LiveKit defaults
 * several of these to permissive when omitted — `canPublishData` is true unless
 * told otherwise — so an omission here is not "no opinion", it is "yes". The
 * defaults are also free to change under us. Writing the full set means the
 * grant a reviewer reads is the grant the SFU enforces.
 *
 * `canSubscribe: true` is broader than design §11.3, which says the customer
 * may subscribe to the agent and the agent to the customer. LiveKit's grants
 * have no per-participant subscribe scope — `canSubscribe` is all or nothing —
 * so that restriction is not expressible here. It is equivalent in practice:
 * the room holds exactly two publishers, and T30's analyzer publishes nothing.
 * Should a third publisher ever join a room, this comment is the thing that
 * stopped being true.
 */
export function grantsFor(role: MediaRole, roomName: string): VideoGrant {
  return {
    // Join this room, and only this room. `room` is what binds the credential
    // to one session; without it a join grant is a key to every room.
    roomJoin: true,
    room: roomName,

    // Both roles publish camera and microphone, and subscribe to each other.
    canPublish: true,
    canSubscribe: true,

    // Everything below is denied on purpose.
    //
    // `roomCreate`/`roomAdmin`/`roomList` are control-plane powers: a
    // participant holding them could mint rooms, evict the other party, or
    // enumerate every session in the deployment. `ingressAdmin` is the same
    // for ingress. `roomRecord` and `recorder` belong to T28's egress worker,
    // which will hold its own credential — a customer must not be able to
    // start or stop the recording that is the evidence of their own KYC call.
    roomCreate: false,
    roomAdmin: false,
    roomList: false,
    roomRecord: false,
    recorder: false,
    ingressAdmin: false,

    // The data channel is not part of this product's design. Real-time
    // messaging between the parties goes over T27's WebSocket, where it is
    // authenticated, tenant-scoped, and auditable; a LiveKit data channel
    // would be an unlogged side channel into a regulated conversation.
    canPublishData: false,

    // The metadata below is the server's statement about who this participant
    // is, and T26 reads it to decide what happened on a call. A participant
    // who could rewrite it could rewrite the audit trail.
    canUpdateOwnMetadata: false,

    // Neither party is invisible: each must see the other join and leave.
    hidden: false,

    // The agent framework and metrics scopes are unused by this product.
    agent: false,
    canSubscribeMetrics: false,
  };
}

@Injectable()
export class LiveKitTokenMinter implements MediaTokenMinter {
  constructor(@InjectLiveKitConfig() private readonly config: LiveKitConfig) {}

  async mint(request: MediaTokenGrantRequest): Promise<string> {
    const metadata: MediaParticipantMetadata = {
      role: request.role,
      session_id: request.sessionId,
      tenant_id: request.tenantId,
      user_id: request.userId,
    };

    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      // The role is the identity (design §11.2). One session is one room, so
      // it is unique within it, and a rejoin after a dropped connection lands
      // as the same participant rather than a second ghost.
      identity: request.role,
      ttl: request.ttlSeconds,
      metadata: JSON.stringify(metadata),
    });

    token.addGrant(grantsFor(request.role, request.roomName));

    // Async since SDK v2: the JWT is signed through WebCrypto.
    return token.toJwt();
  }
}
