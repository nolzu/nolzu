/**
 * Set up the project: the steps the app owns, per project, as pure rules the server and the
 * screens share.
 *
 * A step is required, recommended or optional. The banner on the boards and on Now shows each open
 * required and recommended step, the first task screen lists every step, and the one required step holds the
 * first run back until it is done or the person says they will write it themselves.
 */
export const SETUP_STEPS = ['learn', 'commands', 'qa', 'tickets'] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

// What the person did with a step, as the project stores it. `self` is "I will write it myself" on
// Learn your repositories, `dismissed` a recommended or optional step put away.
export const SETUP_MARKS = ['done', 'self', 'dismissed'] as const;
export type SetupMark = (typeof SETUP_MARKS)[number];
export type SetupMarks = Readonly<Partial<Record<SetupStepId, SetupMark>>>;

export type SetupNeed = 'required' | 'recommended' | 'optional';
export type SetupState = 'open' | 'done' | 'dismissed';

export interface SetupStep {
  id: SetupStepId;
  need: SetupNeed;
  state: SetupState;
  title: string;
  // One line on what the step is for.
  says: string;
  // The words of the link to where the step is done, which each screen resolves by the step's id.
  go: string;
}

// What the steps are read off, besides the marks: facts the project holds on its own rows.
export interface SetupFacts {
  marks: SetupMarks;
  // No repository file still holds only the lines Nolzu wrote, which counts Learn as done for a
  // project made before the steps, or one whose learned knowledge was approved.
  learned: boolean;
  // QA has a browser config.
  browser: boolean;
  // The project reads a ticket system.
  tickets: boolean;
}

// What a run lacks when the person writes the knowledge themselves, said once when they choose it.
export const WRITE_IT_MYSELF =
  'Runs will not know what each repository is for or how to install, run and test it until you write that in Knowledge, in the repository.md of each repository and in run-recipe.md.';

const STEPS: readonly Omit<SetupStep, 'state'>[] = [
  {
    id: 'learn',
    need: 'required',
    title: 'Learn your repositories',
    says: 'An agent reads each README, CI and stack file and writes how to run, test and build it, and the rules the code keeps, for your review.',
    go: 'Learn on Knowledge',
  },
  {
    id: 'commands',
    need: 'recommended',
    title: 'Confirm the run commands',
    says: 'The commands Implement and QA may run, read from your repositories. Check the list once.',
    go: 'Check the list',
  },
  {
    id: 'qa',
    need: 'recommended',
    title: 'Set up the QA browser',
    says: 'Lets QA open your app in Chrome and take screenshots of what changed.',
    go: 'Set it up',
  },
  {
    id: 'tickets',
    need: 'optional',
    title: 'Connect a ticket system',
    says: 'Read cards from Jira. Cards made in Nolzu work without it.',
    go: 'Open Tickets',
  },
];

// A required step never takes `dismissed`: it is done, or done the other way with `self`.
function stateOf(need: SetupNeed, mark: SetupMark | undefined, fact: boolean): SetupState {
  if (fact || mark === 'done' || mark === 'self') return 'done';
  return mark === 'dismissed' && need !== 'required' ? 'dismissed' : 'open';
}

export function setupSteps(facts: SetupFacts): SetupStep[] {
  const fact: Record<SetupStepId, boolean> = { learn: facts.learned, commands: false, qa: facts.browser, tickets: facts.tickets };
  return STEPS.map((step) => ({ ...step, state: stateOf(step.need, facts.marks[step.id], fact[step.id]) }));
}

// The steps the banner lists: the open required and recommended ones, each until it is done or put
// away, so the QA browser still has a pointer once Learn is done. An optional step is on the first
// task screen only.
export function bannerSteps(steps: readonly SetupStep[]): SetupStep[] {
  return steps.filter((step) => step.need !== 'optional' && step.state === 'open');
}

// What Now's stream carries: every step, and whether the next run a person starts opens the Learn
// dialog first.
export interface SetupView {
  steps: SetupStep[];
  gates: boolean;
}

// Whether a move that starts a phase opens the Learn dialog first: Learn your repositories is open,
// and no person has started a run in this project yet.
export const learnGates = (steps: readonly SetupStep[], started: boolean): boolean => !started && steps.some((step) => step.id === 'learn' && step.state === 'open');
