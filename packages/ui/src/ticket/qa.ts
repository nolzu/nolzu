import { type RunState, type StackState, TAKEN_DOWN, type Verdict } from '@nolzu/protocol';

/**
 * The rules behind the two QA panels of the ticket page.
 *
 * Everything the panels show is worked out here, so the component only draws. The page gathers the
 * raw parts: the newest QA run of the card, the card's stack row (the app line), what the card's own
 * Status commands printed, the card the stack lane holds, and the files the run left in the card folder.
 * Nothing is read or fetched here, and nothing here parses the status output.
 */

export interface QaRunInput {
  id: number;
  state: RunState | null;
  // Null on a run that printed no verdict line, and on one that never got that far. The reason
  // tells the two apart: the loop writes a sentence for the first and nothing for the second.
  verdict: Verdict | null;
  verdictReason: string | null;
}

export interface StackStatusInput {
  // The status command as it ran, so a person can see which line produced this.
  command: string;
  code: number;
  // Everything the command printed, stdout and stderr. Shown as it is. Nolzu never knows what the
  // stack is, so reading this would be guessing.
  output: string;
  timedOut: boolean;
}

export interface QaInput {
  cardKey: string;
  // The newest QA run of this card, or null when QA never ran here.
  run: QaRunInput | null;
  // The card's stack, as the last run or the last button left it. Null when nothing touched it.
  stack: { state: StackState; reason: string | null } | null;
  hasLoad: boolean;
  hasUnload: boolean;
  hasStatus: boolean;
  // What the status command printed, or null when it did not run.
  status: StackStatusInput | null;
  // Why the status command did not run although the project has one, or null.
  statusProblem: string | null;
  // True while the status command runs and its answer is on its way to the page.
  statusPending?: boolean;
  // The card the stack lane holds, from the board snapshot. One QA run at a time owns the stack.
  stackLane: string | null;
  // The QA report in the card folder, as a path inside it, or null when the run wrote none.
  report: string | null;
  // What the report says, for its checklist. Null or left out when there is none to read.
  reportText?: string | null;
  // The screenshots the run took, read out of the card folder. Empty when the project points at no
  // browser config, or when the run judged nothing by looking at a page.
  screenshots: readonly { path: string; name: string }[];
  // Whether the project points at a browser config. It tells the two empty cases apart: a project
  // that cannot take a screenshot yet, and a run that took none.
  hasBrowser: boolean;
  // The start command the app line names, when the card has one own start. Null or left out otherwise.
  loadCommand?: string | null;
  // The card's own commands, each with the name the line gives it (the repository, or `app`), in the
  // order Start runs them. Left out or empty when the card has none.
  apps?: readonly { name: string; start: string }[];
}

export type StackAction = 'load' | 'unload' | 'force';

export interface StackButton {
  action: StackAction;
  label: string;
  // Why pressing it would do nothing, or null when it can be pressed. Shown as the button's title,
  // so a person reads the rule instead of finding a button that refuses.
  refused: string | null;
  // What the button does, for the one whose name does not say it. Shown as the title when the
  // button can be pressed.
  note: string | null;
}

export interface StackPanelView {
  state: StackState;
  // The card's own commands the buttons act on, in order. Empty when it has none.
  apps: readonly { name: string; start: string }[];
  // The sentence under the state, or null when the state says it all.
  reason: string | null;
  // The status command's own words, never parsed. Null when it printed nothing or did not run.
  status: string | null;
  // The one line about the status, or null when the output speaks for itself.
  statusNote: string | null;
  // The status command as it ran, or null when none ran.
  command: string | null;
  // True while the status command runs. The panel draws a grey line, and no status sentence yet.
  pending: boolean;
  buttons: StackButton[];
  // The stack line of a QA FAIL: the state as its pill says it, the one sentence beside it, and the
  // buttons that fit the state.
  word: string;
  said: StackSaid | null;
  fits: StackAction[];
}

// A sentence with the stack command in it, set apart so the page draws the command as code. The text
// and the tail carry their own spaces, because the markup trims a space at the edge of a block.
export interface StackSaid {
  text: string;
  command: string | null;
  tail: string;
}

