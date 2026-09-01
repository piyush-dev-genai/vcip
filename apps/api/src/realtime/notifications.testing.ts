/**
 * A `Notifications` double for tests.
 *
 * Excluded from the build (`tsconfig.build.json`), like `test-setup.ts`: this
 * must never reach a running server, where silently dropping every
 * notification would look exactly like a working transport.
 *
 * It records rather than no-ops. Nine services now publish, and a test that
 * merely tolerated the call would not notice a producer publishing the wrong
 * event, to the wrong audience, or twice — which is the failure this whole
 * layer is prone to. `sent` is the assertion surface.
 */

import { Global, Module } from '@nestjs/common';
import type { SessionStatus } from '@vcip/shared';
import type { Notifications } from './notifications.js';
import { NOTIFICATIONS } from './notifications.js';

export interface SentNotification {
  readonly kind: string;
  readonly args: readonly unknown[];
}

export class RecordingNotifications implements Notifications {
  readonly sent: SentNotification[] = [];

  private record(kind: string, ...args: readonly unknown[]): Promise<void> {
    this.sent.push({ kind, args });
    return Promise.resolve();
  }

  /** Every notification of one kind, for a focused assertion. */
  of(kind: string): readonly SentNotification[] {
    return this.sent.filter((entry) => entry.kind === kind);
  }

  kinds(): readonly string[] {
    return this.sent.map((entry) => entry.kind);
  }

  clear(): void {
    this.sent.length = 0;
  }

  queuePosition(sessionId: string, position: number | null): Promise<void> {
    return this.record('queuePosition', sessionId, position);
  }
  queueNewSession(tenantId: string, language: string, sessionId: string): Promise<void> {
    return this.record('queueNewSession', tenantId, language, sessionId);
  }
  sessionOffered(sessionId: string): Promise<void> {
    return this.record('sessionOffered', sessionId);
  }
  sessionClaimedElsewhere(tenantId: string, userId: string, sessionId: string): Promise<void> {
    return this.record('sessionClaimedElsewhere', tenantId, userId, sessionId);
  }
  sessionOfferExpired(tenantId: string, userId: string, sessionId: string): Promise<void> {
    return this.record('sessionOfferExpired', tenantId, userId, sessionId);
  }
  sessionAssigned(sessionId: string, tenantId: string, userId: string): Promise<void> {
    return this.record('sessionAssigned', sessionId, tenantId, userId);
  }
  agentJoined(sessionId: string): Promise<void> {
    return this.record('agentJoined', sessionId);
  }
  sessionUpdated(sessionId: string, status: SessionStatus): Promise<void> {
    return this.record('sessionUpdated', sessionId, status);
  }
  sessionCompleted(
    sessionId: string,
    status: SessionStatus,
    verdict: string | null,
    agent: { readonly tenantId: string; readonly userId: string } | null,
  ): Promise<void> {
    return this.record('sessionCompleted', sessionId, status, verdict, agent);
  }
}

/**
 * Supplies `NOTIFICATIONS` to a spec that imports a real business module.
 *
 * `@Global`, mirroring `RealtimeModule`: the application provides this token
 * globally precisely so business modules need not import a transport, and a
 * test that imported `SessionsModule` in isolation would otherwise fail to
 * resolve a dependency the running server resolves fine.
 */
@Global()
@Module({
  providers: [{ provide: NOTIFICATIONS, useClass: RecordingNotifications }],
  exports: [NOTIFICATIONS],
})
export class NotificationsTestingModule {}
