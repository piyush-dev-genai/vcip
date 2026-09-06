'use client';

/**
 * Where the customer is in the three gates.
 *
 * It replaces the "Step 2 of 3" line each screen carried, which stated the
 * same fact without showing the shape of it. Someone who can see two more
 * beads after the one they are on knows how much is left, and knowing a short
 * flow is short is most of what stops people abandoning it.
 *
 * `current` is the step the screen already knew it was — the same 1, 2 or 3
 * that used to be written into the sentence. It is deliberately not derived
 * from `gatesOf`: the screen the customer is looking at is the authority on
 * which step they are on, and a second derivation could disagree with it
 * during the moment between a gate passing and the next screen mounting.
 *
 * It is a list, not a progress bar, because it is three named things rather
 * than a percentage — and each one is named, so the flow can be understood
 * before it is begun.
 */
const STEPS: readonly string[] = Object.freeze(['Consent', 'Device', 'Location']);

export function Steps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="steps" aria-label={`Step ${current} of ${STEPS.length}`}>
      {STEPS.map((label, index) => {
        const position = index + 1;
        const done = position < current;
        const here = position === current;

        return (
          <li
            key={label}
            className={`step-item${done ? ' is-done' : ''}${here ? ' is-current' : ''}`}
            aria-current={here ? 'step' : undefined}
          >
            <span className="step-bead" aria-hidden="true">
              {done ? '✓' : position}
            </span>
            <span className="step-label">{label}</span>
            <span className="visually-hidden">
              {done ? ' completed' : here ? ' — current step' : ' not started'}
            </span>
            {position < STEPS.length ? (
              <span className={`step-rule${done ? ' is-done' : ''}`} aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
