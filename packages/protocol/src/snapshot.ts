import type { BoardKind, CardState, DeliveryFlow, DeliveryPhase, StageRole } from './board.ts';
import type { Estimate } from './estimate.ts';
import type { Effort, RunState } from './run.ts';
import type { QuestionOption, Verdict } from './sentinels.ts';

// What a forward drop onto this stage would start. The model and the effort come from the
// same resolver that builds the job, so the drop label and the run can never disagree.
// A stage that starts no phase carries none of this, which is how merge and PR watch read.
export interface StartsDescriptor {
  phase: DeliveryPhase;
  model: string;
  effort: Effort;
  // `gone` is a stored model the engine stopped offering. `no-profile` is a row pointing at a
  // login this machine does not hold, which is a different problem with a different fix, and
  // folding the two made the board blame the model for a missing login. `vendor` is a row whose
  // profile runs a vendor that cannot run this phase at all, which no model and no login repairs.
  modelState: 'ok' | 'gone' | 'no-profile' | 'vendor';
  // Why that vendor cannot run this phase, set with the `vendor` state and null otherwise. The
  // sentence travels rather than the rule, because the rule lives in core and the board components
  // read only this package.
  refusal: string | null;
  // The profile the row runs on, so a refusal can name it. The board prints it only when more
  // than one profile is configured.
  engine: string;
  // True when more than one engine profile is configured, so the drop box names the profile and not
  // only its engine. Optional, so a descriptor built before it still reads as one profile.
  severalProfiles?: boolean;
  // What the start will likely cost and take. Absent when nothing measured it, and on a row that
  // starts no run. Optional, so a descriptor built before it existed still reads.
  estimate?: Estimate;
}

export interface StageView {
  id: string;
  label: string;
  role: StageRole;
  count: number;
  // Text such as "every 25 min, Mon to Fri", for an auto stage only.
  cadence: string | null;
  starts: StartsDescriptor | null;
  // The line under the name of a person's or an auto column, such as "you pick what goes next".
  // Optional, so a board built without it, such as the hub's, still reads and draws no line.
  says?: string;
}

// What the reviews on a pull request add up to. Three words and no fourth: GitHub answers nothing
// at all while nobody has reviewed, and a card that showed nothing there would read as a pull
// request nobody has to look at.
export type PullDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

// The pull request half of a card on the PR reviews board, or of a Delivery card whose pull request
// PR watch found. Null on every other card.
export interface PullView {
  // The login that opened it. Null when the answer carried none, such as an account that is gone.
  author: string | null;
  decision: PullDecision;
  // The head commit time, as a timestamp and never as an age. The browser counts, the same way it
  // counts a run.
  headCommittedAt: string | null;
  draft: boolean;
  // The last review round a run wrote on the card. Null before the first, so the card says there has
  // been no round rather than printing 1 as if one had happened.
  round: number | null;
  // How many commits the author pushed since that round read the head, at least 1 once the head moved.
  // Only Read pull requests sees a push, so this is as fresh as the last read. Left out while the
  // head is the one the round read, before any round, and on a board that does not know, such as one
  // built from what the hub holds.
  newCommits?: number;
  // Set when the pull request closed or merged after its card was made. Absent while it is open, and
  // on a board that does not know, such as one built from what the hub holds.
  ended?: 'closed' | 'merged';
}

// One reason a pull request cannot merge, as `mergeBlockers` in core reads it off GitHub's answer.
// `base` is the branch it goes into, null when the answer did not name it. `url` is the pull request.
export type MergeBlocker =
  | { kind: 'checks'; failed: readonly { name: string; url: string | null }[] }
  | { kind: 'conflict'; base: string | null }
  | { kind: 'behind'; base: string | null }
  | { kind: 'approval' }
  | { kind: 'changes' }
  | { kind: 'draft' }
  | { kind: 'unknown' }
  | { kind: 'blocked'; url: string | null };

// What one read of a pull request said about its merge. Running checks hold the merge too, but they
// end by themselves, so they are a state and no reason.
export interface MergeRead {
  blockers: readonly MergeBlocker[];
  running: boolean;
}

