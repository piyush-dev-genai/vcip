/**
 * `POST /internal/ai/result` — contract §23, D6, D10 (T30).
 *
 * The one route by which the AI service reaches this API. It is the hinge of
 * D6's diagram:
 *
 * ```text
 * AI Service -> POST /internal/ai/result -> Redis HUD -> WebSocket -> Agent
 * ```
 *
 * `InternalTokenGuard` and nothing else. A result names a session and is about
 * to be shown to the agent on that call, so an unauthenticated caller could
 * write whatever it liked onto the HUD an agent is using to decide whether a
 * person is who they say they are. The route is not published publicly either,
 * but that is a deployment property and this guard is not.
 *
 * The body is validated against the shared schema before it reaches the
 * service. That matters more here than on a route with a typed client: the
 * caller is a Python service that cannot be type-checked against this
 * repository, so this pipe is the only thing standing between a renamed field
 * on that side and a silently empty HUD on this one.
 *
 * No tenant guard: an internal actor carries no tenant, and the session id in
 * the body is the resource being named.
 */

import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { AiResultRequest, DocumentResultRequest } from '@vcip/shared';
import { aiResultSchema, documentResultSchema } from '@vcip/shared';
import { InternalTokenGuard } from '../common/auth/internal-token.guard.js';
import type { ApiData } from '../common/http/envelope.js';
import { data } from '../common/http/envelope.js';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe.js';
import type { DocumentResultReceipt } from './ai-document.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { AiDocumentService } from './ai-document.service.js';
import type { AiResultReceipt } from './ai-result.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI token
import { AiResultService } from './ai-result.service.js';

@Controller('internal/ai')
export class AiResultController {
  constructor(
    private readonly results: AiResultService,
    private readonly documents: AiDocumentService,
  ) {}

  /**
   * Take delivery of one AI result.
   *
   * 200 and a receipt. Not 202: by the time this returns the result has been
   * taken as far as it is going to go, and there is no later step for the
   * caller to poll for.
   *
   * No `Idempotency-Key`. The AI service publishes a fresh snapshot every
   * couple of seconds and a repeated one is not a repeated *operation* — D13
   * protects things that must happen at most once, and the last result winning
   * is the intended behaviour of a HUD.
   */
  @Post('result')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  async receive(
    @Body(new ZodValidationPipe(aiResultSchema)) body: AiResultRequest,
  ): Promise<ApiData<AiResultReceipt>> {
    return data(await this.results.receive(body));
  }

  /**
   * Take delivery of one agent-triggered document check (§19).
   *
   * A separate route from `result` rather than a variant of it, because the two
   * write disjoint parts of the HUD and arrive on completely different
   * schedules: this one happens when an agent presses a button, that one every
   * couple of seconds. Folding them together would mean every sampled result
   * carried a document status it knows nothing about.
   *
   * The schema is the guarantee that no document contents reach this process.
   * It is strict and has no field for them, so a future AI service that started
   * sending a number would be answered 400 rather than quietly storing it.
   *
   * No `Idempotency-Key`, for the same reason `result` has none: an agent may
   * legitimately check the same document twice — an unreadable frame is
   * answered by trying again — and the last answer winning is the intent.
   */
  @Post('document-result')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  async receiveDocument(
    @Body(new ZodValidationPipe(documentResultSchema)) body: DocumentResultRequest,
  ): Promise<ApiData<DocumentResultReceipt>> {
    return data(await this.documents.receive(body));
  }
}
