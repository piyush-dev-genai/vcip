'use client';

import type { AbortResult, SessionView } from '@/lib/session';
import type { Outcome as OutcomeView } from '@/lib/screen';
import { outcomeOf } from '@/lib/screen';

/**
 * The end of the verification.
 *
 * The one screen a customer is guaranteed to read, and usually the only one
 * they will remember, so it gets the whole viewport and says one thing. It
 * replaces the terminal branch of the status screen, which showed a finished
 * verification the same gate checklist, refresh button and raw status codes it
 * showed a running one — and, before `canJoinQueue` was fixed, a live Join
 * Queue button under the heading "Ready for an agent".
 *
 * **It renders `outcomeOf` and decides nothing.** Which of the three outcomes
 * this is comes from `status`, which the server set and which arrived on the
 * same `GET /v1/sessions/{id}` as everything else on this screen (D1). There is
 * no branch here that could show an approval for a session the server has not
 * approved.
 *
 * **The animation is pacing, not decoration.** The mark draws, then the
 * heading rises, then the sentence: about three quarters of a second in which
 * the customer looks at a symbol and then reads what it means. A result that
 * simply replaced the previous screen would be read too fast to land, and this
 * is the moment in the product where being understood matters most. Anyone who
 * has asked for reduced motion gets the final state immediately — the
 * stylesheet collapses every duration, and nothing here is animation-gated, so
 * the screen is complete and readable either way.
 *
 * **Colour never carries the meaning alone.** The mark's shape, the headline
 * and the sentence each state the outcome independently, so a customer who
 * cannot tell green from red still learns whether they were approved.
 */
export function Outcome({
  session,
  aborted,
}: {
  session: SessionView;
  /**
   * The server's own answer to an abort the customer made in this visit.
   *
   * Shown only when it is present, which is only immediately after they
   * pressed the button. A reload loses it, and that is correct: the outcome
   * above is the durable fact, and the billing line is a receipt for an action
   * they just took.
   */
  aborted: AbortResult | null;
}) {
  const outcome = outcomeOf(session);

  // Every terminal status has an outcome and only a terminal status routes
  // here, so this is unreachable — but rendering a blank screen would be a
  // worse way to find that out than rendering the fallback.
  if (outcome === null) {
    return (
      <section className="card">
        <h1>Your verification has ended</h1>
        <p className="muted">
          Current state: <span className="state">{session.status}</span>
        </p>
      </section>
    );
  }

  return (
    <section className="outcome" data-tone={outcome.tone} aria-live="polite">
      <Mark tone={outcome.tone} />

      <h1>{outcome.headline}</h1>
      <p className="outcome-detail">{outcome.detail}</p>
      <p className="outcome-next">{outcome.next}</p>

      {aborted === null ? null : <Receipt aborted={aborted} />}

      <div className="outcome-foot">
        <p className="muted">
          Current state: <span className="state">{session.status}</span>
        </p>
        <p className="ref">Reference {session.session_id}</p>
      </div>
    </section>
  );
}

/**
 * The mark that draws itself.
 *
 * `pathLength="1"` normalises every path to a length of one whatever its real
 * geometry, so one dash rule in the stylesheet animates the ring and the glyph
 * identically and no length has to be measured or hard-coded here.
 *
 * `aria-hidden`, because the heading beside it already says the outcome. A
 * screen reader announcing "tick" before "You are verified" would be reading
 * the same fact twice, the second time in a vocabulary nobody chose.
 */
function Mark({ tone }: { tone: OutcomeView['tone'] }) {
  return (
    <div className="outcome-mark">
      <svg viewBox="0 0 1 1" aria-hidden="true">
        <circle className="outcome-ring" cx="0.5" cy="0.5" r="0.42" pathLength="1" />
        {tone === 'approved' ? (
          <path className="outcome-glyph" d="M0.3 0.52 L0.44 0.66 L0.71 0.36" pathLength="1" />
        ) : null}
        {tone === 'rejected' ? (
          <>
            <path className="outcome-glyph" d="M0.35 0.35 L0.65 0.65" pathLength="1" />
            <path className="outcome-glyph" d="M0.65 0.35 L0.35 0.65" pathLength="1" />
          </>
        ) : null}
        {tone === 'stopped' ? (
          // A single bar. Not a cross, which would read as a rejection, and not
          // a tick: nothing was decided either way.
          <path className="outcome-glyph" d="M0.33 0.5 L0.67 0.5" pathLength="1" />
        ) : null}
      </svg>
    </div>
  );
}

/**
 * What the abort cost, exactly as the server said.
 *
 * Both figures come from the abort response and are rendered verbatim. This
 * app holds no billing rule and computes no amount — a number worked out here
 * would be a second billing rule that could disagree with the invoice.
 */
function Receipt({ aborted }: { aborted: AbortResult }) {
  return (
    <div className="outcome-next">
      <strong>Verification stopped at your request.</strong>{' '}
      {aborted.bill_category === null
        ? 'Nothing has been charged for it.'
        : `Charge category ${aborted.bill_category}, ${String(aborted.bill_amount_paise)} paise.`}
    </div>
  );
}
