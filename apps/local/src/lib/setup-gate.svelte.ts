import { learnAsk } from './now.ts';
import { nowLive } from './now-live.svelte.ts';

// The Learn dialog of Set up the project, open over any screen. The root layout draws it once, and
// the move every screen sends goes through `askFirst`, which opens it in place of the first run.
export interface SetupGateOpen {
  key: string;
  to: string;
  // The move the screen held back. "I will write it myself" sends it once the mark is saved.
  go: () => unknown;
  // What the screen does when the dialog closes with nothing sent, such as letting go of its button.
  stay?: () => void;
}

class SetupGate {
  state = $state.raw<SetupGateOpen | null>(null);
}

export const setupGate = new SetupGate();

// Opens the dialog in place of a move that would start the first run while Learn your repositories is
// open, and says whether it did. Read off the Now stream at the press, as the question at the first QA is.
export function gateFirst(key: string, to: string, go: () => unknown, stay?: () => void): boolean {
  if (!learnAsk(nowLive.state.snapshot, key, to)) return false;
  setupGate.state = { key, to, go, ...(stay === undefined ? {} : { stay }) };
  return true;
}