export interface VerdictPanelView {
  // Null when the run printed none, and on every state before a verdict.
  verdict: Verdict | null;
  reason: string | null;
  // What to say when there is no verdict to show, or null when there is one.
  note: string | null;
  // The run the panel is about, for the link to its log. Null when QA never ran.
  runId: number | null;
  report: string | null;
  // Section 2 of the report, as rows or as text, and null when the report has no section 2.
  checklist: QaChecklist | null;
  screenshots: readonly { path: string; name: string }[];
  // Why there are no screenshots, or null when there are some.
  screenshotNote: string | null;
}

export interface QaView {
  cardKey: string;
  stack: StackPanelView;
  verdict: VerdictPanelView;
}

// The exact words the card page gives a project that writes no status command. They open the
// sentence the stack line says, so they start with a capital.
export const NOT_REPORTED = 'Not reported';

// What the buttons and the line say about a card with no own commands.
const NO_OWN = 'No repository of this card has its own start commands.';

// The states a stack command is in the middle of. A second command on top of one of these would
// race the first one over the same containers.
const BUSY_STATES: readonly StackState[] = ['loading', 'unloading'];

// The run states that are not over yet. A verdict cannot exist while the run is in one of them.
const GOING: readonly RunState[] = ['queued', 'waiting_lane', 'waiting_review', 'running', 'retrying'];

// A project with no status command has nothing on its way, whatever the flag says.
const pendingOf = (input: QaInput) => input.hasStatus && input.statusPending === true;

function statusLines(input: QaInput): Pick<StackPanelView, 'status' | 'statusNote' | 'command'> {
  if (pendingOf(input)) return { status: null, statusNote: null, command: null };
  if (!input.hasStatus) {
    return { status: null, statusNote: `${NOT_REPORTED}. None of this card's own commands has a Status command.`, command: null };
  }
  if (input.statusProblem !== null) return { status: null, statusNote: input.statusProblem, command: null };
  if (input.status === null) return { status: null, statusNote: `${NOT_REPORTED}. The status command has not run yet.`, command: null };

  const output = input.status.output.trim();
  const command = input.status.command;
  if (input.status.timedOut) {
    return { status: output === '' ? null : output, statusNote: 'The status command was still running after the timeout, so it was stopped.', command };
  }
  if (input.status.code !== 0) {
    return { status: output === '' ? null : output, statusNote: `The status command exited ${input.status.code}.`, command };
  }
  return { status: output === '' ? null : output, statusNote: output === '' ? 'The status command printed nothing.' : null, command };
}

function buttons(input: QaInput, state: StackState): StackButton[] {
  // One QA run at a time owns the stack, and a hand action under a running check would make its
  // verdict meaningless. This refuses all three, Force included.
  const lane =
    input.stackLane === null
      ? null
      : input.stackLane === input.cardKey
        ? 'This card is running QA, which owns the app until it ends.'
        : `${input.stackLane} is running QA, which owns the app until it ends.`;
  const mid = BUSY_STATES.includes(state) ? "A start or stop of this card's app is already running." : null;

  return [
    {
      action: 'load',
      label: 'Start',
      refused: lane ?? mid ?? (input.hasLoad ? null : NO_OWN),
      note: null,
    },
    {
      action: 'unload',
      label: 'Stop',
      refused: lane ?? mid ?? (input.hasUnload ? (state === 'up' || state === 'failed' ? null : 'Nolzu has started no app for this card. Press Force to run the Stop commands anyway.') : NO_OWN),
      note: null,
    },
    {
      // Force is the same Stop with the state check dropped, for an app an earlier run left behind or
      // one that is running another card's code. `mid` is left out on purpose:
      // loading and unloading are the states a command that never came back leaves, and Force is
      // the only way out of them. The lane still refuses it, because that app belongs to a run.
      action: 'force',
      label: 'Force',
      refused: lane ?? (input.hasUnload ? null : NO_OWN),
      note: 'Runs the Stop commands, whatever the state says.',
    },
  ];
}

