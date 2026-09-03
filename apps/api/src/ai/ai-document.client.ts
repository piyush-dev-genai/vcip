/**
 * Asking the AI service to read a document, behind a port.
 *
 * The sibling of `AnalysisStarter`, and split from it for the reason a port
 * exists at all: what happens when the AI service cannot be reached is worth
 * testing without a Python process, and there should be exactly one place that
 * knows how it is addressed.
 *
 * D10 outbound: the shared internal credential goes out, the same one
 * `InternalTokenGuard` requires coming back.
 *
 * **Note what does not travel.** The request is a session id and a document
 * type. No image goes over this hop, because the frames are already on the
 * other side of it (D23) — and no document contents come back, because the
 * result arrives separately on `/internal/ai/document-result` carrying a status.
 * This client could not leak a document if it wanted to: there is no field.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { DocumentReadRequest, DocumentType } from '@vcip/shared';
import type { AuthConfig } from '../common/auth/auth.config.js';
import { InjectAuthConfig } from '../common/auth/auth.config.js';
import { INTERNAL_TOKEN_HEADER } from '../common/auth/auth-context.js';
import type { AiConfig } from './ai.config.js';
import { InjectAiConfig } from './ai.config.js';

/** What the AI service said about the request, not about the document. */
export interface DocumentReadOutcome {
  /**
   * Whether an analysis was there to run the check.
   *
   * False when the AI never started for this call or has already stopped. Not
   * an error: a call runs perfectly well without AI (D6, T32), and the agent is
   * told to decide on what they can see.
   */
  readonly accepted: boolean;
}

export interface DocumentReader {
  /**
   * Ask for one document check.
   *
   * Throws if the service refuses or cannot be reached. The caller turns that
   * into "no AI for this check" and never into a failed call.
   */
  read(sessionId: string, documentType: DocumentType): Promise<DocumentReadOutcome>;
}

export const DOCUMENT_READER = Symbol('DOCUMENT_READER');

export const InjectDocumentReader = (): ParameterDecorator => Inject(DOCUMENT_READER);

/** The AI service's route. The session id is in the path, not the body. */
export const documentPathFor = (sessionId: string): string =>
  `/internal/sessions/${encodeURIComponent(sessionId)}/document`;

@Injectable()
export class HttpDocumentReader implements DocumentReader {
  constructor(
    @InjectAiConfig() private readonly config: AiConfig,
    @InjectAuthConfig() private readonly auth: AuthConfig,
  ) {}

  async read(sessionId: string, documentType: DocumentType): Promise<DocumentReadOutcome> {
    const request: DocumentReadRequest = { document_type: documentType };

    // An explicit timeout, because an agent is watching. This hop covers an OCR
    // read and a registry lookup, so it is allowed to be slower than the
    // analysis start — but not unbounded: a verifier that accepted the
    // connection and then stopped answering would otherwise hold the agent's
    // request open for the platform's default socket timeout.
    const response = await fetch(this.config.baseUrl + documentPathFor(sessionId), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: this.auth.internalToken,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.config.documentTimeoutMs),
    });

    if (!response.ok) {
      // The status only. A body from the AI service is not expected to carry
      // anything sensitive, but this is the one path in the system where a
      // third party's error text is somewhere upstream, and quoting an upstream
      // body into an exception is how that text reaches a log.
      throw new Error(`the AI service answered ${String(response.status)}`);
    }

    return { accepted: acceptedFrom(await response.json()) };
  }
}

/**
 * Read `accepted` out of the AI service's answer.
 *
 * **The body is bare.** The AI service is FastAPI and returns its dict as-is:
 *
 * ```json
 * { "session_id": "...", "document_type": "PAN", "accepted": true, "status": "UNREADABLE" }
 * ```
 *
 * The `{ "data": ... }` envelope is the Control API's own convention for its
 * own routes, and this client read for it — so `body.data` was always
 * `undefined`, every check reported `accepted: false`, and the agent was told
 * "no AI on this call" while the analyzer was running perfectly and publishing
 * the result to their HUD a second later. The two panels contradicted each
 * other because one was reading the answer and the other was reading a field
 * that never existed.
 *
 * Defensive rather than a cast: this is a cross-service boundary that TypeScript
 * cannot check (`apps/ai` is outside the build graph), so anything that is not
 * literally `accepted: true` reads as not accepted. Being wrong in that
 * direction costs a retry; being wrong the other way would claim a check ran
 * when nothing did.
 */
export function acceptedFrom(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  return (body as { accepted?: unknown }).accepted === true;
}
