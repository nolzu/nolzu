import { ENGINE_LABELS, type EngineName } from './engine.ts';

// A runtime list as well as a type, so a route that has to check a name in an address against the
// five does not keep its own copy that can drift from this one.
export const BOARD_KINDS = ['delivery', 'epics', 'investigations', 'questions', 'prreview'] as const;

export type BoardKind = (typeof BOARD_KINDS)[number];

export const isBoardKind = (value: string): value is BoardKind => (BOARD_KINDS as readonly string[]).includes(value);

// What a person is shown where a board is named. `prreview` is the one whose id and name differ,
// because an address takes no space.
export const BOARD_LABELS: Readonly<Record<BoardKind, string>> = {
  delivery: 'Delivery',
  epics: 'Epics',
  investigations: 'Investigations',
  questions: 'Questions',
  prreview: 'PR reviews',
};

// The two kinds the Research board draws as one. Both are read-only runs that end in
// text, and both share their stage ids, so one board holds them. Each kind keeps its phase and model
// row, its report file and its key prefix, so a stored card reads as before.
export const RESEARCH_KINDS = ['questions', 'investigations'] as const;

export type ResearchKind = (typeof RESEARCH_KINDS)[number];

export const isResearchKind = (kind: string): kind is ResearchKind => (RESEARCH_KINDS as readonly string[]).includes(kind);

// What one card of each kind is called on the list and in its kind switch.
export const RESEARCH_KIND_LABELS: Readonly<Record<ResearchKind, string>> = { questions: 'Question', investigations: 'Investigation' };

// The file each kind's run writes, which the card page shows as the answer or the report.
export const RESEARCH_REPORTS: Readonly<Record<ResearchKind, string>> = { questions: 'research/answer.md', investigations: 'investigate/report.md' };

// A new card of each kind is numbered under its own prefix, `Q-7` and `INV-4`, so its key says what it
// is. The project's own prefix numbers every other board. Neither may be the project's prefix.
export const RESEARCH_PREFIXES: Readonly<Record<ResearchKind, string>> = { questions: 'Q', investigations: 'INV' };

// The prefix a new local card on `board` is numbered under.
export const keyPrefixFor = (board: BoardKind, projectPrefix: string): string => (isResearchKind(board) ? RESEARCH_PREFIXES[board] : projectPrefix);

// A board as a person picks it where boards are listed: one of the kinds, or Research for its two.
// The rail, the command palette, Add card and the board switches all list these.
export type BoardChoice = BoardKind | 'research';

export const choiceOf = (kind: BoardKind): BoardChoice => (isResearchKind(kind) ? 'research' : kind);

export const choiceLabel = (choice: BoardChoice): string => (choice === 'research' ? 'Research' : BOARD_LABELS[choice]);

// The choices of some kinds, in their order, with Research once where the first of its kinds stood.
export const choicesOf = (kinds: readonly BoardKind[]): BoardChoice[] => [...new Set(kinds.map(choiceOf))];

export type StageRole = 'you' | 'agent' | 'auto' | 'archive';

// A runtime list as well as a type, so a screen that has to check a stored value against the six
// does not keep its own copy that can drift from this one.
export const CARD_STATES = ['idle', 'queued', 'running', 'ready', 'blocked', 'failed'] as const;

export type CardState = (typeof CARD_STATES)[number];

// The size a card stores. Add card sets none: the tick "Go on to Implement after Plan" on the card's
// Settings tab stores small, and no size once it is off. The chain and the small-card cost read it. A
// card that kept medium or large from before reads as not ticked.
export const CARD_SIZES = ['small', 'medium', 'large'] as const;

export type CardSize = (typeof CARD_SIZES)[number];

export const isCardSize = (value: unknown): value is CardSize => (CARD_SIZES as readonly unknown[]).includes(value);

// A runtime list as well as a type, so a check against the names does not keep a second copy that
// can drift from this one. The first five belong to Delivery, and the next five to the four boards
// beside it. `feedback` is a stage of no board: Run triage on a Delivery card's PRs tab starts it on
// the card where it sits. The name stays Delivery's, because the type is read in a hundred places and the phases
// of one board are still what it grew from. Every name here has a skill, a policy row and a row in
// the action table, which is what a stage needs to start it.
export const DELIVERY_PHASES = ['refine', 'plan', 'implement', 'qa', 'wrapup', 'architecture', 'design', 'investigate', 'research', 'pr-review', 'feedback'] as const;

