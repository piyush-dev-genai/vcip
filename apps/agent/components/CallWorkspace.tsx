'use client';

import type { AiHudPayload, ChecklistAnswer } from '@vcip/shared';
import { documentSummary, isUnavailable } from '../lib/ai-hud';
import type { AgentApi } from '../lib/api';
import { useFreshHud } from '../lib/use-hud';
import { AiPanel } from './AiPanel';
import { CallPanel } from './CallPanel';
import { ChecklistPanel } from './ChecklistPanel';
import { DocumentPanel, TONES } from './DocumentPanel';
import { Tabs } from './Tabs';
import type { TabDefinition } from './Tabs';
import { VerdictPanel } from './VerdictPanel';

/**
 * The call screen, laid out for someone who is talking to a customer.
 *
 * The problem this solves: the five panels of a verification used to be one
 * column, so an agent mid-call had video at the top and the verdict somewhere
 * past the fold, with the AI panel, the document check and the checklist
 * stacked in between. Everything was on screen in the sense that it was in the
 * document. None of it was on screen in the sense that mattered.
 *
 * So the video keeps the left, where the agent is actually looking, and the
 * three assistive panels take turns in a rail on the right with the verdict
 * pinned beneath them. Nothing was cut and nothing moved to another route —
 * the panels stay mounted behind their tabs, so a document check started and
 * then switched away from is still running when the agent comes back.
 *
 * **Tabs must not hide a signal.** That is the one risk of this layout, and
 * every tab answers it with a badge computed here: how much checklist is left,
 * whether a document check came back and how, whether the AI is saying anything
 * at all. An agent watching the video can read all three without opening one.
 *
 * It composes and decides nothing else. Every panel below still owns its own
 * state, the verdict still gates on `approvalReady` from the shared package,
 * and none of them learned anything new from being arranged.
 */
export interface CallWorkspaceProps {
  readonly sessionId: string;
  readonly roomName: string | null;
  readonly api: AgentApi;
  /** Every HUD the portal has received, keyed by session. */
  readonly updates: Readonly<Record<string, AiHudPayload>>;
  readonly checklist: {
    readonly answers: readonly ChecklistAnswer[];
    readonly ready: boolean;
  };
  readonly onChecklistChange: (state: {
    readonly answers: readonly ChecklistAnswer[];
    readonly ready: boolean;
  }) => void;
  readonly idempotencyKey: string;
  readonly onSubmitted: () => void;
}

export function CallWorkspace({
  sessionId,
  roomName,
  api,
  updates,
  checklist,
  onChecklistChange,
  idempotencyKey,
  onSubmitted,
}: CallWorkspaceProps) {
  // One reading of the AI result, aged once, shared by the panel that shows it
  // and the badges that summarise it. Two clocks would eventually disagree.
  const hud = useFreshHud(updates, sessionId);
  const docCheck = documentSummary(hud);

  const outstanding = checklist.answers.length - ticked(checklist.answers);

  const tabs: readonly TabDefinition[] = [
    {
      id: 'ai',
      label: 'AI',
      // A dot, not a word: whether anything is arriving, without implying an
      // outcome. The AI decides nothing (I7) and its badge must not either.
      badge: '',
      tone: isUnavailable(hud) ? 'plain' : 'ok',
      panel: <AiPanel hud={hud} />,
    },
    {
      id: 'document',
      label: 'Document',
      badge: docCheck.status === null ? null : '',
      tone: docCheck.status === null ? 'plain' : toneFor(docCheck.status),
      panel: <DocumentPanel sessionId={sessionId} api={api} hud={hud} />,
    },
    {
      id: 'checklist',
      label: 'Checklist',
      // The count that is left, which is the number an agent is actually
      // tracking. Absent rather than zero once it is done — a "0" badge reads
      // like something missing.
      badge: outstanding > 0 ? String(outstanding) : null,
      tone: 'warn',
      panel: <ChecklistPanel sessionId={sessionId} api={api} onChange={onChecklistChange} />,
    },
  ];

  return (
    <div className="workspace">
      <div className="stage-pane">
        <CallPanel sessionId={sessionId} roomName={roomName} api={api} />
      </div>

      <div className="rail">
        <Tabs tabs={tabs} initial="checklist" label="Verification panels" />

        <VerdictPanel
          sessionId={sessionId}
          api={api}
          answers={checklist.answers}
          approvable={checklist.ready}
          idempotencyKey={idempotencyKey}
          onSubmitted={onSubmitted}
        />
      </div>
    </div>
  );
}

/** How many answers are ticked. Display only; the server re-derives readiness. */
function ticked(answers: readonly ChecklistAnswer[]): number {
  let done = 0;
  for (const answer of answers) if (answer.checked) done += 1;
  return done;
}

/**
 * A document outcome as a badge colour.
 *
 * Reuses the panel's own table so the dot on the tab and the box inside it can
 * never say different things. `muted` has no badge variant and falls back to
 * plain, which is right: an unreachable registry is not the customer's fault
 * and should not be coloured like one.
 */
function toneFor(status: string): TabDefinition['tone'] {
  const tone = TONES[status];
  return tone === 'ok' || tone === 'warn' || tone === 'bad' ? tone : 'plain';
}
