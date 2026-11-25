import type { BoardSnapshot } from '@nolzu/protocol';

// The guidance of the first run after New project, as pure rules over what the server read: the
// Getting started list in the rail, the coach note on the first agent column, and the offer to start at
// login. The browser imports this file too, so it holds no database read.

export type StepId = 'card' | 'drag' | 'summary' | 'push';

export interface FirstRun {
  // The four steps in order, or null when the rail shows no list: a project New project did not make,
  // or every step done.
  steps: readonly { id: StepId; label: string; done: boolean }[] | null;
  // The name of the coach note on the first agent column, or null once it is closed or a card was
  // dragged, when it has nothing left to explain.
  coach: string | null;
  // The name of "Start Nolzu when you log in?", or null when it is not asked.
  loginOffer: string | null;
}

// Names in `seenNotes`, so each one is answered once on this machine.
export const COACH_NOTE = 'first-drag';
export const LOGIN_NOTE = 'start-at-login';

export interface FirstRunFacts {
  // A card exists.
  card: boolean;
  // The first agent column of the first card's board, which the drag step names.
  dragTo: string;
  // A person moved a card onto a column that started a run: a drag, Move forward or Add and start.
  dragged: boolean;
  // The `gettingStarted` setting: the plain summary read and the first push, or null for no list.
  recorded: readonly ('summary' | 'push')[] | null;
  seen: readonly string[];
  // Whether Turn on can work here, so the question is never asked where the answer does nothing.
  canStartAtLogin: boolean;
}

export function firstRunOf(facts: FirstRunFacts): FirstRun {
  const steps = [
    { id: 'card' as const, label: 'Make the first card', done: facts.card },
    { id: 'drag' as const, label: `Drag it to ${facts.dragTo}`, done: facts.dragged },
    { id: 'summary' as const, label: 'Read what changed', done: facts.recorded?.includes('summary') === true },
    { id: 'push' as const, label: 'Push your first branch', done: facts.recorded?.includes('push') === true },
  ];
  return {
    steps: facts.recorded === null || steps.every((step) => step.done) ? null : steps,
    coach: facts.dragged || facts.seen.includes(COACH_NOTE) ? null : COACH_NOTE,
    // After the first card, asked once, and never switched on from here.
    loginOffer: facts.card && facts.canStartAtLogin && !facts.seen.includes(LOGIN_NOTE) ? LOGIN_NOTE : null,
  };
}

export interface CoachAt {
  stage: string;
  label: string;
  phase: string;
  // The card the note tells the person to drop.
  key: string;
  // The engine profile's label, as Now names it.
  engine: string;
}

// Where the coach note sits: the first agent column, while the column before it holds a card to drop
// there and the drop would start a run. Null otherwise, so the note never names a card or a start that
// is not there.
export function coachAt(board: BoardSnapshot | null, coach: string | null, profiles: readonly { id: string; label: string }[]): CoachAt | null {
  if (board === null || coach === null) return null;
  const at = board.stages.findIndex((stage) => stage.role === 'agent');
  const agent = board.stages[at];
  const before = board.stages[at - 1];
  const card = board.cards.find((one) => one.stage === before?.id && !one.minimized);
  if (agent?.starts?.modelState !== 'ok' || card === undefined) return null;
  const { phase, engine } = agent.starts;
  return { stage: agent.id, label: agent.label, phase, key: card.key, engine: profiles.find((one) => one.id === engine)?.label ?? engine };
}

// What the phase of that first column does, said under the note's first line. The two phases a first
// card can reach from the first task screen; the note says nothing more for any other.
export const PHASE_SAYS: Readonly<Partial<Record<string, string>>> = {
  refine: 'Refine rewrites the ticket so you and the agent agree on what done means. It changes no code.',
  research: 'Research reads the repositories and answers the question. It changes no code.',
};