function verdictPanel(input: QaInput): VerdictPanelView {
  // An empty block reads as a run that found nothing to show, so the panel says which empty this
  // is: a project with no browser, or a run that judged nothing by looking at a page.
  const screenshotNote =
    input.screenshots.length > 0
      ? null
      : input.hasBrowser
        ? 'This run took no screenshots.'
        : 'No screenshots. QA takes them once a browser is set up for this project.';
  const checklist = input.reportText == null ? null : parseQaChecklist(input.reportText);
  const bare = { verdict: null, reason: null, runId: input.run?.id ?? null, report: input.report, checklist, screenshots: input.screenshots, screenshotNote };

  const run = input.run;
  if (run === null) return { ...bare, note: 'QA has not run for this card yet.' };
  if (run.verdict !== null) return { ...bare, verdict: run.verdict, reason: run.verdictReason, note: null };
  // A run that printed no verdict line. The loop stores its own sentence, which says the card
  // waits for a person, and that sentence is the panel's whole answer.
  if (run.verdictReason !== null) return { ...bare, note: run.verdictReason };

  // No verdict and no sentence: the run never reached the point of deciding.
  if (run.state !== null && GOING.includes(run.state)) return { ...bare, note: 'QA is running. The verdict comes when it ends.' };
  if (run.state === 'stopped') return { ...bare, note: 'The QA run was stopped, so it decided nothing.' };
  return { ...bare, note: 'The QA run ended before it decided anything. Its log says how far it got.' };
}

const STACK_WORDS: Record<StackState, string> = { off: 'Stopped', up: 'Up', loading: 'Starting', unloading: 'Stopping', failed: 'Failed' };
// Start on an app that is down, Stop and Force on one that is up, Start and Stop after a failed start,
// which may have left earlier repositories up, and Force alone while a command is in the middle,
// because Force is the way out of a command that never came back.
const FITS: Record<StackState, StackAction[]> = { off: ['load'], failed: ['load', 'unload'], up: ['unload', 'force'], loading: ['force'], unloading: ['force'] };

export function qaView(input: QaInput): QaView {
  const state = input.stack?.state ?? 'off';
  const reason =
    input.stack?.reason ?? (state === 'off' && !input.hasLoad ? `${NO_OWN} Add them in the QA question, or under Start the app in Settings, Project.` : null);

  const lines = statusLines(input);
  const command = input.loadCommand?.trim() || null;
  // The command goes in the sentence only where the data says it ran: a stack the QA run took down
  // again, or one that is up now. Any other sentence the row holds is said as it is.
  const said: StackSaid | null =
    command !== null && state === 'off' && reason === TAKEN_DOWN
      ? { text: 'Started with ', command, tail: ' for QA, stopped after.' }
      : command !== null && state === 'up' && reason === null
        ? { text: 'Started with ', command, tail: '.' }
        : (reason ?? lines.statusNote) === null
          ? null
          : { text: reason ?? lines.statusNote ?? '', command: null, tail: '' };
  return {
    cardKey: input.cardKey,
    stack: { state, apps: input.apps ?? [], reason, ...lines, pending: pendingOf(input), buttons: buttons(input, state), word: STACK_WORDS[state], said, fits: FITS[state] },
    verdict: verdictPanel(input),
  };
}

// The words a row of the QA checklist may carry, spelled as the qa skill teaches them.
export const QA_RESULTS = ['pass', 'fail', 'not reached'] as const;
export type QaResult = (typeof QA_RESULTS)[number];

export interface QaCheck {
  step: string;
  result: QaResult;
  // The run's own words. The skill asks for one on every fail; null when the run left it out.
  reason: string | null;
  // What the run did: the `How:` line under the row, or the `Ran:` line a report before `How:` wrote.
  // Null when it wrote neither.
  ran: string | null;
  // The `Evidence:` line: a file in `qa/evidence/` or the key output line. Left out when there is none.
  evidence?: string;
  // What should have happened and what did, under a fail. Fix it hands both to Implement.
  expected?: string;
  actual?: string;
  // The acceptance check of the brief the row comes from, such as `AC2`, taken off the front of the
  // step. Left out on a row with none, and on every row of a report written before the ids.
  ac?: string;
}

// Section 2 of `qa/report.md`. Rows when every line of it follows the skill's format, or the section
// as written when it drifted, so a report that does not parse still shows all it says.
export type QaChecklist = { rows: QaCheck[]; text: null } | { rows: null; text: string };

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
// The result comes first, so a colon inside the step cannot move the split.
const ROW = /^\d+[.)]\s+([^:]+):\s*(.*)$/;
const REASON = /^reason\s*:\s*(.*)$/i;
const RAN = /^(?:ran|how)\s*:\s*(.*)$/i;
// The lines under a row that are kept as they are, by their field name.
const KEPT = { evidence: /^evidence\s*:\s*(.*)$/i, expected: /^expected\s*:\s*(.*)$/i, actual: /^actual\s*:\s*(.*)$/i } as const;
// An acceptance check id at the front of a step, as the plan and qa skills write it: `AC2: ...`, and
// with the brief's level when a run copied it along: `AC2 (must): ...`.
const AC = /^(AC\d+)(?:\s*\((?:must|should)\))?\s*:\s*(.+)$/i;