export type DeliveryPhase = (typeof DELIVERY_PHASES)[number];

// What a person is shown where a phase is named, including the summary pass, which is no stage and
// still has a row on the model tables. The screens and the refusal sentences read this one map, so
// nothing prints the stored key at somebody.
export const PHASE_LABELS: Readonly<Record<string, string>> = {
  refine: 'Refine',
  plan: 'Plan',
  implement: 'Implement',
  qa: 'QA',
  wrapup: 'Wrap-up',
  optimize: 'Optimize',
  orient: 'Learn this project',
  'learn-repo': 'Learn your repositories',
  'extract-summary': 'Plain summary',
  'commit-message': 'Commit message',
  'thread-title': 'Discussion subject',
  architecture: 'Architecture',
  design: 'Design',
  // The old name of Design. Its folder stays in card folders made before the rename, and the Files tab
  // still names who wrote it.
  mockups: 'Mockups',
  investigate: 'Investigate',
  research: 'Research',
  'pr-review': 'PR review',
  feedback: 'Triage',
  assess: 'Assessment',
  ask: 'Ask',
};

// One line per model row in Settings, Models: what the step does and where it runs, since some of
// them, like Assessment, sit on no board.
export const PHASE_HELP: Readonly<Record<string, string>> = {
  refine: 'Turns a rough ticket into a brief with acceptance checks. On Delivery and Epics.',
  plan: 'Writes the numbered plan and the QA checks before any code. On Delivery and Epics.',
  implement: "Makes the change in the card's checkout and writes the pull request text. On Delivery.",
  qa: "Runs the project's checks against the brief and ends with a verdict. On Delivery.",
  wrapup: 'Adds what a finished card taught to the knowledge files. Near the end of most boards.',
  architecture: 'Decides the shape of an epic: its pieces, data and decisions. On Epics.',
  design: 'Draws the screens an epic changes as HTML pages. On Epics.',
  investigate: 'Reads the code and logs to find what caused a problem. On Research, for an Investigation.',
  research: "Answers a question from the repository and the project's documents. On Research, for a Question.",
  'pr-review': 'Reviews a pull request and writes findings with file and line. On PR reviews.',
  feedback: "Triages the comments on a card's pull request and drafts replies. From its PRs tab.",
  optimize: 'Rewrites one knowledge file shorter and truer. Runs from the Optimize button on Knowledge.',
  orient: "Reads the project's docs, asks you a few questions, and writes knowledge you review. On Knowledge.",
  'learn-repo': 'Writes how to run a repository and the rules its code keeps. On Knowledge.',
  assess: 'Reads one Scout finding against the code and writes what is behind it. On Scout.',
  ask: "Answers your question about a card in a read-only session. From a card's Discussion tab.",
  'extract-summary': 'Writes the plain summary after a run, commit messages and Ask discussion subjects.',
};