// A GitHub Actions job, as the link of its check run names it. The ids stay text, because nothing
// counts with them and a long one must not lose digits.
export interface ActionsJob {
  owner: string;
  repo: string;
  run: string;
  job: string;
}

const JOB_LINK = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/actions\/runs\/(\d{1,20})\/job\/(\d{1,20})(?:[?#].*)?$/;

/**
 * The GitHub Actions job a failed check of the pull request in `repo` (owner/name) links to, or null for
 * any other link: a commit status, another app's check, a link with no job in it, or a job of another
 * repository. Nolzu reads a log only by these ids and never guesses one.
 */
export function actionsJob(url: string | null, repo: string): ActionsJob | null {
  const found = url === null ? null : JOB_LINK.exec(url);
  if (found === null) return null;
  const [, owner = '', name = '', run = '', job = ''] = found;
  // Only the pull request's own repository, a name GitHub gave, so no link can aim the read elsewhere.
  if (`${owner}/${name}`.toLowerCase() !== repo.toLowerCase()) return null;
  return { owner, repo: name, run, job };
}

// The card as the board draws it. There is no elapsed number and no ticking cost here: the
// run start travels instead and the browser counts, so a running agent does not produce a
// snapshot every second.
export interface CardView {
  key: string;
  title: string;
  stage: string;
  state: CardState;
  queuePosition: number | null;
  runId: number | null;
  runState: RunState | null;
  // The phase of that newest run, so a stopped run can be started again only in the stage that ran it.
  // Absent where a card view is built by hand.
  runPhase?: string | null;
  runStartedAt: string | null;
  lane: string | null;
  engine: string | null;
  model: string | null;
  effort: Effort | null;
  // The newest run's cost, and every run of the card added up as the card page adds them, passes and
  // Ask included. The board draws the total and names the newest in its title.
  costUsd: number | null;
  totalUsd: number | null;
  question: string | null;
  // The answers the agent offered with that question, for Now and the card page to draw as buttons.
  // Left out when it offered none, which is every run from before the options. Optional, so a
  // sender built before it still reads; the hub frame carries no options.
  questionOptions?: readonly QuestionOption[];
  failureReason: string | null;
  minimized: boolean;
  // What the newest run decided, when that run was QA. Null on every other run, so the chip goes
  // as soon as the card runs something else, which is right: the verdict was about the work as it
  // stood then.
  verdict: Verdict | null;
  verdictReason: string | null;
  // What the output check found in the files of the newest run. Left out at none, on a run that was
  // not checked and on a closed card. The chip says it in a few words (`checkWords`), and the card
  // page lists them.
  outputProblems?: readonly { file: string; problem: string }[];
  // The review comments on a Delivery card's pull requests, in counts: rows triage wants fixed that are
  // not fixed yet, and rows with a message not seen on the PRs tab. Left out at none of either, on a
  // closed card and on every other board. Local only: the hub frame is built apart and never has it.
  feedback?: { toFix: number; unread: number };
  // Why the open pull requests of a Delivery card from Review to Wrap-up cannot merge, as the last read
  // stored it, in the order the chip names them. Left out when nothing blocks or nothing was read.
  blockers?: readonly MergeBlocker[];
  // Set on a card made from a pull request or with one PR watch found, and null on every other card.
  pull: PullView | null;
  // What each phase starts on for this card, when the card stores models of its own. Null when it
  // follows the project, and the stage's own `starts` then holds.
  starts: Partial<Record<DeliveryPhase, StartsDescriptor>> | null;
  // The tasks of an epic: the Delivery cards linked to it, and how many of them are closed. Set on
  // an Epics card that has at least one, and null on every other card, so a card with no tasks
  // draws no count rather than reading as 0 of 0. On an epic in In delivery the total also counts
  // each step of its plan not added to Delivery yet.
  delivered: { done: number; total: number } | null;
  // The linked Delivery cards behind `delivered`, oldest first, each with its state. Read from the
  // links and never from text, so each chip on the epic card opens the card it names. Optional, so a
  // sender built before it still reads.
  tasks?: readonly EpicTask[];
  // An epic in In delivery whose every task is done. It does not move on by itself, because the next
  // column starts an agent, so it waits on the person. Absent on every other card.
  finished?: boolean;
  // A card "Learn and then start" holds: the column it moves to once Learn your repositories ends, the
  // repository a Learn run reads now (null between two), and when the person pressed. Absent on every
  // other card. Local only, as `feedback` is.
  afterLearn?: { column: string; repo: string | null; since: string };
}

// One task of an epic: a Delivery card linked to it, its state there, and whether it is closed.
export interface EpicTask {
  key: string;
  title: string;
  state: CardState;
  done: boolean;
  // The plan step the task was made from, when the epic's table added it. Left out on a task linked by
  // hand or added before the link kept it, which then matches its step by title.
  step?: string;
}

/**
 * Each step of an epic's plan with the linked task it became, or null for a step not added yet. Matched
 * by the step the link kept, and by title when it kept none, because the person may retitle a task
 * before adding it. One task answers one step at most. The epic card's count and the epic page's task
 * table both read this, so the two agree.
 */
export function matchPlan<T extends { key: string; title: string; step?: string }>(planned: readonly string[], linked: readonly T[]): (T | null)[] {
  const used = new Set<string>();
  return planned.map((step) => {
    const task = linked.find((one) => !used.has(one.key) && (one.step ?? one.title).trim() === step.trim()) ?? null;
    if (task !== null) used.add(task.key);
    return task;
  });
}

// What moving this card into the stage starts: the card's own value over the stage's.
export function cardStarts(stage: StageView, card: Pick<CardView, 'starts'> | null): StartsDescriptor | null {
  if (stage.starts === null) return null;
  return card?.starts?.[stage.starts.phase] ?? stage.starts;
}

export interface LaneView {
  name: string;
  heldBy: string | null;
  // The registry id of the project whose card holds the lane, when that is not this board's project.
  // Lanes belong to the machine and card keys repeat across projects, so the key alone could read as
  // this board's card. Left out when the holder is this board's own, or nothing holds the lane.
  project?: number;
}

export interface SlotMeter {
  busy: number;
  total: number;
}

// Board wide, and free of transcript text and filesystem paths, so the same shape can go to
// the hosted server later without carrying code or a machine's layout with it.
export interface BoardSnapshot {
  version: number;
  kind: BoardKind;
  flow: DeliveryFlow;
  stages: readonly StageView[];
  cards: readonly CardView[];
  slots: SlotMeter;
  lanes: readonly LaneView[];
  // How long a run may print nothing before its card reads Quiet. Board wide, from the settings.
  // Absent on a board that knows nothing of a run's output, such as one built from what the hub holds.
  quietAfterMs?: number;
}

/**
 * What a running agent did last, read off its own stream.
 *
 * The line names files and commands, so it is never part of a snapshot, a run row or anything the
 * hub reads. It lives in the local process's memory and travels as the board stream's own
 * `activity` event, one small frame per engine event instead of a whole board.
 */
export interface RunActivity {
  runId: number;
  cardKey: string;
  // The last tool action as one line, such as "Reading src/recipes/list.ts". Null until the run
  // uses a tool.
  line: string | null;
  // When the run last printed anything, in milliseconds since the epoch. Quiet counts from here, in
  // the browser, so the count goes on with no new event.
  outputAt: number;
}

/**
 * The output check's problems in a few words for the board card's chip, and in full for its title and
 * a screen reader. "summary missing" names the file without its folder and extension. Problems of
 * one kind in several files are counted ("2 files missing"), and a mix is counted by file.
 */
export function checkWords(problems: readonly { file: string; problem: string }[]): { short: string; full: string } {
  const name = (file: string) => file.split('/').at(-1)?.replace(/\.md$/, '') ?? file;
  const files = [...new Set(problems.map((one) => one.file))];
  const all = (said: string) => problems.every((one) => one.problem === said);
  const kind = all('The file is missing.') ? 'missing' : all('The file is empty.') ? 'empty' : null;
  const count = problems.length === 1 ? '1 problem' : `${problems.length} problems`;
  const short =
    kind !== null
      ? files.length === 1 ? `${name(files[0] ?? '')} ${kind}` : `${files.length} files ${kind}`
      : files.length === 1 ? `${name(files[0] ?? '')}, ${count}` : `${files.length} files, ${count}`;
  return { short, full: problems.map((one) => `${one.file}: ${one.problem}`).join(' ') };
}
