// What a card's stack is doing, as Nolzu last saw it. Here because three packages need the same
// five words: the runner writes them, core stores them, and the ticket page draws them.
//
// `off` is a card with no own commands, and an app that was stopped again. Both are normal,
// and the sentence beside the state is what tells them apart.
export const STACK_STATES = ['off', 'loading', 'up', 'failed', 'unloading'] as const;

export type StackState = (typeof STACK_STATES)[number];

export const isStackState = (value: string): value is StackState => (STACK_STATES as readonly string[]).includes(value);

// The sentence the app line carries once the Stop after a run took the app down again. The card page reads
// it to say the app went up for QA and came down after.
export const TAKEN_DOWN = 'The app was stopped after the run.';
