import type { StageView } from '@nolzu/protocol';
import { stackAsk } from './now.ts';
import { nowLive } from './now-live.svelte.ts';
import type { QaSetup } from './qa-setup.ts';
import { gateFirst } from './setup-gate.svelte.ts';

// The question at the first QA, open over any screen. The root layout draws it once, and every screen
// that sends a move into QA opens it, so a drag, a key, Now and the card page ask the same question.
export interface QaAskOpen {
  key: string;
  // The QA stage the move starts, for the Starts line beside Start QA.
  stage: StageView;
  // What the repositories said at the press. Kept with the question, so the stream's echo of the answer
  // does not pull the dialog from under Start QA.
  setup: QaSetup;
  // The move the screen held back. Start QA sends it once the answer is saved.
  go: () => unknown;
  // What the screen does when the question closes with no answer, such as letting go of its button.
  stay?: () => void;
}

class QaAsk {
  state = $state.raw<QaAskOpen | null>(null);
}

export const qaAsk = new QaAsk();

// Opens what a move asks first, and says whether it did: the Learn dialog of Set up the project before
// the first run, then the question at the first QA. "I will write it myself" goes on to the question,
// so a first move into QA still asks it.
export function askFirst(key: string, to: string, go: () => unknown, stay?: () => void): boolean {
  return gateFirst(key, to, () => askQa(key, to, go, stay) || go(), stay) || askQa(key, to, go, stay);
}

// Opens the question in place of a move that would start QA before the project answered it, and says
// whether it did. Read off the Now stream at the press, so a move after the answer goes straight in.
function askQa(key: string, to: string, go: () => unknown, stay?: () => void): boolean {
  const setup = nowLive.state.snapshot?.qaSetup ?? null;
  const stage = stackAsk(nowLive.state.snapshot, key, to);
  if (stage === null || setup === null) return false;
  qaAsk.state = { key, stage, setup, go, ...(stay === undefined ? {} : { stay }) };
  return true;
}

// The same question before a retry of a card in QA, which runs the start command again. The card's own
// column is the stage it starts.
export function askBeforeRetry(key: string, go: () => unknown, stay?: () => void): boolean {
  const stage = nowLive.state.snapshot?.boards.flatMap((board) => board.cards).find((card) => card.key === key)?.stage;
  return stage !== undefined && askFirst(key, stage, go, stay);
}