// A step with the acceptance check id it starts with split off, or the step alone when it has none.
function splitAc(step: string): { ac: string | null; step: string } {
  const found = AC.exec(step);
  return found === null ? { ac: null, step } : { ac: (found[1] ?? '').toUpperCase(), step: (found[2] ?? '').trim() };
}

const isResult = (word: string): word is QaResult => (QA_RESULTS as readonly string[]).includes(word);

function sectionTwo(report: string): string | null {
  const lines = report.split(/\r?\n/);
  let level = 0;
  const start = lines.findIndex((line) => {
    const heading = HEADING.exec(line);
    if (heading === null || !/^(2\b|what qa checked)/i.test(heading[2] ?? '')) return false;
    level = heading[1]?.length ?? 0;
    return true;
  });
  if (start === -1) return null;
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => (HEADING.exec(line)?.[1]?.length ?? 7) <= level);
  return (end === -1 ? after : after.slice(0, end)).join('\n').trim();
}

export function parseQaChecklist(report: string): QaChecklist | null {
  const section = sectionTwo(report);
  if (section === null || section === '') return null;
  const drifted: QaChecklist = { rows: null, text: section };
  const rows: QaCheck[] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const row = ROW.exec(trimmed);
    if (row !== null) {
      const word = (row[1] ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
      const step = (row[2] ?? '').trim();
      // An unknown word is never a pass. The whole section goes back as text instead.
      if (!isResult(word) || step === '') return drifted;
      const split = splitAc(step);
      rows.push({ step: split.step, result: word, reason: null, ran: null, ...(split.ac === null ? {} : { ac: split.ac }) });
      continue;
    }
    // An indented line belongs to the row above it: its reason, or what was run and what came back.
    const last = rows.at(-1);
    if (last === undefined || !/^\s/.test(line)) return drifted;
    const reason = REASON.exec(trimmed)?.[1]?.trim();
    if (last.reason === null && reason) last.reason = reason;
    const ran = RAN.exec(trimmed)?.[1]?.trim();
    if (last.ran === null && ran) last.ran = ran;
    for (const [field, pattern] of Object.entries(KEPT) as [keyof typeof KEPT, RegExp][]) {
      const value = pattern.exec(trimmed)?.[1]?.trim();
      if (last[field] === undefined && value) last[field] = value;
    }
  }
  return { rows, text: null };
}

/**
 * The check a screenshot shows, read off the number the qa skill puts first in its name, as in
 * `2-api-stopped.png`. Null for a name with no number, and for a number the checklist has no row for.
 */
export function checkOfShot(name: string, checklist: QaChecklist | null): { number: number; step: string; result: QaResult } | null {
  const number = Number(/^(\d+)-/.exec(name)?.[1] ?? Number.NaN);
  const row = checklist?.rows?.[number - 1];
  return row === undefined ? null : { number, step: row.step, result: row.result };
}

// A reason this short sits beside the result on the row ("fail, empty list"). A longer one
// goes under the row.
const SHORT_REASON = 32;

/**
 * The result word of a checklist row, with a short fail reason beside it, and the line to put under
 * it: a reason that did not fit beside, else what the run did.
 */
export function checkWord(row: QaCheck): { word: string; under: string | null } {
  if (row.result === 'fail' && row.reason !== null && row.reason.length <= SHORT_REASON) return { word: `fail, ${row.reason}`, under: row.ran };
  return { word: row.result, under: row.reason ?? row.ran };
}

const COUNTED: Record<QaResult, string> = { pass: 'passed', fail: 'failed', 'not reached': 'not reached' };

/** The line over the checklist, as in "5 passed, 1 failed, 1 not reached". A result no row has is left out. */
export function checkCount(rows: readonly QaCheck[]): string {
  return QA_RESULTS.map((result) => [rows.filter((row) => row.result === result).length, COUNTED[result]] as const)
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(', ');
}