// The rest of a phase's "?" on Settings, Phase instructions, after its PHASE_HELP line: what the run
// writes, what your own instruction there is good for, and one example. Every phase but the passes.
// An example only adds or changes words, because the skill keeps its file names and headings.
export const PHASE_INSTRUCTION_HELP: Readonly<Record<string, { writes: string; use: string; example: string }>> = {
  refine: { writes: 'It writes refine/refined.md in the card folder.', use: 'Good for what every brief must cover.', example: 'Name the user role behind each acceptance check.' },
  plan: { writes: 'It writes plan/plan.md and qa/checks.md.', use: 'Good for parts your team wants in every plan.', example: 'Add a Risks section to plan.md.' },
  implement: { writes: 'It writes the code, implement/pr.md and implement/deviations.md.', use: 'Good for code rules your repository docs do not say.', example: 'Add a CHANGELOG line for every change a user can see.' },
  qa: { writes: 'It writes qa/report.md with the verdict.', use: 'Good for checks QA must always run.', example: 'Always open each changed page at 390px wide.' },
  wrapup: { writes: 'It writes to the knowledge files and wrapup/changes.md.', use: 'Good for what is worth keeping.', example: 'Keep what helps the next card, not the story of this one.' },
  architecture: { writes: 'It writes architecture/architecture.md.', use: 'Good for the decisions your team wants on paper.', example: 'Name every new database table and the service that owns it.' },
  design: { writes: 'It writes one HTML page per screen and design/design.md.', use: 'Good for the look and the parts to reuse.', example: 'Reuse the buttons and colours of the settings pages.' },
  investigate: { writes: 'It writes investigate/report.md.', use: 'Good for where to look first.', example: 'Read the newest logs in logs/ before the code.' },
  research: { writes: 'It writes research/answer.md.', use: 'Good for the sources to trust and the shape of the answer.', example: 'Start the answer with a one line yes or no.' },
  'pr-review': { writes: 'It writes a round of findings, each with a file and a line.', use: 'Good for what reviews in your team care about.', example: 'Flag every new database query that has no index.' },
  feedback: { writes: 'It writes feedback/triage.md with the draft replies.', use: 'Good for the tone of the replies.', example: 'Keep each reply under three sentences.' },
  optimize: { writes: 'It writes the shorter knowledge file and optimize/changes.md.', use: 'Good for what must never be cut.', example: 'Never drop a command from run-recipe.md.' },
  orient: { writes: 'It writes the first knowledge files and orient/changes.md.', use: 'Good for the documents to read first.', example: 'Read docs/architecture.md before the README.' },
  'learn-repo': { writes: "It writes the repository's knowledge file and learn-repo/changes.md.", use: 'Good for the files to read in each repository.', example: 'Read the Makefile before package.json.' },
  assess: { writes: 'It writes assess/assessment.md.', use: 'Good for what makes a finding matter in this project.', example: 'Say whether the finding touches billing code.' },
  ask: { writes: 'It writes no file, only the answer.', use: 'Good for how the answers read.', example: 'Answer in Spanish, and keep file names as they are.' },
};

// The runs that are passes and not phases: no stage, no thread, no session anybody continues. Each
// has its own run row, so its cost shows, and the board and the threads skip it.
export const PASSES: readonly string[] = ['extract-summary', 'commit-message', 'thread-title'];
export const isPass = (phase: string): boolean => PASSES.includes(phase);

// The run behind a message in an Ask discussion: a read-only session that answers a question about
// its card. Like a pass it has no stage, and it never speaks for its card, so the
// card's state, pips, trail and newest run all leave it out. Its cost still counts.
export const ASK_PHASE = 'ask';

// The stored key is shown when nothing names it, which is a phase this version does not know.
export const phaseLabel = (phase: string): string => PHASE_LABELS[phase] ?? phase;

// The preset names people read, as a card's Settings tab shows them. The preset stored as `default` is
// named Balanced. Here and not in the UI package, because the server checks a saved
// preset's name against them and plain Node cannot load the UI package's Svelte files.
const PRESET_LABELS: Readonly<Record<string, string>> = { light: 'Light', default: 'Balanced', heavy: 'Heavy' };
export const presetLabel = (preset: string): string => PRESET_LABELS[preset] ?? preset;
// A built-in preset with the engine it runs on, "Heavy on Cursor", as Settings, Models and a card's
// Settings tab both name it. Null, a machine with no login, names the preset alone.
export const presetTitle = (preset: string, engine: EngineName | null): string =>
  engine === null ? presetLabel(preset) : `${presetLabel(preset)} on ${ENGINE_LABELS[engine]}`;

// Every project delivers through pull requests. The type and the setting stay, so the callers that pass a flow do not change.
export type DeliveryFlow = 'pull-request';

export interface Stage {
  id: string;
  label: string;
  role: StageRole;
  // Entering this stage with a forward move starts this phase.
  phase?: DeliveryPhase;
  // The stage a card moves to on its own when this stage's phase completes.
  advanceOn?: string;
}

export interface Board {
  kind: BoardKind;
  stages: readonly Stage[];
}
