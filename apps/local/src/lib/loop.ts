import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { boardFor, chainTo, checkedPaths, type QaApp, outputCheck, EXTRACT_SUMMARY_POLICY, foldRun, isAction, isAskThread, isDeliveryPhase, isFeedbackRef, type ModelAction, modelsForPick, type ModelsByVendor, NO_REPOSITORY, policyFor, presetModels, READ_GIT_COMMANDS, projectRepos, repoKnowledgePath, repositoriesLine, resolveKnowledgeDir, resolveModels, type ResolvedTable, type Scheduler, smallChain, startsInCardFolder, startsLabel, vendorRefusal, type WallState } from '@nolzu/core';
import { assessScoutFinding, beginFix, beginFixAll, fixedSinceQa, lastJudgedQa, reopenFixed, writeSetting, boardOfCard, boardSnapshot, bumpVersion, cardBase, cardDiscussions, cardPullRows, endFix, cardModels, cardPreset, epicOfTask, FIRST_PROJECT, getSetting, markRunning, NOT_A_PASS, openDatabase, cardHolds, saveOutputCheck, openProject, pendingKnowledgeChanges, projectFiles, projectOutsideGit, projectProfiles, type PullHead, registeredProjects, recordKnowledgeChanges, recoverRuns, recordMove, reposOfCard, resolveDataDir, savePullRound, seenHead, sessionFolder, sessionInCardFolder, setCardTitle, returnedKnowledgeNote, saveQuestionOptions, saveReadOnlyBreak, clearReadOnlyBreaks, otherRunOfCard, saveCommitWarning, saveRun, saveStackStatus, saveVerdict, scoutFinding, setCardRepos, setCardStack, startRun, startWriting } from '@nolzu/core/node';
import { ASK_PHASE, assessKey, CLOUD_OPEN, cardStarts, DEFAULT_PROFILE, findingOfKey, isBoardKind, isFakeMode, isMaintenanceKey, isPass, isResearchKind, KB_MAINTENANCE_KEY, learnRepoKey, missingProfileText, parseQuestionOptions, phaseLabel, QUESTION_FILE, refinedTitle, repoOfLearnKey, type Board, type BoardKind, type BoardSnapshot, type CardSize, type DeliveryPhase, type EngineName, type Job, type ReadOnlyBreak, type RunActivity, type RunEvent, type RunnerMessageType, type StackState, type WallKind } from '@nolzu/protocol';
import { activityLine, type AppServer, makeCardFolder, readCardText, removeCardFile, stripSharedAttribution, writeCardFile, askPrompt, type AwakeDeps, browserLine, buildPrompt, cardFileKind, checkKnowledgeDir, checkoutPath, checkoutRoot, commitAt, commitKnowledge, ENGINES, ensureWorktree, epicDocPaths, FROM_EPIC_FILE, extractVerdict, makeQaCopy, qaCopyPath, qaCopyRoot, removeQaCopy, sweepQaCopies, sweepRemovals, worktreesFolder, ghRunner, git, gitAfter, gitBefore, gitEnv, recordedRepos, type GitSnapshot, GUARD_PATH, guardSettings, type HeldKnowledge, holdAwake, holdKnowledge, isPlainName, knowledgeChanges, knowledgeDiffs, knowledgeGit, knowledgeState, noteInRunLog, ownSandbox, personsSkillEdit, phaseInstructionsFile, processStart, pickKnowledge, PROGRESS_FILE, readFirstPaths, readPhaseInstructions, renameFreshBranch, repoFolder, resolvedPath, mcpRunsFolder, restoreCursorMcp, resumeJob, resumeMessage, type RunGh, type RunGit, runJob, runStackHook, runWithRetries, selectEngine, serversLine, stackCommand, stackNotes, swapPromptLine, sweptAfter, type StackHook, STACK_TIMEOUT_MS, STACK_UNLOAD_TIMEOUT_MS, stackStatusAfter, installApp, installCommand, startApp, stepsDone, systemAwake, appWall, wallHere, wallKind, type Engine, type Keychain } from '@nolzu/runner';
import { phaseInstructions, threadTitlePrompt } from '@nolzu/skills';
import { error } from '@sveltejs/kit';
// The drop's own writer, so a chained start takes the path and the refusals a drop takes.
import { moveTo } from '../routes/api/board/writes.ts';
import { cardBranch, cardCheckouts, templateBranch } from './checkout.ts';
import { chosenProject, damagedDatabase, openFirstThatOpens, standInOf } from './db.ts';
import { commentsOf } from './diff-comments.ts';
import { addMessage, answerOf, cleanSubject, messagesIn, recordPhaseSummary, saveSubject, THREAD_TITLE, wantsSubject } from './discussion.ts';
import { saveLimit } from './engine-limits.ts';
import { applyTriageFile, fixAllMessage, FIXES_FILE, fixFeedbackMessage, isOpen, readFixNotes, writeFeedbackFile } from './feedback.ts';
import { type Checkout, type Heads, readHeads, runMoved } from './fix-check.ts';
import { fixMessage } from './fix-it.ts';
import { failedFixes, keepReport, qaFixesMessage } from './qa-fixes.ts';
import { sendToTeamHub } from './hub-link.ts';
import { learnAsking } from './knowledge-learn.ts';
import { knowledgeFiles, knowledgeIndexFiles } from './knowledge-page.ts';
import { fillAllowedCommands } from './onboard.ts';
import { noteMaintenanceFailure, noteRunEnd } from './notifications.ts';
import { keepHeld } from './knowledge-review.ts';
import { planSteps } from './overview.ts';
import { originRepo } from './create-card.ts';
import { readPrHead, writePrDiff } from './pr-diff.ts';
import { cardStackEnv } from './qa-panel.ts';
import { releaseAll, releaseHeld } from './stack-action.ts';
import { answerFor, type OwnApp, ownFolder, ownStarts, PLAYWRIGHT_FILE, qaReposOf, scriptsChanged } from './qa-setup.ts';
import { roundsIn } from './review.ts';
import { cardHistory, personsWords } from './persons-words.ts';
import { linkOpenPulls, rereadOpenPulls, unlinkedCards } from './pull-list.ts';
import { lineNow, sendBackMessage } from './send-back.ts';
import { followLearn, withAfterLearn } from './setup.ts';
import { type SharedScheduler, sharedScheduler } from './shared-scheduler.ts';
import { recordSummary, said } from './summary.ts';
import { inTurn } from './manifest.ts';
import { appKeychain, commitMcpList, cursorMergesHere, flushMcpCommit, mcpNames, migrateQaBrowser, promptMcp, runMcp, sweepMcpRuns } from './mcp-store.ts';
import { namedIssues, withNamedIssues } from './named-issues.ts';

export interface Loop {
  db: DatabaseSync;
  // The project's id in the machine's registry, which the hub link puts on every frame about it.
  project: number;
  // The directory this loop's run files live in, which is the data folder for the first project
  // (`projectFiles`). The Knowledge screen reads the kept copy of a change that waits for review from there.
  dataDir: string;
  // The board one card belongs to. Stage ids repeat across boards, so a caller that takes a card's
  // stage has to take it against that card's own board or it answers about another board's columns.
  boardOf: (key: string) => Board;
  // The adapter of the profile every row with none of its own falls back to. In fake mode it is
  // the one fake engine every vendor's adapter is made from, which is the object the smoke run and
  // the tests replace the spawn of. Outside fake mode a real adapter is built for each read, so
  // nothing set on it lasts.
  engine: Engine;
  // What each vendor offers today, by vendor. The screens read it, so a row is measured against
  // the list of the profile it names and never against another vendor's.
  models: () => ModelsByVendor;
  // This project's view of the one scheduler every project shares: its own runs in the queue, the
  // machine's slots and lanes.
  scheduler: Scheduler;
  // The board a screen asks for. Delivery when nothing is named, which is what every caller that
  // reads only the queue lanes off it wants.
  snapshot: (kind?: BoardKind) => BoardSnapshot;
  // `onProfile` pins the job to one profile, which is what a resume does: the model is then
  // resolved under the login that holds the session. `onModel` is the model a message carries,
  // which wins over what the table says.
  buildJob: (key: string, phase: ModelAction, runId: number, file?: string | null, onProfile?: string | null, onModel?: string | null, resumed?: string | null) => Job;
  // Makes the run row and hands the job to the scheduler. It does not wait for the run: the move
  // that triggers it answers as soon as the job is queued, or the board follows the click for as
  // long as an agent takes.
  start: (key: string, phase: DeliveryPhase) => boolean;
  // Starts a knowledge maintenance run that rewrites one knowledge file, named relative to the
  // knowledge folder. It belongs to no card, so it throws the reason rather than writing it on a
  // card nobody can look at.
  optimize: (file: string) => boolean;
  // Starts Learn this project, which reads what people wrote, asks the person, and writes a few
  // knowledge files that always wait for review. `repo` names a repository to start with, the one
  // Add a repository added. It belongs to no card, so it throws the reason as optimize does.
  learn: (repo?: string) => boolean;
  // Starts Learn your repositories: one read-only run per repository named, each under a key of its
  // own, which the knowledge lane runs one after another. Every job is built before any starts, so a
  // refusal starts none and throws the reason. Answers how many runs were queued.
  learnRepos: (repos: readonly string[]) => number;
  // Starts a read-only assessment of one Scout finding. It belongs to no card either, so it throws
  // the reason the way optimize does, and it moves the finding to the assessment column only once
  // the run has started.
  assess: (findingId: number) => boolean;
  // Continues a blocked card's session with the person's answer, as a new run, and the session of a
  // Learn this project run that asked, under the reserved key. Throws, and writes nothing, when there
  // is no question to answer. False when the run could not start, and the card
  // is then failed with the reason, so it can be moved again.
  answer: (key: string, text: string) => boolean;
  // Continues a discussion thread's own session with a person's message, as a new run. The profile
  // comes off the thread, which read it off the run row, so a card whose action table changed
  // still continues on the login that holds the session. In an Ask discussion it starts or continues
  // a read-only session that answers in the thread and leaves the card as it is.
  discuss: (
    key: string,
    thread: { id: string; sessionId: string | null; engine: string | null },
    text: string,
    model?: string,
  ) => boolean;
  // Starts the phase of a failed card's stage again, fresh. Throws, and writes nothing, unless the card
  // is failed in a stage that starts a run. False as for answer.
  //
  // `onProfile` is the "Run on" click: the same phase on another login, which is always a fresh
  // run, because a session belongs to one profile. The checkout is not touched, so the run goes on
  // from the plan, the progress file and the changes the stopped run left there.
  retry: (key: string, onProfile?: string | null) => boolean;
  // Fix it after a QA FAIL: moves the card back to Implement, goes on in the
  // implement session with QA's reason and the failed screenshot (a fresh run when there is no
  // session), and starts QA once that run ends ready. One press is the consent for both runs. A stop,
  // a failure or a question in Implement ends it there, with no QA. Throws, and writes nothing, unless
  // the card's newest run is a QA FAIL. False as for answer.
  fix: (key: string) => Promise<boolean>;
  // Send back with comments: moves a ready or idle card in Implement or after it back to Implement and
  // goes on in the implement session with every open diff comment, by Fix it's path, with no QA after.
  // On a start the comments get their sent time; a refusal or a failed start leaves them open. Throws,
  // and writes nothing, with no open comment or a card that cannot go back. False as for answer.
  sendBack: (key: string) => Promise<boolean>;
  // Run triage on a Delivery card's PRs tab: a read-only run of the feedback phase on the card where
  // it sits, over every open discussion of its pull requests. The comments go into the card folder
  // before the engine starts, and the verdicts are applied to the rows when it ends ready. Throws, and
  // writes nothing, for a card that is not on Delivery, one a run or a question still holds, or one
  // with no open discussion. False as for answer.
  triage: (key: string) => boolean;
  // Fix on a discussion row of the PRs tab: the card's newest implement session goes on, in the card's
  // checkout and on the column where the card sits, with that discussion and its triage, told to edit
  // and stop. The row is fixing from the press, fixed with a one line note when the run ends ready, and
  // new with the reason when it fails or is stopped. A run that asks leaves the card blocked and the
  // row fixing, and `answer` goes on with the same fix. Like a triage it is a side run: when it ends
  // the card is back in the state it had. One fix at a time per card. Throws, and writes nothing, for a
  // card that is not on Delivery, one a run or a question holds, a done row, or while a fix runs. False
  // when the start failed, and then the row says why.
  fixFeedback: (key: string, ref: string) => boolean;
  // Fix all on the PRs tab: one Fix over every row triage wants fixed that is new. The run writes a
  // line per row in `feedback/fixes.md`, which is each row's note; a row with no line goes back to new.
  // Otherwise as `fixFeedback`, and refused the same way, also when no such row is left.
  fixAll: (key: string) => boolean;
  // QA the fixes on the PRs tab: a QA run, fresh, over the rows fixed since the last QA with a PASS or
  // FAIL, told to keep the rows the fixes do not touch and add one per fixed comment. Like a triage it
  // is a side run: the card stays where it is, chains nothing, and goes back to the state it had. A FAIL
  // sends the failed rows back to new with QA's reason. Throws, and writes nothing, for a card that is
  // not on Delivery, one a run or a question holds, a done card, or one with nothing fixed since its
  // last QA. False when the start failed, and its run on the Log tab says why.
  qaFixes: (key: string) => boolean;
  // Asks the engine for a commit message, from a prompt the caller built out of the card's change. The
  // engine and the model are the plain summary's row, the light pass every project already has. It is
  // a pass and not a card run: it has its own run row, so its cost shows on the Log tab, and it never
  // takes a slot or moves the card. It starts in the checkout of the one repository the message is
  // for. Answers with what the engine said, or the reason it did not run.
  writeMessage: (key: string, prompt: string, signal?: AbortSignal, repo?: string) => Promise<{ ok: true; answer: string; model?: string; cost?: number | null } | { ok: false; reason: string }>;
  // Stops a run and closes its row. Only startJob writes the end of a run, and a job still waiting
  // for a slot never gets there, so this writes that end itself.
  stop: (runId: number) => void;
  // A knowledge change was approved or returned. A card's wrap-up that waited for it starts now, once
  // no change waits any more.
  reviewAnswered: () => void;
  // Ends every card waiting for a review as stopped, at a clean stop of Nolzu.
  stopWaiting: () => void;
  // Ctrl+C, for every project of the data folder: every run in the shared queue stops through its own
  // project's `stop`, as a Stop press stops it, and so do the Ask runs and commit message passes outside
  // it. Resolves once the queue's runs and the Ask runs have ended and written their stop, so the next
  // start reads them as stopped.
  shutdown: () => Promise<void>;
  // Returns the way to stop listening. A stream that closed must be dropped, or the next change
  // writes to a response nobody is reading and throws inside whatever caused the change.
  onChange: (listen: () => void) => () => void;
  // How many are listening, to changes and to activity. A stream that closed and did not leave is a
  // write into a response nobody reads, so the count is worth being able to assert.
  listeners: () => number;
  changed: () => void;
  // What each running job did last. A stream sends these after its first board, so a page opened in
  // the middle of a run shows the line at once and not at the run's next tool.
  activity: () => RunActivity[];
  // One run's last output and tool action, told on every engine event. It is kept apart from
  // onChange on purpose. A change moves the version, sends whole boards and makes the hub diff, and an
  // engine event costs none of that. Returns the way to stop listening, as onChange does.
  onActivity: (listen: (activity: RunActivity) => void) => () => void;
  close: () => void;
  // Looks for the open pull request of the Delivery cards that have none linked, or of one card now,
  // as after its push. Quiet: a failure says nothing and the next interval asks again.
  watchPulls: (key?: string) => void;
}

// What a maintenance run carries where a card's title and ticket text would be. It says it has no
// card, because the run reads it and the skill says the same.
const MAINTENANCE_TITLE = 'Optimize a knowledge file';
const MAINTENANCE_ASK = 'This run belongs to no card. Rewrite the one knowledge file named below, and change nothing else.';
// Learn this project, under the same reserved key. The repository it starts with is the one Add a
// repository added, and it goes into the text, because the run reads it there.
const LEARN_TITLE = 'Learn this project';
const learnAsk = (repo: string | null): string =>
  `This run belongs to no card. A person asked it to learn this project from what people wrote and from their answers.${repo === null ? '' : ` Start with the repository \`${repo}\`, which was added a moment ago.`}`;

// Learn your repositories, one run per repository under its own key. The text says which one, and the
// prompt names its folder and the two files it writes.
const learnRepoTitle = (repo: string): string => `Learn the ${repo === '.' ? 'project folder' : `${repo} repository`}`;
const LEARN_REPO_ASK = 'This run belongs to no card. A person asked it to learn one repository from its README, CI files and stack files.';

// A run whose key names no card row: the knowledge maintenance runs under their reserved keys, and an
// assessment under the key of the finding it is about. Both work in the project itself rather than in
// a checkout of their own, so both need the run guard, and neither gets a branch.
const belongsToNoCard = (key: string): boolean => isMaintenanceKey(key) || findingOfKey(key) !== null;

// A file this run wrote, or null. Second by second, because some file systems keep no finer time,
// and a file written in the run's first second still belongs to it.
// Read inside the card folder only, never through a link a run left there.
const writtenSince = (taskDir: string, path: string, since: number): string | null => {
  const file = join(taskDir, path);
  return existsSync(file) && statSync(file).mtimeMs >= Math.floor(since / 1000) * 1000 ? readCardText(taskDir, path) : null;
};

// On a project with several repositories, refine and plan pick the card's list. They read the
// project's own repositories to do it, so they make no checkout, and a list that plan corrects
// leaves none behind.
const picksRepos = (phase: string): boolean => phase === 'refine' || phase === 'plan';

// An Ask makes no checkout and needs no list: it reads what is there, the card's checkout once a run
// made it and the project before that, the way refine and plan start on several repositories.
const readsInPlace = (phase: string): boolean => picksRepos(phase) || phase === ASK_PHASE;

// Research and Investigate read the project to answer and change nothing, and their boards have no
// refine or plan to pick a list. So a card with no list reads in place, the way an Ask does, and so
// does its wrap-up, which writes the knowledge folder the way a maintenance run does. A card whose
// list a person picked still gets a checkout of just those repositories.
const readsUnlisted = (phase: string, board: string): boolean =>
  phase === 'research' || phase === 'investigate' || (phase === 'wrapup' && isResearchKind(board));

// What an Ask discussion says when its run ended with no answer, so a person never waits on nothing.
const noAnswer = (reason: string | null): string => `No answer came. ${reason ?? 'The run ended early.'} Its log is on the Log tab.`;

// How a Fix run ended, for its row: the first line of the plain summary as the note when it ended
// ready, else the reason it did not.
export function fixOutcome(record: { cardState: string; state: string; question: string | null; failureReason: string | null }, summary: string | null): { ok: true; note: string } | { ok: false; reason: string } {
  if (record.cardState === 'ready') {
    const line = summary?.split('\n').map((one) => one.trim()).find((one) => one !== '') ?? '';
    return { ok: true, note: line === '' ? 'The fix ended without a summary. Read its edits on the Changes tab.' : line };
  }
  if (record.state === 'stopped') return { ok: false, reason: 'The fix was stopped.' };
  // Only when the check after it found a commit or a push. Otherwise a fix that asks waits on its answer.
  if (record.cardState === 'blocked') return { ok: false, reason: `The fix asked: ${record.question ?? 'nothing it wrote down'}` };
  return { ok: false, reason: record.failureReason ?? 'The fix run ended without finishing. Its log is on the Log tab.' };
}

// An Ask run the boot's sweep closed never reached `answerIn`, so its discussion says why here. Only a
// run no message names yet, so the next boot adds nothing.
function sayCutOff(db: DatabaseSync): void {
  const cut = db
    .prepare(
      `SELECT id, card_key, thread, error FROM runs WHERE phase = ? AND thread IS NOT NULL AND state = 'interrupted' AND card_key IN (SELECT key FROM cards)
       AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.run_id = runs.id AND messages.author = 'agent')`,
    )
    .all(ASK_PHASE) as { id: number; card_key: string; thread: string; error: string | null }[];
  for (const run of cut) addMessage(db, run.card_key, run.thread, 'agent', noAnswer(run.error), run.id);
}

// What an earlier run of this phase finished, from the file the skill keeps.
// A plain file only: a run may leave a named pipe there, and reading one would hold the whole app.
const progressOf = (taskDir: string, phase: string): string | undefined => readCardText(taskDir, join(phase, PROGRESS_FILE)) ?? undefined;

// A card on a board with no refine or plan is only told about its Settings tab.
const noRepoList = (key: string, board: Board): string =>
  board.stages.some((stage) => stage.phase !== undefined && picksRepos(stage.phase))
    ? `Nothing says which repositories ${key} changes yet. Run refine or plan on it, or pick them on its Settings tab.`
    : `Nothing says which repositories ${key} changes yet. Pick them on its Settings tab.`;

// One loop per project, cached by the data folder and the project. SvelteKit rebuilds this module on
// every hot reload, and a second loop over one database would start the same card twice.
const open = new Map<string, Loop>();
// The scheduler of each data folder, here beside `open` so a hot reload drops both together. Kept in
// shared-scheduler.ts, it would outlive the loops, and every rebuilt loop would be refused its place.
const schedulers = new Map<string, SharedScheduler>();

// How often the cards with no pull request linked are asked for one, and the linked open ones read
// again, and how long one ask may take.
// Limit: one gh document per twenty asks of each kind per interval; slow it down if a project holds many.
const PULL_WATCH_MS = 3 * 60_000;
const PULL_ASK_MS = 30_000;
// The registry id of each data folder's first project, so it keeps one cache key whether a caller
// names it by id or not. Two keys would mean two loops over one database.
const firstIds = new Map<string, number>();

// The loop of the project a route names, or of the current one (`chosenProject`). The first project's
// loop opens first, because it reads the machine and the first loop of a data folder is its boot.
//
// A current project that cannot open, such as one whose database is damaged, would stop every start
// of Nolzu, so the first project opens in its place, becomes the current one, and a line says why. A
// first project that cannot open has the next one that opens stand in for it (`openFirstThatOpens`). A
// route that names a project gets the reason instead.
export function loop(env: NodeJS.ProcessEnv = process.env, project?: number): Loop {
  const dataFolder = resolveDataDir(env);
  const first = firstLoop(dataFolder, env);
  const chosen = chosenProject(first.db, project).id;
  // The current project is the damaged first one, whose line `openFirstThatOpens` already said.
  if (project === undefined && chosen !== first.project && chosen === firstIds.get(dataFolder) && standInOf(dataFolder) === first.project) {
    writeSetting(first.db, 'currentProject', first.project);
    return first;
  }
  try {
    return createLoop(dataFolder, env, { project: chosen });
  } catch (error) {
    // Only a damaged file moves the current project. Anything else is said as it is.
    if (project !== undefined || !damagedDatabase(error)) throw error;
    console.error(`Project ${chosen} could not open (${(error as Error).message}), so Nolzu opened project ${first.project} instead. Restart Nolzu and pick it again once it is fixed.`);
    writeSetting(first.db, 'currentProject', first.project);
    return first;
  }
}

// The loop that reads the machine: the first project's, or its stand-in's.
const firstLoop = (dataFolder: string, env: NodeJS.ProcessEnv): Loop =>
  openFirstThatOpens(dataFolder, (id) => createLoop(dataFolder, env, id === undefined ? {} : { project: id }));

// The loop of the project a write's address names with `?project=`, or of the current one. Now names
// the project on every write, because card keys repeat across projects and another tab can pick
// another project. A name that is no project is refused with a sentence.
export function loopOf(url: URL, env: NodeJS.ProcessEnv = process.env): Loop {
  const named = url.searchParams.get('project');
  if (named === null) return loop(env);
  if (!/^\d+$/.test(named)) error(400, 'The address names no project by its number.');
  const dataFolder = resolveDataDir(env);
  let project: number;
  try {
    project = chosenProject(firstLoop(dataFolder, env).db, Number(named)).id;
  } catch (refused) {
    error(409, refused instanceof Error ? refused.message : String(refused));
  }
  return createLoop(dataFolder, env, { project });
}

// The environment is passed rather than read, because the engine is chosen from it and a test that
// had to set a variable on the process would be setting it for every other test in the run.
export interface LoopOptions {
  // Where the MCP secrets are read. The app's keychain when not given, an in-memory one in fake mode.
  keychain?: Keychain;
  // The helpers that hold the machine awake during a run. Injected, so a test sees each start and end
  // without holding this machine awake.
  awake?: AwakeDeps;
  // How to reach `gh`, for the diff a pr-review run reads. Injected for the same reason: a test
  // hands in a stub and no test calls GitHub. Left out, a real run spawns `gh` and a fake run gets
  // the built-in patch.
  gh?: RunGh;
  // How a frame reaches the team hub, for the knowledge proposal a run on a team project sends.
  // Injected for the same reason as the two above: a test hands in a stub and no test opens a
  // socket. Left out, the frame goes up the team socket `hub-link.ts` holds.
  sendTeam?: (type: RunnerMessageType, payload: unknown) => boolean;
  // The project this loop runs, by its registry id. Left out, the first project, `nolzu.db`.
  project?: number;
  // Whether Nolzu's wall starts on this machine. Injected so a test sets either answer. Left out, the
  // runner's probe answers, once per process.
  wall?: WallState;
}

// The output check of a run that ended ready, stored on the run: every Markdown file in the phase's
// folder, the files of earlier phases its rules read, and the notes a knowledge run wrote. A check that throws only notes it in the log,
// because the card still has to land.
function checkRunOutputs(db: DatabaseSync, job: Job, written: WrittenNotes = { notes: {}, created: [] }): void {
  const notes = written.notes;
  try {
    const folder = join(job.taskDir, job.phase);
    const own = existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.md')).map((name) => `${job.phase}/${name}`) : [];
    const files: Record<string, string> = { ...notes };
    const board = boardOfCard(db, job.cardKey) ?? undefined;
    for (const path of new Set([...own, ...checkedPaths(job.phase, board)])) {
      const text = readCardText(job.taskDir, path);
      if (text !== null) files[path] = text;
    }
    // Read at the end, as the person may have changed the file while the run went.
    const project = job.projectDir ?? null;
    const instructions = project !== null && readPhaseInstructions(project, job.phase) !== undefined ? relative(project, phaseInstructionsFile(project, job.phase)) : null;
    const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((repo) => repo.path);
    const check = outputCheck(job.phase, files, instructions, board, repos, written.created);
    if (check !== null) saveOutputCheck(db, job.runId, check);
  } catch (error) {
    noteInRunLog(job.logPath, `The output check could not read what the run wrote: ${(error as Error).message}`);
  }
}

// The Markdown notes one knowledge run added or changed, as `knowledge/<path in the folder>`, and which
// of them it made. git names a change from the repository root, and the folder may sit deeper in it.
export interface WrittenNotes {
  notes: Record<string, string>;
  created: string[];
}
/**
 * Nolzu's own writes, which other cards make while a read-only run goes, left out of its compare: every
 * card folder, every checkout, the knowledge folders a wrap-up commits to, the `.nolzu/` folder whose
 * files, such as the MCP list, Nolzu commits when a setting changes, and the `.cursor/mcp.json` it
 * merges at the project folder for a Cursor run of a Research card, with the `.gitignore` it may make
 * beside it.
 */
export async function nolzuWrites(project: string, taskDir: string, knowledge: readonly (string | null | undefined)[], env: Record<string, string>): Promise<string[]> {
  // Never a file the project's repository tracks, where Nolzu merges nothing (`cursorMergesHere`).
  const tracked = (await git(['ls-files', '--', '.cursor/mcp.json', '.cursor/.gitignore'], { cwd: project, env })).stdout.split('\n');
  const merged = ['.cursor/mcp.json', '.cursor/.gitignore'].filter((path) => !tracked.includes(path)).map((path) => join(project, path));
  return [dirname(taskDir), worktreesFolder(project), join(project, '.nolzu'), ...merged, ...knowledge.filter((dir): dir is string => dir != null)];
}

export async function writtenNotes(run: RunGit, folder: string, changes: readonly { path: string; kind: string }[]): Promise<WrittenNotes> {
  const prefix = (await run(['rev-parse', '--show-prefix'])).stdout.trim();
  const written: WrittenNotes = { notes: {}, created: [] };
  for (const change of changes) {
    if (change.kind === 'removed' || !change.path.startsWith(prefix) || !change.path.endsWith('.md')) continue;
    const inside = change.path.slice(prefix.length);
    // The run may write the knowledge folder, so a note there is read as a card file is: never through
    // a link, never a second name, and a named pipe answers at once instead of holding the app.
    const text = readCardText(folder, inside);
    if (text === null) continue;
    written.notes[`knowledge/${inside}`] = text;
    if (change.kind === 'added') written.created.push(`knowledge/${inside}`);
  }
  return written;
}

export function createLoop(dataFolder: string, env: NodeJS.ProcessEnv = process.env, options: LoopOptions = {}): Loop {
  const keyOf = (project?: number) => (project === undefined || project === firstIds.get(dataFolder) ? dataFolder : `${dataFolder}#${project}`);
  let cacheKey = keyOf(options.project);
  const already = open.get(cacheKey);
  if (already !== undefined) return already;

  const db = options.project === undefined ? openDatabase(dataFolder) : openProject(dataFolder, options.project);
  // Set once the loop holds its place in the shared scheduler, so a failure after that gives it back.
  let giveBack = (): void => undefined;
  // Everything from here can throw on a stored setting nobody can parse or an engine that is not
  // there, and the database is already open by then. Without this the connection is left with
  // nothing holding it, and the route that opens the loop runs on every request.
  try {
    return build();
  } catch (error) {
    giveBack();
    db.close();
    throw error;
  }

  function build(): Loop {
  // Not `project`, which the functions below use for the project's folder.
  const registered = registeredProjects(db).find((one) => (options.project === undefined ? one.file === FIRST_PROJECT : one.id === options.project));
  if (registered === undefined) throw new Error(`There is no project ${options.project ?? FIRST_PROJECT} in ${dataFolder}.`);
  const firstId = registeredProjects(db).find((one) => one.file === FIRST_PROJECT)?.id;
  if (firstId !== undefined) firstIds.set(dataFolder, firstId);
  // The first project named by its id before any loop knew that id goes under the data folder's key.
  cacheKey = keyOf(registered.id);
  // Card keys and run ids repeat across projects, so each keeps its logs and kept files apart.
  const dataDir = projectFiles(dataFolder, registered);
  mkdirSync(dataDir, { recursive: true });
  const keychain = options.keychain ?? appKeychain(env);
  // Read every time, not once, so the board and the snapshot always read the same stored value.
  const boardNow = (kind: BoardKind = 'delivery') => boardFor(kind, getSetting(db, 'deliveryFlow'));
  // The board of one card. A card that is gone answers with Delivery, because the caller is about
  // to find no card either and the board it asked with changes nothing about that.
  const boardOf = (key: string) => boardNow(boardOfCard(db, key) ?? 'delivery');
  const profilesNow = () => getSetting(db, 'engineProfiles');
  const wallNow = (): WallState => options.wall ?? wallHere();
  // One fake engine for every vendor, because the fake engine replays Claude Code's own lines
  // whatever profile a row names. Kept, so a test and the smoke run can replace its spawn.
  const fake = isFakeMode(env) ? selectEngine(env) : null;
  // Built for each call outside fake mode, so a profile added while the app runs reaches the next
  // spawn. The costly parts, the login shell's PATH and a vendor's model list, are read once per
  // process behind their own caches. In fake mode it is that one engine under the name of the
  // vendor asked for, so the run of a Codex row is handed an adapter that says codex. Its model
  // list follows the vendor too: it replays Claude Code's lines, so under Claude Code it answers
  // with its own list, and under another vendor it offers that vendor's built-in rows. Without
  // them a row on another vendor would read gone in fake mode and the demo would refuse the drop.
  //
  // Every job leaves through here, so the project's wall lists ride on it from one place, read at
  // spawn time, and the runner checks them again there.
  const adapter = (vendor: EngineName): Engine => {
    if (fake !== null) return { ...fake, vendor, listModels: vendor === fake.vendor ? fake.listModels : () => presetModels(vendor) };
    const engine = selectEngine(env, { engine: vendor, profiles: profilesNow() });
    return { ...engine, spawn: (job, signal) => engine.spawn({ ...job, walls: job.walls ?? getSetting(db, 'wallLists') }, signal) };
  };
  // The adapter one profile runs on. The profile says the vendor, so there is no engine setting.
  const engineFor = (profile: string): Engine => {
    const vendor = profilesNow().find((one) => one.id === profile)?.vendor;
    if (vendor === undefined) throw new Error(missingProfileText(profile));
    return adapter(vendor);
  };
  // The wall a run of this profile starts in, stored on its row for the card's History row. The fake
  // engine runs inside this process, outside any wall, and its rows say so.
  const wallOf = (profile: string): WallKind =>
    fake !== null ? 'none' : wallKind(profilesNow().find((one) => one.id === profile)?.vendor ?? profile, wallNow(), process.platform);
  const runnable = (vendor: string): boolean => (ENGINES as readonly string[]).includes(vendor);
  // The adapter a row with no profile of its own falls back to: the first profile this version can
  // spawn. Skipping the ones it cannot matters because the loop is built before every request. A
  // first profile of a vendor with no adapter would throw here, and the settings screen a person
  // needs to repair the list is the screen that builds the loop.
  const defaultEngine = (): Engine => adapter(profilesNow().find((one) => runnable(one.vendor))?.vendor ?? DEFAULT_PROFILE.vendor);
  // What the vendors this machine holds a login for offer today. A vendor this version has no
  // adapter for is not in it, and neither is one whose binary answered with nothing, which is what
  // a CLI that is not installed does. A row of such a vendor is never called gone: nothing here
  // knows what it offers, and installing the CLI is what repairs the row, not another model.
  //
  // Only the vendors a profile names, because this is asked on every board snapshot and an empty
  // answer is not cached: a vendor nobody logged into would cost a failed spawn every time.
  const offered = (): ModelsByVendor => {
    const table: Record<string, readonly string[]> = {};
    for (const vendor of new Set(profilesNow().map((one) => one.vendor))) {
      if (!runnable(vendor)) continue;
      const list = adapter(vendor).listModels();
      if (list.length > 0) table[vendor] = list;
    }
    return table;
  };
  // Built now and not on the first run, so a fake delay this process cannot read stops the loop
  // here, where the database is still closed on the way out.
  defaultEngine();
  const listeners = new Set<() => void>();
  let closed = false;
  // Aborted by `shutdown`. An Ask run and a commit message pass take no slot, so Ctrl+C reaches them
  // here and not through the scheduler. `asking` holds each Ask run and each pass until it has written
  // its end, so a shutdown ends after them.
  const leaving = new AbortController();
  const asking = new Set<Promise<void>>();

  // The Fix on a PRs tab row that runs, by card: its run, the row, and the state the card goes back to.
  // `asked` is the question a fix run stopped on: the card waits blocked, and `answer` goes on with the
  // same fix. Here, before `changed`, which reads it.
  // Limit: in memory, as `triageFrom` is. A restart sweeps the row back to new (`recoverRuns`), and a
  // card still blocked on a fix's question then takes its answer as a plain Implement run, which keeps
  // the ref so its summary stays off the hub.
  // `rows` is one row for a Fix and several for Fix all, whose notes come from its file (`all`).
  const fixes = new Map<string, { runId: number; rows: { id: number; ref: string }[]; from: string; asked?: string; all?: boolean }>();
  // A card that left a fix's question some other way, a move or a delete, never gets the answer that
  // would end the fix, so its row goes back to new with the question.
  const dropUnanswered = (): void => {
    for (const [key, fix] of fixes) {
      if (fix.asked === undefined) continue;
      const card = db.prepare('SELECT state FROM cards WHERE key = ?').get(key) as { state: string } | undefined;
      if (card?.state === 'blocked') continue;
      fixes.delete(key);
      for (const row of fix.rows) endFix(db, row.id, { ok: false, reason: `The card moved before the fix's question was answered. The fix asked: ${fix.asked}` });
    }
  };

  // A Delivery card's pull request, found without a press. Once per card per interval, never in fake
  // mode, where nothing may call the real gh, and never once the loop is closed. The interval also reads
  // the linked open pull requests again, so why each cannot merge stays fresh; a failed read keeps the
  // last answer.
  const pullAsked = new Map<string, number>();
  let rereadAt = 0;
  const watchPulls = (key?: string): void => {
    const gh = options.gh ?? (isFakeMode(env) ? null : ghRunner());
    if (closed || gh === null) return;
    const now = Date.now();
    const told = (cards: string[]) => {
      if (cards.length > 0 && !closed) changed();
    };
    if (key === undefined && now - rereadAt >= PULL_WATCH_MS) {
      rereadAt = now;
      void rereadOpenPulls(db, gh, AbortSignal.timeout(PULL_ASK_MS)).then(told, () => undefined);
    }
    const keys = key !== undefined ? [key] : unlinkedCards(db).filter((one) => now - (pullAsked.get(one) ?? 0) >= PULL_WATCH_MS);
    if (keys.length === 0) return;
    for (const one of keys) pullAsked.set(one, now);
    void linkOpenPulls(db, keys, gh, AbortSignal.timeout(PULL_ASK_MS)).then(told, () => undefined);
  };
  const pullTimer = setInterval(() => watchPulls(), PULL_WATCH_MS);
  pullTimer.unref();

  // Learn and then start's held moves, set once the loop is made (`followLearn`).
  let afterLearn = (): void => {};
  const changed = (): void => {
    if (!closed) dropUnanswered();
    // Copied before the walk, because a listener that leaves while it is being told would otherwise
    // change the set underneath the loop.
    for (const listen of [...listeners]) listen();
    if (!closed) afterLearn();
  };

  // What each running job did last, by run id, with the folder its paths are read against. Only in
  // memory: the line names files and commands, so no row, snapshot or hub frame ever carries it.
  const live = new Map<number, { cwd: string; activity: RunActivity }>();
  const watchers = new Set<(activity: RunActivity) => void>();
  // The run printed something. A tool event also gives the line, and any other event keeps the last.
  const heard = (runId: number, event?: RunEvent): void => {
    const entry = live.get(runId);
    if (closed || entry === undefined) return;
    const line = event === undefined ? null : activityLine(event, entry.cwd);
    entry.activity = { ...entry.activity, line: line ?? entry.activity.line, outputAt: Date.now() };
    // This runs inside the engine's loop, where a throw fails the run. A watcher only draws what it
    // hears, so one that throws is dropped and the run goes on.
    for (const watch of [...watchers]) {
      try {
        watch(entry.activity);
      } catch {
        watchers.delete(watch);
      }
    }
  };

  // Card over project over the card's preset, for every action, measured against what each vendor offers now.
  // `onProfile` pins the table to one profile: a resume lives inside one login, so the model has to
  // be one that login can run, and a row of another profile is skipped.
  const modelsFor = (key: string, onProfile: string | null = null): ResolvedTable =>
    resolveModels(cardModels(db, key), cardBase(db, key), cardPreset(db, key), offered(), projectProfiles(db), onProfile);

  // The project's repositories with their bases. One at the project folder until the list is set.
  const reposNow = () => projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') });

  const buildJob = (key: string, phase: ModelAction, runId: number, file: string | null = null, onProfile: string | null = null, onModel: string | null = null, resumed: string | null = null): Job => {
    if (!isAction(phase)) {
      throw new Error(`The ${phase} phase starts no run yet, so there is no model for it and no job to build.`);
    }
    const resolved = modelsFor(key, onProfile)[phase];
    // Kept on the card and said here, never swapped for another value without a word.
    if (resolved.missingProfile) {
      throw new Error(`${key} runs ${phase} on the engine profile ${resolved.engine}, which this machine has no login for. Add it on the Engines screen, or set the row back to inherit on the card's Settings tab.`);
    }
    const vendorHere = profilesNow().find((one) => one.id === resolved.engine)?.vendor;
    // A vendor that cannot run this phase, refused where every run is built. The drop target says
    // the same sentence before the click, and a chained advance, a retry, an answer to a blocked
    // card and a discussion message never pass a drop target at all. Without this, such a run
    // reaches the spawn, and by then it has a run row, a branch and a checkout of its own.
    const project = getSetting(db, 'projectPath');
    const outsideGit = projectOutsideGit(db);
    const refusedHere = vendorHere === undefined ? null : vendorRefusal(vendorHere, phase, { outsideGit, wall: wallNow() });
    if (refusedHere !== null) throw new Error(`${key} cannot run ${phase} on ${resolved.engine}. ${refusedHere}`);
    // A model handed in wins over the table. It is what a person picked in the composer, under the
    // profile that holds the session, and the table may say something else by now. Checked here and
    // not only in the table, or a resume would refuse the very model the person chose for it.
    const model = onModel ?? resolved.model;
    const known = modelsForPick(resolved, profilesNow(), offered());
    if (known.length > 0 && !known.includes(model)) {
      throw new Error(`${key} runs ${phase} on ${model}, which the engine no longer offers. Pick another model on the card's Settings tab.`);
    }
    // A knowledge maintenance run belongs to no card, so there is no row to read and no ticket
    // text. What it needs is the name of the file it rewrites, which travels beside the phase.
    // An assessment belongs to no card either. Its ticket text is the finding: the lines as they were
    // collected, how often the event was seen and where it happens.
    const assessing = findingOfKey(key);
    // Learn your repositories carries its repository in the key, checked against the list here, so a
    // repository removed while its run waited is a sentence and not a run over a folder that is gone.
    const learning = repoOfLearnKey(key);
    if ((learning !== null) !== (phase === 'learn-repo')) throw new Error(`${phaseLabel(phase)} cannot run under the key ${key}.`);
    if (learning !== null && !reposNow().some((repo) => repo.path === learning)) {
      throw new Error(`There is no repository ${JSON.stringify(learning)} in this project, so there is nothing to learn.`);
    }
    const card =
      key === KB_MAINTENANCE_KEY
        ? phase === 'orient'
          ? { key, title: LEARN_TITLE, summary: learnAsk(file), extra_context: null }
          : { key, title: MAINTENANCE_TITLE, summary: MAINTENANCE_ASK, extra_context: null }
        : learning !== null
          ? { key, title: learnRepoTitle(learning), summary: LEARN_REPO_ASK, extra_context: null }
          : assessing !== null
          ? findingCard(assessing, key)
          : (db.prepare('SELECT key, title, summary, extra_context FROM cards WHERE key = ?').get(key) as
              | { key: string; title: string; summary: string | null; extra_context: string | null }
              | undefined);
    if (card === undefined) throw new Error(`There is no card ${key}, so no job can be built for it.`);

    // The key names the card's checkout and its card folder, so a key that is not one plain name would
    // put the agent somewhere else, and `..` in the project's own checkout.
    if (!isPlainName(key)) {
      throw new Error(`The card key ${JSON.stringify(key)} is not one plain name, so it cannot name the card's folders.`);
    }
    // Without a project the job's folder is the data directory, which is the fake engine's place. A
    // real engine there would run with write access inside Nolzu's own data.
    if (project === null && !isFakeMode(env)) {
      throw new Error(`There is no project set, so ${key} has no checkout to run in. Make a project on New project at /new.`);
    }
    // Write access is granted in one place. Asking the policy here rather than repeating which
    // phases may change the project keeps this from drifting away from the rule that holds. The MCP
    // servers are not here: the run reads them from the project's list when it starts (`runMcp`).
    const policy = policyFor(phase);
    // The knowledge folder for a phase that writes knowledge, and null for every other phase. A
    // phase handed the folder may write in it, and only a knowledge run's work is committed.
    const knowledgeDir = policy.knowledge === true ? knowledgeFolder(key, phase, resumed !== null) : null;
    // The one file a maintenance run rewrites. The name comes off a form, so both refusals live
    // here and not in one caller. It is checked against the folder itself, which is what keeps a
    // `..` out of it: the list holds the files in the folder and nothing else.
    // Learn this project carries the repository it starts with there instead, and rewrites no one file.
    const knowledgeFile = file === null || phase === 'orient' ? null : file.trim();
    if (phase === 'orient' && file !== null && !reposNow().some((repo) => repo.path === file)) {
      throw new Error(`There is no repository ${JSON.stringify(file)} in this project, so Learn this project has nothing to start with.`);
    }
    if (phase === 'optimize' && (knowledgeFile === null || knowledgeFile === '')) {
      throw new Error('No knowledge file was named, so there is nothing to rewrite.');
    }
    if (knowledgeFile !== null && (knowledgeDir === null || !knowledgeFiles(knowledgeDir).includes(knowledgeFile))) {
      throw new Error(`There is no knowledge file ${JSON.stringify(knowledgeFile)} in ${knowledgeDir ?? 'the knowledge folder'}, so there is nothing to rewrite.`);
    }

    // The card's own checkout when there is a project, and the data directory when there is not,
    // which is the fake engine's case. Making that checkout is ensureWorktree's job, on the path
    // that starts the card.
    // A maintenance run has no branch and no checkout of its own, so it runs in the project itself.
    // It writes only the knowledge folder and its own run folder, which is what the guard holds it to.
    // An assessment writes nothing at all, so a checkout of its own would be a branch and a clone for
    // a run whose whole point is changing nothing. It reads the person's own tree, uncommitted work
    // and all, and the guard is what holds it to reading.
    // On a project with several repositories, refine and plan start in the card's root once an
    // earlier run made it, and in the project otherwise, the way an assessment does. The guard holds
    // them to the card folder. Every other phase needs the card's list before it can start at all.
    // An empty workspace is the same with no list to pick from: refine and plan read the workspace,
    // and nothing else has a repository to work in yet.
    const listed = project === null || belongsToNoCard(key) ? 1 : reposNow().length;
    const several = listed > 1;
    const unlisted = listed === 0 || (several && reposOfCard(db, key) === null);
    const readsIfUnlisted = readsUnlisted(phase, boardOfCard(db, key) ?? 'delivery');
    const inPlace = readsInPlace(phase) || (unlisted && readsIfUnlisted);
    if (listed === 0 && !inPlace) throw new Error(NO_REPOSITORY);
    if (several && !inPlace && reposOfCard(db, key) === null) throw new Error(noRepoList(key, boardOf(key)));
    // A resume goes where its session was made, which is the project when the list came after it.
    const looks = (listed !== 1 && picksRepos(phase)) || phase === ASK_PHASE || (unlisted && readsIfUnlisted) || (resumed !== null && listed !== 1 && readsIfUnlisted);
    // A resume of theirs starts where its session was made, because the engine filed the session
    // under that folder, and an implement may have made the root since.
    const madeIn = project !== null && looks && resumed !== null ? sessionFolder(db, key, resumed) : null;
    const at =
      project === null
        ? dataDir
        : madeIn === project || madeIn === checkoutRoot(project, key)
          ? madeIn
          : belongsToNoCard(key) || (looks && !existsSync(checkoutRoot(project, key)))
            ? project
            : checkoutRoot(project, key);
    // The repositories this run's checkout holds, for a run that may use the shell (implement and
    // QA), or null. Every other run starts where it always did.
    const shell = policy.tools.includes('Bash');
    const picked = project === null || !shell || at !== checkoutRoot(project, key) || looks ? null : several ? reposOfCard(db, key) : reposNow().map((repo) => repo.path);
    // A card on one repository starts in its checkout, because an allowed command matches the start
    // of the line and `cd api && npm test` would wait for a permission. A resume goes there only when
    // its session was made there, because the engine filed it under that folder: one from the root, or
    // from a run that recorded no folder, starts in the root as before. One repository at the project
    // root keeps the root, so a project of one repository starts where it always did.
    const inRepo = project !== null && picked?.length === 1 ? checkoutPath(project, key, picked[0]) : null;
    const cwd = inRepo !== null && (resumed === null || sessionFolder(db, key, resumed) === inRepo) ? inRepo : at;
    // Every other run works in a checkout of its own, so the guard is one more wall around it. A
    // maintenance run works in the person's own tree, where the guard is the only wall there is, and
    // it holds `Edit`. With no guard file it could change any file in that tree, and only the
    // knowledge folder is ever committed, so the rest would sit there with nobody told.
    const settingsPath = engineSettings(project);
    if (project !== null && !existsSync(join(project, GUARD_PATH)) && (belongsToNoCard(key) || cwd === project)) {
      // An assessment is refused for the same reason: with no hook file the run would be a read-only
      // phase with write access to every file in the person's own tree. So are refine and plan when
      // they start in the project folder, since both hold Write.
      const held =
        isMaintenanceKey(key)
          ? 'a maintenance run to the knowledge folder'
          : belongsToNoCard(key)
            ? 'an assessment run to reading'
            : phase === ASK_PHASE
              ? 'an Ask run to reading'
              : `a ${phase} run to its card folder`;
      throw new Error(`This project has no run guard at ${GUARD_PATH}, so nothing would hold ${held}. Press Write the project files in Project settings.`);
    }
    // Next to the worktrees and not inside the checkout, so what the phases wrote outlives the
    // checkout that cleanup removes.
    const taskDir = join(project ?? dataDir, '.tasks', key);
    // The vendor of the profile this row runs on, off the same adapter the run itself is handed, so
    // a Codex row gets the file whatever the other rows of the card run on.
    const vendor = engineFor(resolved.engine).vendor;
    // The folder this run's process starts in. The checkout for every run but a read-only phase on
    // Codex under its own sandbox, which starts in the card folder so that the sandbox leaves the
    // project unwritable. A resume starts where its session did, so a run made under the other
    // setting finds its paths. The job carries the answer to the spawn, so the paths in the prompt
    // and the folder the process gets cannot disagree.
    const inCardFolder = resumed !== null ? sessionInCardFolder(db, key, resumed, vendor, phase) : startsInCardFolder(vendor, phase, ownSandbox(vendor, wallNow()));
    // QA runs the project's checks on a throwaway copy of its checkout, made right before the run in
    // `startJob`, because the wall keeps the checkout read-only and a check writes caches. The prompt
    // names every path outside the copy in full, so the card folder it names is the real one. No copy
    // without a project: that is the fake engine, which runs in this process and writes no checkout.
    const qaCopy = project !== null && !inCardFolder && policy.readOnly && policy.commands === true ? qaCopyPath(dataFolder, cwd, key) : null;
    const startIn = inCardFolder ? taskDir : (qaCopy ?? cwd);
    // How the prompt names a path outside the folder the run starts in: relative, so no machine path
    // reaches it, except in QA's copy. From there the card folder is three or more folders up through
    // the data folder, and models miscounted it. Physical, because the wall and the guard hold that.
    const named = (path: string) => (qaCopy === null ? relative(startIn, path) || '.' : resolvedPath(path));
    // Every engine is handed the phase method as a file in the card folder, built from the skill in
    // the installed package when the run starts, so an upgrade reaches the next run with nothing to
    // commit. Claude Code once opened the project's committed copy through a slash command, and kept
    // the old method after every upgrade. A file someone edited in the project's own skills folder
    // still wins, read from the project folder and not the checkout, from the first skills folder that
    // has an edit. An Ask has no skill: its prompt holds the whole method, on every engine.
    const instructions =
      phase === ASK_PHASE ? null : phaseInstructions(phase, project === null ? undefined : (name, shipped) => personsSkillEdit(project, `nolzu-${phase}/${name}`, shipped));
    // Refine and plan on several repositories read every one of them and name the ones the card
    // changes. A repository the card has a checkout of is read there, with the card's own work in
    // it, and any other in the project. A knowledge file onboarding could not write is not named.
    const repositories = project !== null && several && picksRepos(phase) ? reposNow().map((repo) => repo.path) : undefined;
    const knowledgeHome = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: project });
    const reposInPrompt =
      project === null
        ? undefined
        : repositories?.map((name) => {
            const checkout = checkoutPath(project, key, name);
            const at = existsSync(join(checkout, '.git')) ? checkout : repoFolder(project, name);
            const knowledge = knowledgeHome === null ? null : join(knowledgeHome, repoKnowledgePath(name));
            return { name, path: relative(startIn, at) || '.', knowledge: knowledge !== null && existsSync(knowledge) ? relative(startIn, knowledge) : null };
          });
    // What an earlier run of this phase finished, from the file the skill keeps. A fresh run on
    // another profile has no session to continue, so this is how it finds its place in the plan.
    const progress = progressOf(taskDir, phase);
    // A task of an epic reads the epic's documents that exist, read only. An Ask has a method of its own.
    const epic = phase === ASK_PHASE ? null : epicOfTask(db, key);
    const epicFiles = epic === null ? [] : epicDocPaths(join(project ?? dataDir, '.tasks', epic.key));
    // With no text there is no file, and the run would spend the person's quota on the card alone,
    // so it is refused here instead. Every phase that starts a run has a skill, so this means Nolzu
    // cannot read the skills it ships.
    if (instructions === null && phase !== ASK_PHASE) {
      throw new Error(`Nolzu cannot read the ${phase} skill it ships, so the run would have the card and no method. Install Nolzu again.`);
    }
    // The project's own words for this phase, read from the project folder and not the card's
    // checkout, so an edit on the settings screen reaches the next run at once.
    const projectInstructions = project === null ? undefined : readPhaseInstructions(project, phase);
    // What the earlier phases of this card wrote, named so the run opens it. Plan also reads the
    // project's instructions for Implement and QA, so a rule there reaches a step or a QA check.
    // A later review round gets the rounds before it, oldest first, by their files and not by the
    // column, so it can say whether a finding is fixed.
    const readFirst = phase === ASK_PHASE ? [] : phase === 'pr-review' ? roundsIn(taskDir).map((round) => join(taskDir, round.file)) : readFirstPaths(taskDir, phase);
    const laterInstructions =
      project === null || phase !== 'plan'
        ? []
        : ['implement', 'qa'].filter((later) => readPhaseInstructions(project, later) !== undefined).map((later) => ({ phase: later, file: phaseInstructionsFile(project, later) }));
    // The index of the project's knowledge for every phase that reads code. A phase that writes
    // knowledge has the folder already, and an Ask has a method of its own. Claude Code gets one Read
    // rule for the folder, because `--add-dir` would let the run write there.
    // The card's repositories decide what it lists, so a project with many repositories still shows a
    // card its own notes. A card with no list yet gets every repository, and a run that belongs to no
    // card, such as an assessment, the whole folder.
    const allRepos = reposNow().map((repo) => repo.path);
    const scope = project === null || belongsToNoCard(key) ? undefined : { card: reposOfCard(db, key) ?? allRepos, repos: allRepos };
    const knowledgeIndex = knowledgeDir !== null || phase === ASK_PHASE || knowledgeHome === null ? null : pickKnowledge(knowledgeIndexFiles(knowledgeHome), undefined, scope);
    const knowledgeReadDir = knowledgeHome !== null && knowledgeIndex !== null && knowledgeIndex.kept.length > 0 ? knowledgeHome : null;
    const readFiles = laterInstructions.map((later) => later.file);
    // The project's own list, and only for a phase that may use the shell at all. A list never
    // filled is filled here from the repositories' stacks, as a project save fills it: a workspace's
    // repositories clone after that save, and the only other fill is the Settings page, so a person
    // who never opened it left every run unable to install or test. An empty list stays empty.
    const allowedCommands = policy.tools.includes('Bash') ? [...new Set([...fillAllowedCommands(db), ...(policy.readGit === true ? READ_GIT_COMMANDS : [])])] : [];
    // What the person said on the card. Each word was typed to one run, and this run starts fresh.
    // The first QA answer goes to a run with a shell, the one that starts or tests the app.
    // One line for each repository of the card with an answer, and one for an answer they share.
    const apps = allowedCommands.length === 0 ? null : getSetting(db, 'qaApp');
    const answers = apps === null ? [] : qaReposOf(db, key).flatMap((repo) => answerFor(apps, repo) ?? []);
    // An answer for every repository is one object, so it gives one line.
    const firstQa = answers.filter((app, index) => answers.indexOf(app) === index);
    const personsSaid = { ...personsWords(db, key, boardOf(key).stages), allowedCommands, ...(firstQa.length === 0 ? {} : { firstQa }) };
    // The commit the run reads, for the prompt line a phase copies as `Read at:`: the card's checkout
    // when it is there, else the base branch the checkout will be cut from, in the repository folder.
    // Limit: a card whose branch is already there, locally or only on a remote, is checked out on
    // that branch, so before its checkout exists the line names the base. Several repositories have
    // no one commit, so no line, unless the run works in one of them.
    const oneRepo = project === null || belongsToNoCard(key) ? undefined : several ? (inRepo === null ? undefined : picked?.[0]) : reposNow()[0]?.path;
    const commit =
      project === null || oneRepo === undefined
        ? null
        : existsSync(join(checkoutPath(project, key, oneRepo), '.git'))
          ? commitAt(checkoutPath(project, key, oneRepo), gitEnv(env))
          : commitAt(repoFolder(project, oneRepo), gitEnv(env), reposNow().find((repo) => repo.path === oneRepo)?.base ?? getSetting(db, 'baseBranch'));
    // The prompt names the servers of the project's list this phase is on for. The run swaps the lines
    // for the servers it got once it read the secrets (`startJob`).
    const onServers = promptMcp(project, phase, vendor, getSetting(db, 'qaMcpConfigPath'));

    return {
      runId,
      cardKey: key,
      // The profile the row resolved to, recorded on the job so a resume finds the same login.
      engine: resolved.engine,
      phase,
      cwd,
      ...(qaCopy === null ? {} : { qaCopy }),
      taskDir,
      // Claude Code reads AGENTS.md here when the run starts in a card checkout.
      projectDir: project,
      knowledgeDir,
      knowledgeFile,
      instructions,
      prompt:
        phase === ASK_PHASE
          ? askPrompt({ key: card.key, title: card.title, ticket: card.summary ?? '', extra: card.extra_context ?? '', folder: relative(startIn, taskDir) || '.', projectInstructions })
          : buildPrompt({
            phase,
            key: card.key,
            title: card.title,
            ticket: card.summary ?? '',
            extra: card.extra_context ?? '',
            readOnly: policy.readOnly,
            folder: named(taskDir),
            fullPaths: qaCopy !== null,
            // Named only when the run does not start in the checkout, which is the Codex read-only
            // shape. The prompt then says where the project is, because the paths it gives are read
            // from the folder the process starts in.
            checkout: inCardFolder ? relative(startIn, cwd) : undefined,
            knowledgeFolder: knowledgeDir === null ? undefined : relative(startIn, knowledgeDir),
            // What a person wrote when they returned this card's last knowledge change. A return
            // nobody reads is the same as a silent delete.
            // Optimize and Learn this project share the reserved key, so each reads the notes on its own kind.
            knowledgeNote: knowledgeDir === null ? undefined : (returnedKnowledgeNote(db, card.key, key === KB_MAINTENANCE_KEY ? phase : undefined) ?? undefined),
            knowledgeFile: knowledgeFile ?? undefined,
            learnRepo: learning === null || project === null ? undefined : { name: learning, path: named(repoFolder(project, learning)) },
            progress,
            repositories: reposInPrompt,
            // Several repositories in a run that may use the shell: the prompt says to pass each
            // tool's folder option instead of `cd`. Left out otherwise, so that prompt is unchanged.
            folderRepos:
              project !== null && picked !== null && picked.length > 1
                ? picked.map((name) => ({ name, path: relative(cwd, checkoutPath(project, key, name)) || '.' }))
                : undefined,
            epic: epic === null || epicFiles.length === 0 ? undefined : { key: epic.key, title: epic.title, files: epicFiles.map(named) },
            ...(boardOfCard(db, key) === 'epics' ? { epicCard: true } : {}),
            ...(existsSync(join(taskDir, FROM_EPIC_FILE)) ? { epicNotes: named(join(taskDir, FROM_EPIC_FILE)) } : {}),
            projectInstructions,
            readFirst: readFirst.map(named),
            laterInstructions: laterInstructions.map((later) => ({ phase: later.phase, path: named(later.file) })),
            personsWords: personsSaid,
            // The wrap-up looks for what cost time on the card, so it reads how the card went.
            ...(phase === 'wrapup' ? { history: cardHistory(db, key, runId) } : {}),
            knowledgeIndex: knowledgeReadDir === null || knowledgeIndex === null ? undefined : { folder: named(knowledgeReadDir), files: knowledgeIndex.kept, left: knowledgeIndex.left, other: knowledgeIndex.other },
            commit: commit ?? undefined,
            browser: onServers.browser,
            servers: onServers.servers,
          }),
      model,
      effort: resolved.effort,
      sessionId: null,
      resumeFrom: null,
      timeoutMs: getSetting(db, 'runTimeoutMs'),
      // Named before the run starts, so a run that dies before its first line still says where the
      // stream it did produce went.
      logPath: join(dataDir, 'logs', `${key}-${phase}-${runId}.ndjson`),
      // One knowledge-writing run at a time, because they all commit into the same repository, and
      // one QA run at a time, because QA owns the local stack while it runs. A job waiting for
      // either lane takes no slot, so unrelated work goes past it. One assessment at a time as well:
      // it reads the person's own tree, and two of them reading it at once would report on a tree
      // that moved under them.
      lane: policy.knowledge === true ? 'knowledge' : phase === 'qa' ? 'stack' : phase === 'assess' ? 'scout' : null,
      // The servers come when the run starts, with the secrets read then (`runMcp`).
      mcpConfigPath: null,
      // The read-only guard lives in the project, and this run works in the card's checkout, which
      // does not read the project's settings. Named, so it loads there too.
      settingsPath,
      tools: policy.tools,
      allowedCommands,
      // Left out on one repository, so that job is the one it always was.
      ...(repositories === undefined ? {} : { repositories }),
      // Left out for a card that is no task, so that job is the one it always was.
      ...(epicFiles.length === 0 ? {} : { epicFiles }),
      ...(readFiles.length === 0 ? {} : { readFiles }),
      ...(knowledgeReadDir === null ? {} : { knowledgeReadDir }),
      ...(outsideGit ? { outsideGit: true as const } : {}),
      // Only on Codex, the one engine that may start anywhere but the checkout.
      ...(vendor === 'codex' ? { startsInCardFolder: inCardFolder } : {}),
    };
  };

  /**
   * The repositories a refine or plan run named for its card, kept as the card's list.
   *
   * Only for a run that completed, on a project with several repositories. The line at the end of
   * the phase's file says which. A file this run did not write, or one with no such line, changes
   * nothing. A name the project does not list is dropped, and the run's log says so. A repository
   * the card has a checkout of stays, because its work there would drop out of the card's changes.
   * A person's own list is never replaced; `setCardRepos` holds to that.
   */
  const keepNamedRepos = (job: Job, since: number): void => {
    const project = getSetting(db, 'projectPath');
    if (project === null || belongsToNoCard(job.cardKey) || (job.phase !== 'refine' && job.phase !== 'plan')) return;
    const paths = reposNow().map((repo) => repo.path);
    if (paths.length < 2) return;
    const text = writtenSince(job.taskDir, join(job.phase, job.phase === 'refine' ? 'refined.md' : 'plan.md'), since);
    const named = text === null ? null : repositoriesLine(text, paths);
    // No line, or a line that names nothing usable, has not said the card changes nothing. Writing
    // the checkouts alone would cut down a good list from an earlier phase.
    if (named === null) return;
    if (named.known.length > 0) {
      const list = paths.filter((path) => named.known.includes(path) || existsSync(join(checkoutPath(project, job.cardKey, path), '.git')));
      if (setCardRepos(db, job.cardKey, list, job.phase)) changed();
    }
    // The note comes after the list, so a log that cannot take it does not cost the card its list.
    if (named.unknown.length > 0) {
      const one = named.unknown.length === 1;
      noteInRunLog(
        job.logPath,
        `The ${job.phase} named ${named.unknown.join(', ')}, which ${one ? 'is not a repository' : 'are not repositories'} of this project, so ${job.cardKey}'s list leaves ${one ? 'it' : 'them'} out.`,
      );
    }
  };
  // A log that cannot take the note does not cost the run its result. The reason goes where the
  // other loop errors go.
  const keepNamedReposSafely = (job: Job, since: number): void => {
    try {
      keepNamedRepos(job, since);
    } catch (error) {
      console.error(`Keeping the repositories ${job.cardKey}'s ${job.phase} named failed: ${(error as Error).message}`);
    }
  };

  // The short title Refine wrote on the first heading of refined.md becomes a local card's title.
  // `setCardTitle` keeps a GitHub or Jira title and one a person set. A title that cannot be written
  // does not cost the run its result.
  const takeRefinedTitle = (job: Job, since: number): void => {
    if (job.phase !== 'refine' || belongsToNoCard(job.cardKey)) return;
    try {
      const text = writtenSince(job.taskDir, join('refine', 'refined.md'), since);
      const title = text === null ? null : refinedTitle(text, job.cardKey);
      if (title !== null && setCardTitle(db, job.cardKey, title, 'refine')) changed();
    } catch (error) {
      console.error(`Taking the title ${job.cardKey}'s refine wrote failed: ${(error as Error).message}`);
    }
  };

  // A single repository's refine runs in the card's checkout, so its branch was named before Refine
  // wrote the title, kind and words the template takes. It gets the name now, while it has no
  // upstream and no commit; `renameFreshBranch` keeps any other branch as it is. On several
  // repositories refine makes no checkout, so there is nothing to rename and the first build names it.
  const renameAfterRefine = async (job: Job): Promise<void> => {
    const project = getSetting(db, 'projectPath');
    if (job.phase !== 'refine' || project === null || belongsToNoCard(job.cardKey) || !isPlainName(job.cardKey)) return;
    try {
      const checkouts = cardCheckouts(db, job.cardKey);
      if (checkouts.length === 0) return;
      const forGit = gitEnv(env);
      const from = await cardBranch(db, job.cardKey, checkouts.map((one) => one.path), forGit);
      const done = await renameFreshBranch({ checkouts, from, to: templateBranch(db, job.cardKey), env: forGit });
      if (done.renamed) changed();
      else if (done.reason !== null) noteInRunLog(job.logPath, done.reason);
    } catch (error) {
      console.error(`Renaming ${job.cardKey}'s branch after refine failed: ${(error as Error).message}`);
    }
  };

  /**
   * What an assessment run carries where a card's title and ticket text would be.
   *
   * The finding is the whole ticket. The two collected lines are the evidence, so they travel into
   * the prompt as they were pasted. They stay out of the key, the log path and every screen label,
   * because pasted text can hold a real token.
   */
  const findingCard = (findingId: number, key: string): { key: string; title: string; summary: string; extra_context: null } => {
    const finding = scoutFinding(db, findingId);
    // The finding can go while the screen that named it is open: removing a source takes its
    // findings with it. A sentence, because the person pressed a button and has to read why.
    if (finding === null) {
      throw new Error(`There is no finding ${findingId} on this machine, so there is nothing to assess. It may have gone with the source that found it.`);
    }
    const first = finding.lastMessage.split('\n')[0]?.trim() ?? '';
    const seen = finding.occurrences === 1 ? 'once' : `${finding.occurrences} times`;
    const lines =
      finding.firstMessage === finding.lastMessage
        ? `The line as it was collected:\n\n${finding.lastMessage}`
        : `The first line seen:\n\n${finding.firstMessage}\n\nThe newest line seen:\n\n${finding.lastMessage}`;
    return {
      key,
      // A finding with no line at all has nothing to name it, and the id is what the person clicked.
      title: first === '' ? `Scout finding ${findingId}` : first,
      summary: [
        'This run belongs to no card. Scout found the event below, and this run says what is behind it.',
        `Seen ${seen}, first on ${finding.firstSeen} and last on ${finding.lastSeen}.${finding.location === '' ? '' : `\nWhere it happens: ${finding.location}`}`,
        lines,
      ].join('\n\n'),
      extra_context: null,
    };
  };

  /**
   * The knowledge folder this project writes into, for a run that is about to be built.
   *
   * Nothing is made here. The folder is made when the run gets its slot, because a job that waits
   * in the queue may never run at all.
   */
  const knowledgeFolder = (key: string, phase: string, answering: boolean): string => {
    // The reserved key is bookkeeping and never reaches a person, so what these sentences ask for
    // is the button they would press, the way `changeSource` reads such a run as maintenance. While
    // Learn this project waits on a question, its screen offers Send and resume in place of its button.
    const learnAgain = answering ? 'send your answer again' : 'press Learn this project again';
    const again =
      phase === 'learn-repo' ? 'start Learn your repositories again' : key !== KB_MAINTENANCE_KEY ? `run ${key} again` : phase === 'orient' ? learnAgain : 'start the Optimize run again';
    const who = isMaintenanceKey(key) ? 'a maintenance run' : key;
    const pending = pendingKnowledgeChanges(db);
    // A second run would write against knowledge the waiting change has not applied yet, so the
    // person could no longer approve both. Refused with the names, because "something is pending"
    // leaves nobody anywhere to go.
    if (pending.length > 0 && !aheadOfReview) {
      const files = [...new Set(pending.map((change) => change.filePath))].join(', ');
      // With review on this is the normal state of a folder waiting for a person, so the sentence
      // names the screen where they answer it.
      throw new Error(`Knowledge from an earlier run is still waiting for a person: ${files}. Approve or return it on the Knowledge screen at /knowledge, then ${again}.`);
    }
    const folder = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: getSetting(db, 'projectPath') });
    if (folder === null) {
      throw new Error(`There is no project set, so ${who} has no knowledge folder to write into. Make a project on New project at /new.`);
    }
    return folder;
  };

  // The settings file every Claude Code run is handed, written fresh at every start so it cannot go
  // stale, and kept in the data directory rather than in the project, because it names a path on this
  // machine. It always turns the engine's own sandbox and its attribution off. The guard hook is in it only
  // when the project has the guard file: a project whose files were never written gets no hook invented
  // for it, and a missing hook file would refuse nothing anyway.
  const engineSettings = (project: string | null): string => {
    const path = join(dataDir, 'engine-settings.json');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, guardSettings(project !== null && existsSync(join(project, GUARD_PATH)) ? project : null));
    return path;
  };

  // A run row that failed with the reason is what the card reads its reason from, and a failed card
  // can move, where a card left queued with no job behind it refuses every move.
  const failStart = (key: string, phase: string, error: unknown): void => {
    const runId = startRun(db, { cardKey: key, phase, engine: projectProfiles(db)[0]?.id ?? DEFAULT_PROFILE.id, model: null, effort: null, sessionId: null, logPath: '', lane: null });
    const record = foldRun([{ type: 'failed', reason: (error as Error).message, status: null }]);
    saveRun(db, runId, record);
    db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(record.cardState, key);
    if (phase !== ASK_PHASE && !belongsToNoCard(key)) noteRunEnd(db, { id: runId, key, phase }, record, null);
    noteMaintenanceFailure(db, { id: runId, key, phase }, record);
    changed();
  };

  /**
   * Where a finished run leaves the card: its state always, and its stage when `chainTo` takes it one
   * column on, onto a person's column or the archive. Null `run` is a run that never chains: a Fix
   * or a triage, which hand the card back as it was.
   *
   * The stage is read here and not when the run started, because a run takes minutes and the card
   * may have been moved in the meantime. A card on the archive reads idle, as a drag there leaves it,
   * so it counts as done and not as waiting.
   *
   * A chain writes its timeline row the way a move by hand does, in one transaction with the stage,
   * so the timeline never shows a move the board did not make. It starts no run, so the row names
   * no phase.
   */
  const landCard = (key: string, state: string, run: { id: number; phase: string; verdict: string | null } | null): void => {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Read under the write lock, so a move by hand that lands now is the stage this reads.
      const card = run === null ? undefined : (db.prepare('SELECT stage, board FROM cards WHERE key = ?').get(key) as { stage: string; board: BoardKind } | undefined);
      const board = card === undefined ? undefined : boardNow(card.board);
      const to = card === undefined || board === undefined || run === null ? undefined : chainTo(board, card.stage, { phase: run.phase, state, verdict: run.verdict, waits: cardHolds(db, key) !== null });
      if (card === undefined || board === undefined || to === undefined) {
        db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(state, key);
      } else {
        recordMove(db, key, card.stage, to, 'auto', null);
        db.prepare('UPDATE cards SET state = ?, stage = ? WHERE key = ?').run(board.stages.find((stage) => stage.id === to)?.role === 'archive' ? 'idle' : state, to, key);
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };

  /**
   * The chain a person allowed in advance: a small Delivery card whose plan
   * ended ready goes on to Implement, once, through `moveTo`, the writer a drop posts to.
   *
   * What a drop refuses before it sends anything is read off the snapshot the board draws, so a
   * refused chain leaves the card ready where it ran, as a refused drop does, and the run that ended
   * keeps the reason for Now to say. What the server refuses after the move fails the card in the
   * next stage with its reason, as it does for a drop.
   */
  // `then` is the stage Fix it chains to, which the press already asked for, so the
  // opt-in rule of `smallChain` does not apply to it.
  const chainOn = async (key: string, phase: string, runId: number, then?: string): Promise<void> => {
    if (closed) return;
    const card = db.prepare('SELECT board, stage, state, size FROM cards WHERE key = ?').get(key) as
      | { board: string; stage: string; state: string; size: CardSize | null }
      | undefined;
    if (card === undefined || card.state !== 'ready' || !isBoardKind(card.board)) return;
    const board = boardNow(card.board);
    const to = then ?? smallChain(board, card, phase, getSetting(db, 'chainBoards'));
    if (to === undefined) return;
    const label = board.stages.find((stage) => stage.id === to)?.label ?? to;
    const refused = (reason: string): void => {
      db.prepare('UPDATE runs SET chain_refused = ? WHERE id = ?').run(`${label} did not start on its own. ${reason}`, runId);
      bumpVersion(db);
    };
    try {
      // The card's own models over the stage's, as a drop of this card reads them.
      const snapshot = made.snapshot(card.board);
      const view = snapshot.cards.find((one) => one.key === key) ?? null;
      const stages = snapshot.stages.map((stage) => ({ ...stage, starts: cardStarts(stage, view) }));
      const starts = stages.find((stage) => stage.id === to)?.starts ?? null;
      if (starts !== null && (starts.modelState !== 'ok' || starts.refusal !== null)) {
        refused(startsLabel(board, card.stage, to, stages) ?? '');
        return;
      }
      const moved = await moveTo(made, key, to, 'auto');
      // A 409 moved nothing. Anything else is a move that went through, as a drop's would.
      if (moved?.status === 409) refused(moved.message);
    } catch (error) {
      // The run already ended well, and a chain that could not run must not turn it into a failure.
      if (!closed) refused((error as Error).message);
    }
  };

  // The runs that ended ready, by card, until they leave the queue and their chain is asked.
  const chaining = new Map<string, { phase: string; runId: number; then?: string }>();

  // The state a card had when Run triage was pressed, by card. A triage is a side run: it holds the
  // card while it goes, and when it ends the card goes back to what it was, so a read of the comments
  // never turns into an approval of the stage or a failure Retry would answer with a stage run.
  // Limit: in memory, so a card whose triage outlived a restart lands idle.
  const triageFrom = new Map<string, string>();
  const triageBack = (key: string): string => {
    const state = triageFrom.get(key) ?? 'idle';
    triageFrom.delete(key);
    return state;
  };

  const fixOf = (key: string, runId: number) => {
    const fix = fixes.get(key);
    return fix?.runId === runId ? fix : undefined;
  };
  // How a Fix that did not end well ends its row, and the card back where it was.
  const fixEnded = (key: string, fix: { rows: { id: number }[]; from: string }, reason: string): void => {
    fixes.delete(key);
    for (const row of fix.rows) endFix(db, row.id, { ok: false, reason });
    db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(fix.from, key);
  };

  // QA the fixes that runs, by card: its run, the refs it checks, and the state the card goes back to.
  // Limit: in memory, as `triageFrom` is, so a QA of the fixes that outlived a restart lands as a
  // plain QA run, and its rows stay fixed.
  const checking = new Map<string, { runId: number; refs: string[]; from: string }>();
  const checkOf = (key: string, runId: number) => {
    const check = checking.get(key);
    return check?.runId === runId ? check : undefined;
  };

  // The Implement run Fix it started, by card, and the QA stage it goes on to once that run ends
  // ready. Keyed by the run, so a run that never got here, such as one stopped while it waited,
  // cannot hand its QA to a later run of the card.
  // Limit: in memory, so a restart of Nolzu during that run drops the QA after it. The card then
  // waits ready on Implement, as after a plain run. Store it on the run row if that ever bites.
  const fixing = new Map<string, { runId: number; then: string }>();

  // The card's own stack row, which the ticket page draws and the Load, Unload and Force buttons
  // write too. The run columns stay the audit trail of one QA run; this is the live state, so a
  // person who works the stack by hand sees the same panel move.
  const markStack = (key: string, stack: { state: StackState; reason: string | null }): void => {
    setCardStack(db, key, stack);
    changed();
  };

  // What the card says when a QA run printed no verdict line. It is not a pass: nobody can say what
  // the run found, so the card waits where it is.
  const NO_VERDICT = 'This QA run printed no verdict, so nobody can say what it found. Read its log, then move the card yourself.';

  // The question a BLOCKED verdict with no sentence puts on the card. The verdict still counts,
  // because losing a failure over a missing sentence is the worse mistake.
  const NO_REASON = 'QA is blocked and gave no reason. Read its log, then answer with what it needs.';

  // With `resume`, the run goes on in an earlier session and its prompt is the message alone. A null
  // session is a fresh run that is told the message after the card, which is Fix it with no session.
  // A card's knowledge run that waits for a person to answer the change waiting on Knowledge, by the
  // run row that stands for it, oldest first. Only in memory: a crash ends that row as it ends any
  // queued run, and a clean stop ends it as stopped.
  const waitingReview = new Map<number, { key: string; phase: ModelAction; go: () => boolean }>();
  // True while `start` builds the job of a card that will wait, so the waiting change refuses nothing.
  let aheadOfReview = false;
  // Set once a stop of Nolzu ended the waits, so a chain that runs during the stop makes no new one.
  let stoppingWaits = false;

  // `retried` is a fresh run after a failed one, which starts from what the failed run left behind.
  const start = (
    key: string,
    phase: ModelAction,
    resume?: { sessionId: string | null; message: string; engine?: string; model?: string },
    file: string | null = null,
    onProfile: string | null = null,
    retried = false,
    // True for the start `reviewAnswered` lets go, which has waited its turn already.
    released = false,
  ): boolean => {
    // A wrap-up would write against knowledge the waiting change has not applied yet. On a first run
    // that change is what Learn wrote, which always waits, so a refusal here failed every new card.
    // The card waits instead, and starts once the person answered the change on Knowledge. It also
    // waits behind a card that waits already, and behind a knowledge run still in the queue, whose
    // change may wait for review once it ends: so each wrap-up runs on what the one before it wrote.
    const waits =
      !released && !belongsToNoCard(key) && isAction(phase) && policyFor(phase).knowledge === true && (pendingKnowledgeChanges(db).length > 0 || waitingReview.size > 0 || knowledgeBusy());
    const make = (runId: number): Job => {
      // The profile the earlier run recorded is what the model is resolved under, and not only what
      // the job carries afterwards. A card whose action table moved this phase to another profile
      // would otherwise resume with a model of a vendor that never held the session. The message's
      // own model travels with it, so the check reads the model the run will really use.
      //
      // `onProfile` pins a fresh run the same way, which is what "Run on" asks for: the model has
      // to be one that login can run.
      const job = buildJob(key, phase, runId, file, resume?.engine ?? onProfile, resume?.model ?? null, resume?.sessionId ?? null);
      if (resume === undefined) return job;
      if (resume.sessionId === null) return { ...job, prompt: `${job.prompt}\n\n${resume.message}` };
      return resumeJob(job, resume.sessionId, resumeMessage(phase, resume.message), { engine: resume.engine, model: resume.model });
    };
    let draft: Job;
    // Built while the card waits too, with the waiting change left out of the checks, so a missing
    // login or an engine that cannot run the phase is said now and not after the review.
    aheadOfReview = waits;
    try {
      draft = make(0);
    } catch (error) {
      // The move is already committed, so the card has moved and nothing will run.
      failStart(key, phase, error);
      return false;
    } finally {
      aheadOfReview = false;
    }
    if (waits && stoppingWaits) {
      // Nolzu is stopping, so no wait starts that the stop would only end again.
      failStart(key, phase, new Error(`Nolzu is stopping, so ${phaseLabel(phase)} of ${key} did not start. Start it again after the next start of Nolzu.`));
      return false;
    }
    if (waits) {
      const runId = startRun(db, { cardKey: key, phase, engine: draft.engine, model: draft.model, effort: draft.effort, sessionId: resume?.sessionId ?? null, logPath: '', lane: 'knowledge' });
      db.prepare("UPDATE runs SET state = 'waiting_review' WHERE id = ?").run(runId);
      db.prepare("UPDATE cards SET state = 'queued' WHERE key = ?").run(key);
      waitingReview.set(runId, { key, phase, go: () => start(key, phase, resume, file, onProfile, retried, true) });
      changed();
      return true;
    }
    // A fresh run whose prompt says to go on from the steps a stopped run finished.
    const progress = resume === undefined ? progressOf(draft.taskDir, phase) : undefined;
    const continued = progress !== undefined && stepsDone(progress).length > 0;
    const runId = startRun(db, {
      cardKey: key,
      phase,
      // The profile, not the vendor. A resume, an answer to a blocked card and a discussion
      // message all run on the profile the row records, whatever the action table says by then.
      engine: draft.engine,
      model: draft.model,
      effort: draft.effort,
      sessionId: resume?.sessionId ?? null,
      logPath: draft.logPath,
      lane: draft.lane,
      // An answer, a message, a retry and a run that goes on from the progress file all build on work
      // an earlier run did, so what they cost says nothing about a fresh start, and the estimates
      // leave them out.
      resumed: resume !== undefined || retried || continued,
    });
    const job = make(runId);
    // A new plan makes the step numbers of the old one meaningless, so the implement progress file
    // goes when a plan run starts. Left there, the next implement run would be told to go on from a
    // step of a plan nobody wrote any more.
    if (phase === 'plan') removeCardFile(job.taskDir, join('implement', PROGRESS_FILE));
    // The log file is named after the run, and the run has no id until its row exists. Two runs of
    // one phase would otherwise write over each other's stream.
    db.prepare('UPDATE runs SET log_path = ?, cwd = ?, in_card_folder = ?, wall = ? WHERE id = ?').run(job.logPath, job.cwd, job.startsInCardFolder === true ? 1 : 0, wallOf(job.engine), runId);
    scheduler.add(job);
    return true;
  };

  // Queued first, so the board shows the card locked from this moment. Anything that throws after that
  // leaves no job behind the card, so it fails with the reason instead of staying queued for good.
  const restart = (
    key: string,
    phase: ModelAction,
    resume?: { sessionId: string | null; message: string; engine?: string; model?: string },
    onProfile: string | null = null,
    retried = false,
  ): boolean => {
    db.prepare("UPDATE cards SET state = 'queued' WHERE key = ?").run(key);
    try {
      return start(key, phase, resume, null, onProfile, retried);
    } catch (error) {
      failStart(key, phase, error);
      return false;
    }
  };

  const answer = (key: string, text: string): boolean => {
    // Learn this project has no card to be blocked, so its newest run says whether it asked.
    if (key === KB_MAINTENANCE_KEY) return answerLearn(text);
    const card = db.prepare('SELECT state FROM cards WHERE key = ?').get(key) as { state: string } | undefined;
    if (card === undefined) throw new Error(`There is no card ${key}, so there is no question to answer.`);
    if (card.state !== 'blocked') throw new Error(`${key} is ${card.state} and not blocked, so no question is waiting for an answer.`);
    if (text.trim() === '') throw new Error(`The answer to ${key} is empty. Write what the agent asked for, then send it.`);

    // The newest run is the one that asked, because only a ready run is followed by another.
    const asked = db
      .prepare(`SELECT id, phase, session_id, engine, question, thread FROM runs WHERE card_key = ? AND ${NOT_A_PASS} ORDER BY id DESC LIMIT 1`)
      .get(key) as { id: number; phase: DeliveryPhase; session_id: string | null; engine: string; question: string | null; thread: string | null } | undefined;
    // The ref of a Fix that asked, which the run the answer starts carries too. A Fix that asked goes on
    // as the same fix. Out of the map while the run starts, so the card leaving blocked for it does not
    // end the fix.
    const ref = asked?.thread ?? null;
    const waiting = fixes.get(key);
    const fix = waiting?.asked !== undefined && ref !== null ? waiting : undefined;
    if (fix !== undefined) fixes.delete(key);
    // The question and the answer into the phase's thread, so the Discussion tab shows why the run went
    // on. A blocked run writes no summary, so without this the exchange is nowhere to read. A fix's too,
    // as its summary goes there: the thread stays on this machine.
    if (asked !== undefined) {
      const question = asked.question?.trim() ?? '';
      if (question !== '') addMessage(db, key, asked.phase, 'agent', question, asked.id);
      addMessage(db, key, asked.phase, 'person', text.trim(), asked.id);
    }
    // A run with no session cannot be continued. `resumeJob` refuses it, and the card then fails with
    // that reason rather than staying blocked on a question nobody can answer.
    //
    // The profile comes off the run row and not off the action table. Somebody who changed the
    // table while a card sat blocked would otherwise have their answer resumed on a login that
    // never held the session.
    const before = (db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number | null }).id ?? 0;
    const started = restart(key, asked?.phase ?? 'refine', {
      sessionId: asked?.session_id ?? '',
      message: text,
      engine: asked?.engine,
    });
    if (ref === null) return started;
    // As `fixFeedback` starts one: the ref keeps the run's summary off the hub, and a start that failed
    // ends the row with its reason and puts the card back. With no waiting fix, the run lands as a plain
    // Implement run.
    const run = db.prepare('SELECT id, error FROM runs WHERE card_key = ? AND id > ? ORDER BY id DESC LIMIT 1').get(key, before) as { id: number; error: string | null } | undefined;
    if (!started || run === undefined) {
      if (fix === undefined) return false;
      fixEnded(key, fix, run?.error ?? 'The answer could not go on with the fix.');
      changed();
      return false;
    }
    db.prepare('UPDATE runs SET thread = ? WHERE id = ?').run(ref, run.id);
    if (fix !== undefined) fixes.set(key, { runId: run.id, rows: fix.rows, from: fix.from, ...(fix.all === true ? { all: true } : {}) });
    changed();
    return true;
  };

  /**
   * A message in a discussion thread, which continues that phase's own session.
   *
   * The profile comes off the thread, which read it off the run row. A card whose action table
   * changed since the phase ran still continues on the login that holds the session, because a
   * session lives inside one profile and a resume on another finds nothing.
   */
  const discuss = (
    key: string,
    thread: { id: string; sessionId: string | null; engine: string | null },
    text: string,
    model?: string,
  ): boolean => {
    const card = db.prepare('SELECT state FROM cards WHERE key = ?').get(key) as { state: string } | undefined;
    if (card === undefined) throw new Error(`There is no card ${key}, so there is no thread to write in.`);
    // An Ask discussion is a session of its own and leaves the card as it is, so it takes a message
    // whatever the card is doing.
    // A pull request comment's discussion is a read-only session of the same kind, and leaves the row as it is.
    if (isAskThread(thread.id) || isFeedbackRef(thread.id)) return ask(key, thread, text, model);
    // Only a card nothing is happening to. `restart` writes `queued` whatever the card was, so a
    // message into a blocked card would clear the question nobody had answered, and one into a
    // failed card would take away the reason and the Retry button with it.
    if (card.state !== 'ready' && card.state !== 'idle') {
      const why: Record<string, string> = {
        queued: 'Wait for the run to start and end, then send the message.',
        running: 'Wait for the run to end, then send the message.',
        blocked: 'Answer the question on the overview first, which continues the same session.',
        failed: 'Retry the card first, or move it back.',
      };
      throw new Error(`${key} is ${card.state}. ${why[card.state] ?? 'Wait until the card is ready.'}`);
    }
    // A delivery phase, so the type narrows and `buildJob` is what refuses a phase that starts no
    // run yet, with its own sentence. The ask thread and a review ref stop here.
    if (!isDeliveryPhase(thread.id)) {
      throw new Error(`The ${thread.id} thread starts no run, so a message in it continues nothing.`);
    }
    return restart(key, thread.id, {
      sessionId: thread.sessionId ?? '',
      message: text,
      engine: thread.engine ?? undefined,
      model: model === '' ? undefined : model,
    });
  };

  /**
   * A message in an Ask discussion: a read-only session that reads the card's code
   * and the card folder and answers in the discussion. It goes on in the discussion's session, or
   * starts one on the ask row. Every refusal of a run is thrown before anything is written.
   *
   * It is kept out of the card's state: it never moves the card or writes its state, and it takes no
   * place in the queue, so a phase run of the card never waits behind it. Its row carries the card,
   * so its cost counts where the card's other runs count, and the Log tab lists it.
   * Limit: outside the scheduler, as `writeMessage` is, so it takes no slot either. Put it on a lane
   * if asks ever pile up.
   */
  const ask = (key: string, thread: { id: string; sessionId: string | null; engine: string | null }, text: string, model?: string): boolean => {
    if (text.trim() === '') throw new Error('The message is empty. Write it above, then send it.');
    // Only an Ask run: a Fix on the same pull request comment names its ref too, and does not answer here.
    const going = db.prepare("SELECT id FROM runs WHERE card_key = ? AND phase = ? AND thread = ? AND state IN ('queued', 'running') LIMIT 1").get(key, ASK_PHASE, thread.id);
    if (going !== undefined) throw new Error('The agent is still answering in this discussion. Wait for its answer, then send the next message.');
    const picked = model === undefined || model === '' ? null : model;
    // The profile the session lives in, or the ask row's for a new one, which is what `buildJob` resolves.
    const make = (runId: number): Job => {
      const job = buildJob(key, ASK_PHASE, runId, null, thread.engine, picked, thread.sessionId);
      // A new session about a pull request comment opens with the discussion Discuss wrote first.
      const opening = isFeedbackRef(thread.id) ? (messagesIn(db, key, thread.id)[0]?.body ?? '') : '';
      const about = opening === '' || opening === text.trim() ? '' : `${opening}\n\n`;
      if (thread.sessionId === null) return { ...job, prompt: `${job.prompt}\n${about}${text.trim()}\n` };
      return resumeJob(job, thread.sessionId, text.trim(), { engine: thread.engine ?? undefined, model: picked ?? undefined });
    };
    const draft = make(0);
    const runId = startRun(db, {
      cardKey: key,
      phase: ASK_PHASE,
      engine: draft.engine,
      model: draft.model,
      effort: draft.effort,
      sessionId: thread.sessionId,
      logPath: draft.logPath,
      lane: null,
      resumed: thread.sessionId !== null,
      thread: thread.id,
    });
    const job = make(runId);
    // Running from here, because no slot is waited for. The start is what the estimates measure from.
    db.prepare("UPDATE runs SET log_path = ?, cwd = ?, in_card_folder = ?, wall = ?, state = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?").run(job.logPath, job.cwd, job.startsInCardFolder === true ? 1 : 0, wallOf(job.engine), runId);
    // Nothing waits on this promise, and a rejection nobody catches takes the process with it.
    const answering = answerIn(job, thread.id).catch((error: Error) => console.error(`The Ask run ${runId} of ${key} ended without its answer being kept: ${error.message}`));
    asking.add(answering);
    void answering.finally(() => asking.delete(answering));
    return true;
  };

  /**
   * The git compare around a read-only run: every phase whose
   * policy reads only, Ask and the two passes. The state is read right before the process starts,
   * and compared when its last line is in, before a knowledge commit moves anything. After a run with
   * no wall, in a checkout Nolzu made for the card, what changed is put back and the run log says what.
   * Behind a wall the run could not write there, so a change is the person's or another program's, and
   * like the person's own folder it is not touched: the run row keeps the mark and the diff, which the
   * card page shows. The wall should make this never fire; it is the last check behind it. `quiet` is
   * false while an app or stack Nolzu started for QA writes its caches into the checkout, which then
   * leaves ignored files out. QA compares the real checkout, `job.cwd`, never its copy.
   */
  type Compared = { before: GitSnapshot[]; own: string; project: string } | null;
  // In the form the run rows stamp, so a run of the card that started and ended inside this one counts.
  const sinceNow = () => new Date().toISOString();
  const readBefore = async (job: Job, quiet = true): Promise<Compared> => {
    const project = getSetting(db, 'projectPath');
    if (project === null || !policyFor(job.phase).readOnly) return null;
    const own = worktreesFolder(project);
    // The person's own tools write caches into their folder all day, so ignored files count only in
    // Nolzu's own checkouts.
    const ignored = job.cwd.startsWith(`${own}/`) && quiet;
    const knowledge = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: project });
    try {
      const exclude = await nolzuWrites(project, job.taskDir, [job.knowledgeDir, knowledge], gitEnv(env));
      // The repositories from Nolzu's own records, never from a look around the folder: a run that may
      // write a card's folder can leave a repository there whose config git would follow.
      const repos = recordedRepos({ project, repos: reposNow().map((repo) => repo.path), key: belongsToNoCard(job.cardKey) ? null : job.cardKey, cardRepos: reposOfCard(db, job.cardKey) ?? [], cwd: job.cwd });
      return { before: await gitBefore(repos, { exclude, ignored, env: gitEnv(env) }), own, project };
    } catch (error) {
      noteInRunLog(job.logPath, `Nolzu could not read the git state before this read-only run, so it cannot check the run changed nothing. ${(error as Error).message}`);
      return null;
    }
  };
  // `read` is the state `readBefore` took, for a caller that reads it before a step of its own, with the
  // time it took it from (`sinceNow`).
  async function* comparedAround(job: Job, run: AsyncIterable<RunEvent>, read?: { watch: Compared; since: string }): AsyncGenerator<RunEvent> {
    // Taken before the state is read, so a run of the card that ends while it is read counts too.
    const since = read?.since ?? sinceNow();
    const watch = read === undefined ? await readBefore(job) : read.watch;
    if (watch === null) {
      yield* run;
      return;
    }
    // Another run of the card, such as an Implement or a Fix beside an Ask message, writes the same
    // checkouts, and the compare cannot tell its change or the person's from this run's. Asked at the
    // start for a run queued or running, and again at the end for one queued, running, or ended since
    // this one started, so a run that started and ended meanwhile counts too.
    const beside = otherRunOfCard(db, job.cardKey, job.runId);
    // The events that end a run wait for the compare, so the row reads ended only once a checkout is
    // put back, and the next run of the card never starts in one that is still being restored.
    const held: RunEvent[] = [];
    try {
      for await (const event of run) {
        if (event.type === 'complete' || event.type === 'failed' || event.type === 'needs_input') {
          held.push(event);
          continue;
        }
        yield* held.splice(0);
        yield event;
      }
    } finally {
      // A closed database throws on a read, so after a close only the first answer counts.
      if (beside || (!closed && otherRunOfCard(db, job.cardKey, job.runId, since))) {
        noteInRunLog(job.logPath, 'Another run of this card went at the same time, so Nolzu did not compare the git state after this read-only run. A change could be that run\'s, so nothing was put back or marked.');
      } else {
        // Codex's own sandbox is not Nolzu's wall, so its checkout is put back as with none.
        const ownFolder = wallOf(job.engine) === 'macos' || wallOf(job.engine) === 'bubblewrap' ? null : watch.own;
        const found = await gitAfter(watch.before, { ownFolder, project: watch.project, env: gitEnv(env) }).catch((error: Error) => {
          noteInRunLog(job.logPath, `Nolzu could not compare the git state after this read-only run. ${error.message}`);
          return undefined;
        });
        if (found !== undefined) await markBreak(job, found);
      }
    }
    yield* held;
  }

  // A compare that found a change: the run log says what changed and what Nolzu did, and the run
  // row keeps it for the card page. A clean compare of a later run clears the card's earlier marks,
  // so a warning does not stay for good.
  const markBreak = async (job: Job, found: ReadOnlyBreak | null): Promise<void> => {
    if (closed) return;
    try {
      if (found === null) {
        // Not a pass: a summary pass reads the checkout right after the run it follows was put back,
        // and its clean compare would wipe that run's mark at once.
        if (!isPass(job.phase) && clearReadOnlyBreaks(db, job.cardKey, job.runId)) changed();
        return;
      }
      saveReadOnlyBreak(db, job.runId, found);
      const walled = wallOf(job.engine) === 'macos' || wallOf(job.engine) === 'bubblewrap';
      noteInRunLog(
        job.logPath,
        found.restored
          ? `This read-only run changed the card's checkout, so Nolzu put it back. ${[...found.undone, ...found.left].join(' ')}`
          : walled
            ? 'Files changed in the project folder while this read-only run went. The wall kept the run from writing there, so the change came from another program or from the person. Nolzu left them as they are and marked the card.'
            : `Files changed in the project folder while this read-only run went. Nolzu left them as they are and marked the card.`,
      );
      changed();
    } catch (error) {
      console.error(`Keeping the read-only mark of ${job.cardKey} run ${job.runId} failed: ${(error as Error).message}`);
    }
  };

  // The run of an Ask message, to its end, and its answer into the discussion. A run that ended with no
  // answer says why in the thread, so a person never waits on nothing.
  const answerIn = async (job: Job, thread: string): Promise<void> => {
    const events: RunEvent[] = [];
    try {
      for await (const event of comparedAround(job, runJob(engineFor(job.engine), job, leaving.signal))) events.push(event);
    } catch (error) {
      events.push({ type: 'failed', reason: (error as Error).message, status: null });
    }
    // A run can end after the loop was closed, and a write to a closed database throws where nothing catches it.
    if (closed) return;
    const ended = foldRun(events, leaving.signal.aborted);
    saveRun(db, job.runId, ended);
    const said = answerOf(events);
    const body =
      ended.state !== 'complete'
        ? noAnswer(ended.failureReason ?? null)
        : said === ''
          ? 'The agent ended without an answer. Its log is on the Log tab.'
          : said;
    addMessage(db, job.cardKey, thread, 'agent', body, job.runId);
    // The subject pass starts before the answer is announced, so the page that reads the answer also
    // sees the pass running and reads the card again once its subject lands.
    if (ended.state === 'complete' && said !== '' && wantsSubject(db, job.cardKey, thread)) {
      // The question this answer answers: the newest the person wrote, which is the first one unless an
      // earlier try ended with no answer.
      const question = messagesIn(db, job.cardKey, thread).findLast((one) => one.author === 'person')?.body ?? '';
      const titling = titleThread(job.cardKey, thread, question, said).catch((error: Error) => console.error(`The subject of ${job.cardKey} ${thread} was not written: ${error.message}`));
      asking.add(titling);
      void titling.finally(() => asking.delete(titling));
    }
    // The version too, so the estimates read this run and every open page reads the answer.
    bumpVersion(db);
    changed();
  };

  const retry = (key: string, onProfile: string | null = null): boolean => {
    const card = db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: string } | undefined;
    if (card === undefined) throw new Error(`There is no card ${key}, so there is nothing to retry.`);
    // A card left idle by a stopped run starts its stage again too. The newest run is read the way the
    // snapshot reads it, so the server takes what the page offers.
    const last = db.prepare(`SELECT phase, state FROM runs WHERE card_key = ? AND ${NOT_A_PASS} ORDER BY id DESC LIMIT 1`).get(key) as { phase: string; state: string } | undefined;
    const phase = boardOf(key).stages.find((stage) => stage.id === card.stage)?.phase;
    // Only in the stage that ran it: a card moved back after the stop would start a run nobody asked for.
    const halted = card.state === 'idle' && last?.state === 'stopped' && last.phase === phase;
    if (card.state !== 'failed' && !halted) throw new Error(`${key} is ${card.state} and not failed, so there is nothing to retry.`);
    // A failed triage is no failure of the stage. Retry starts the stage's phase, which would write code
    // where the person asked for a read-only triage.
    if (last?.phase === 'feedback') throw new Error(`The triage of ${key} failed. Run triage again on its PRs tab, or move the card.`);
    // A profile this machine has no login for would start a run nothing can spawn, so it is refused
    // here, before the card is set queued.
    if (onProfile !== null && !profilesNow().some((one) => one.id === onProfile)) throw new Error(missingProfileText(onProfile));
    // The phase the card's stage starts, which is the one that failed or was stopped. A fresh run,
    // because a failed session holds nothing worth continuing, and a stopped one was stopped on purpose.
    if (phase === undefined) throw new Error(`${key} sits in ${card.stage}, which starts no run, so there is nothing to retry. Move the card instead.`);
    return restart(key, phase, undefined, onProfile, true);
  };

  const fix = async (key: string): Promise<boolean> => {
    const card = db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: string } | undefined;
    if (card === undefined) throw new Error(`There is no card ${key}, so there is nothing to fix.`);
    const board = boardOf(key);
    const qa = board.stages.find((stage) => stage.id === card.stage);
    // The newest run, as the card's verdict chip reads it: a verdict is about the work as it stood
    // then, and any later run makes it old.
    const last = db.prepare(`SELECT phase, verdict, verdict_reason FROM runs WHERE card_key = ? AND ${NOT_A_PASS} ORDER BY id DESC LIMIT 1`).get(key) as
      | { phase: string; verdict: string | null; verdict_reason: string | null }
      | undefined;
    if (card.state !== 'ready' || qa?.phase !== 'qa' || last?.phase !== 'qa' || last.verdict !== 'FAIL') {
      throw new Error(`${key} has no failed QA run to fix. Fix it follows a QA FAIL.`);
    }
    const implement = implementOf(key, 'Fix it');

    // What QA left in the card folder, read before the move, so the message says what QA saw.
    const qaDir = join(getSetting(db, 'projectPath') ?? dataDir, '.tasks', key, 'qa');
    // `qa/evidence/` since the evidence rules, `qa/` before them.
    const shots = ['qa', 'qa/evidence'].flatMap((folder) => {
      const at = join(qaDir, '..', folder);
      return existsSync(at) ? readdirSync(at).filter((name) => cardFileKind(name) === 'image').sort().map((name) => `${folder}/${name}`) : [];
    });
    const message = fixMessage({ reason: last.verdict_reason, report: readCardText(dirname(qaDir), join('qa', 'report.md')), shots });

    const runId = await backToImplement(key, card.stage, implement, message);
    if (runId !== null) fixing.set(key, { runId, then: qa.id });
    return runId !== null;
  };

  const implementOf = (key: string, what: string): { id: string } => {
    const implement = boardOf(key).stages.find((stage) => stage.phase === 'implement');
    if (implement === undefined) throw new Error(`${key} sits on a board with no Implement column, so ${what} has nowhere to go back to.`);
    return implement;
  };

  // Fix it's path, which Send back with comments takes too: the move a person drags, through the drop's
  // own writer, unless the card sits in Implement already (a move back starts nothing). Then the newest
  // implement session goes on with the message, on the profile that holds it, as an answer resumes
  // one. None left, and the run starts fresh with the message after the card. The run it started, or
  // null when the start failed and the card is failed with the reason.
  const backToImplement = async (key: string, stage: string, implement: { id: string }, message: string): Promise<number | null> => {
    if (stage !== implement.id) {
      const moved = await moveTo(made, key, implement.id);
      if (moved !== null) throw new Error(moved.message);
    }
    const session = db
      .prepare("SELECT session_id, engine FROM runs WHERE card_key = ? AND phase = 'implement' AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(key) as { session_id: string; engine: string } | undefined;
    if (!restart(key, 'implement', { sessionId: session?.session_id ?? null, message, engine: session?.engine })) return null;
    return (db.prepare('SELECT max(id) AS id FROM runs WHERE card_key = ?').get(key) as { id: number }).id;
  };

  const triage = (key: string): boolean => {
    const card = db.prepare('SELECT board, state FROM cards WHERE key = ?').get(key) as { board: string; state: string } | undefined;
    if (card === undefined) throw new Error(`There is no card ${key}, so there are no comments to triage.`);
    if (card.board !== 'delivery') throw new Error(`${key} is not on Delivery. Only a Delivery card has its own pull request comments to triage.`);
    // A failed triage may run again, and nothing else that failed: a triage that ends ready would
    // write over the reason another run failed with.
    const newest = db.prepare(`SELECT phase FROM runs WHERE card_key = ? AND ${NOT_A_PASS} ORDER BY id DESC LIMIT 1`).get(key) as { phase: string } | undefined;
    const again = card.state === 'failed' && newest?.phase === 'feedback';
    if (card.state !== 'ready' && card.state !== 'idle' && !again) throw new Error(`${key} is ${card.state}. Run triage once nothing else holds the card.`);
    if (!cardDiscussions(db, key).some(isOpen)) throw new Error(`${key} has no open discussion to triage. Read comments on its PRs tab first, or reopen one.`);
    triageFrom.set(key, again ? 'idle' : card.state);
    return restart(key, 'feedback');
  };

  // What Fix and Fix all refuse before anything is written: no card, a card that is not on Delivery,
  // one a run or a question holds, a board with no Implement run, and a done card. A card whose row is
  // fixing passes, because `beginFix` names that fix, which is the reason the person needs.
  const fixableCard = (key: string, what: string): { state: string } => {
    const card = db.prepare('SELECT board, stage, state FROM cards WHERE key = ?').get(key) as { board: string; stage: string; state: string } | undefined;
    if (card === undefined) throw new Error(`There is no card ${key}, so there is no comment to fix.`);
    if (card.board !== 'delivery') throw new Error(`${key} is not on Delivery. Only a Delivery card has its own pull request comments to fix.`);
    // Only a card nothing is happening to, for the reason Send back gives.
    if (card.state !== 'ready' && card.state !== 'idle' && !cardDiscussions(db, key).some((one) => one.status === 'fixing')) {
      const why: Record<string, string> = {
        queued: 'Wait for the run to start and end, then fix the comment.',
        running: 'Wait for the run to end, then fix the comment.',
        blocked: 'Answer the question on the overview first.',
        failed: 'Retry the card first, or move it.',
      };
      throw new Error(`${key} is ${card.state}. ${why[card.state] ?? 'Wait until the card is ready.'}`);
    }
    implementOf(key, what);
    const stages = boardOf(key).stages;
    if (stages.at(-1)?.id === card.stage) throw new Error(`${key} is done, so its checkout is not there to fix. Move it back first.`);
    return card;
  };

  // A Fix or Fix all whose rows are fixing already. The card stays on its column: nothing moves a card
  // by itself, and an implement run needs no Implement column under
  // it. The newest implement session goes on, as for Send back, or a fresh run is told the message
  // after the card.
  const startFix = (key: string, from: string, rows: { id: number; ref: string }[], message: string, all: boolean): boolean => {
    const session = db
      .prepare("SELECT session_id, engine FROM runs WHERE card_key = ? AND phase = 'implement' AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(key) as { session_id: string; engine: string } | undefined;
    const before = (db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number | null }).id ?? 0;
    const started = restart(key, 'implement', { sessionId: session?.session_id ?? null, message, engine: session?.engine });
    const run = db.prepare('SELECT id, error FROM runs WHERE card_key = ? AND id > ? ORDER BY id DESC LIMIT 1').get(key, before) as { id: number; error: string | null } | undefined;
    if (!started || run === undefined) {
      // A start that failed left a failed run row with the reason. The rows carry it, and the card goes
      // back to what it was, because Retry on the Pull request column would start nothing.
      fixEnded(key, { rows, from }, run?.error ?? 'The fix could not start.');
      changed();
      return false;
    }
    // The refs on the run row mark it a fix, so the hub never gets its summary or question, which
    // quote the comments.
    db.prepare('UPDATE runs SET thread = ? WHERE id = ?').run(rows.map((row) => row.ref).join(','), run.id);
    fixes.set(key, { runId: run.id, rows, from, ...(all ? { all: true } : {}) });
    changed();
    return true;
  };

  const fixFeedback = (key: string, ref: string): boolean => {
    const card = fixableCard(key, 'Fix');
    const begun = beginFix(db, key, ref);
    if (!begun.ok) throw new Error(begun.reason);
    const pull = cardPullRows(db, key).find((one) => one.id === begun.row.pull);
    return startFix(key, card.state, [{ id: begun.row.id, ref: begun.row.ref }], fixFeedbackMessage(begun.row, pull), false);
  };

  const fixAll = (key: string): boolean => {
    const card = fixableCard(key, 'Fix all');
    const begun = beginFixAll(db, key);
    if (!begun.ok) throw new Error(begun.reason);
    // The notes an earlier Fix all left are not this run's.
    removeCardFile(join(getSetting(db, 'projectPath') ?? dataDir, '.tasks', key), FIXES_FILE);
    const rows = begun.rows.map((row) => ({ id: row.id, ref: row.ref }));
    return startFix(key, card.state, rows, fixAllMessage(begun.rows, cardPullRows(db, key)), true);
  };

  const qaFixes = (key: string): boolean => {
    const card = db.prepare('SELECT board, stage, state FROM cards WHERE key = ?').get(key) as { board: string; stage: string; state: string } | undefined;
    if (card === undefined) throw new Error(`There is no card ${key}, so there are no fixes to check.`);
    if (card.board !== 'delivery') throw new Error(`${key} is not on Delivery. Only a Delivery card has fixes for its own pull request comments to check.`);
    if (card.state !== 'ready' && card.state !== 'idle') {
      const why: Record<string, string> = {
        queued: 'Wait for the run to start and end, then run QA of the fixes.',
        running: 'Wait for the run to end, then run QA of the fixes.',
        blocked: 'Answer the question on the overview first.',
        failed: 'Retry the card first, or move it.',
      };
      throw new Error(`${key} is ${card.state}. ${why[card.state] ?? 'Wait until the card is ready.'}`);
    }
    if (boardOf(key).stages.at(-1)?.id === card.stage) throw new Error(`${key} is done, so its checkout is not there to check. Move it back first.`);
    const rows = fixedSinceQa(db, key);
    if (rows.length === 0) throw new Error(`Nothing was fixed on ${key} since its last QA, so QA has nothing new to check. Fix a comment first.`);
    const before = (db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number | null }).id ?? 0;
    const started = restart(key, 'qa', { sessionId: null, message: qaFixesMessage(rows, cardPullRows(db, key), lastJudgedQa(db, key)) });
    const run = db.prepare('SELECT id FROM runs WHERE card_key = ? AND id > ? ORDER BY id DESC LIMIT 1').get(key, before) as { id: number } | undefined;
    if (!started || run === undefined) {
      // The failed run row keeps the reason for the Log tab. The card goes back to what it was, because
      // Retry on the Pull request column would start nothing.
      db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(card.state, key);
      changed();
      return false;
    }
    const refs = rows.map((row) => row.ref);
    // The refs keep the run's summary off the hub, as a fix's: it is about the comments.
    db.prepare('UPDATE runs SET thread = ? WHERE id = ?').run(refs.join(','), run.id);
    checking.set(key, { runId: run.id, refs, from: card.state });
    changed();
    return true;
  };

  const sendBack = async (key: string): Promise<boolean> => {
    const card = db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: string } | undefined;
    if (card === undefined) throw new Error(`There is no card ${key}, so there is nothing to send back.`);
    const open = commentsOf(db, key).filter((one) => one.sentAt === null);
    if (open.length === 0) throw new Error(`${key} has no open comments to send back. Comment on a line on the Changes tab first.`);
    // Only a card nothing is happening to, as a discussion message. `restart` writes queued whatever
    // the card was, so a question nobody answered or a failure's reason would go with it.
    if (card.state !== 'ready' && card.state !== 'idle') {
      const why: Record<string, string> = {
        queued: 'Wait for the run to start and end, then send the comments back.',
        running: 'Wait for the run to end, then send the comments back.',
        blocked: 'Answer the question on the overview first.',
        failed: 'Retry the card first, or move it back.',
      };
      throw new Error(`${key} is ${card.state}. ${why[card.state] ?? 'Wait until the card is ready.'}`);
    }
    const implement = implementOf(key, 'Send back');
    const stages = boardOf(key).stages;
    const at = stages.findIndex((stage) => stage.id === card.stage);
    if (at < stages.findIndex((stage) => stage.id === implement.id) || at === stages.length - 1) {
      throw new Error(`${key} sits in ${card.stage}, so there is no Implement run to send comments back to.`);
    }

    // Read before the move, from the card's checkouts as they stand.
    const project = getSetting(db, 'projectPath');
    const checkout = (repo: string): string | null => {
      try {
        return project === null || !isPlainName(key) ? null : checkoutPath(project, key, repo);
      } catch {
        return null;
      }
    };
    const message = sendBackMessage(
      open.map((one) => {
        const at = checkout(one.repo);
        return { repo: one.repo, file: one.file, line: one.line, lineText: one.lineText, text: one.text, now: at === null ? null : lineNow(at, one) };
      }),
    );

    if ((await backToImplement(key, card.stage, implement, message)) === null) return false;
    // The ones read above alone, so a comment saved while this ran waits for the next send back.
    const sent = db.prepare('UPDATE diff_comments SET sent_at = ? WHERE id = ? AND sent_at IS NULL');
    const now = new Date().toISOString();
    for (const one of open) sent.run(now, one.id);
    return true;
  };

  /**
   * A knowledge maintenance run that rewrites one file.
   *
   * The job is built here first, so a refusal is a sentence the person reads on the Knowledge
   * screen. A card's start writes its reason on a run row and the board shows it there, and a
   * maintenance run has no card and no board to show anything on.
   *
   * It takes the knowledge lane like every other run that writes knowledge, so a wrap-up started
   * at the same time waits for it, and work that has nothing to do with knowledge goes past.
   */
  const optimize = (file: string): boolean => {
    buildJob(KB_MAINTENANCE_KEY, 'optimize', 0, file);
    return start(KB_MAINTENANCE_KEY, 'optimize', undefined, file);
  };

  /**
   * Learn this project. A person starts it, never Nolzu. It runs
   * like Optimize, under the reserved key and on the knowledge lane, and its writing always waits for
   * review. Built first, so a refusal is a sentence on the screen that offered it.
   */
  const learn = (repo?: string): boolean => {
    buildJob(KB_MAINTENANCE_KEY, 'orient', 0, repo ?? null);
    return start(KB_MAINTENANCE_KEY, 'orient', undefined, repo ?? null);
  };

  /**
   * Learn your repositories: a read-only run per repository on the action's own row, each under
   * a key of its own. Distinct keys let the queue take every run at once, and the knowledge lane is
   * what runs them one after another, under the same slot limit as every other run. Every job is built
   * first, so one refusal, such as knowledge still waiting for review, starts none of them.
   */
  const learnRepos = (repos: readonly string[]): number => {
    const picked = [...new Set(repos)];
    if (picked.length === 0) throw new Error('No repository was picked, so there is nothing to learn. Tick one or more, then start again.');
    const queue = scheduler.queue();
    // Before any run row: `enqueue` throws for a key it already holds, and a row left queued would
    // have no job behind it.
    const queued = picked.filter((repo) => [...queue.waiting, ...queue.running].some((job) => job.cardKey === learnRepoKey(repo)));
    if (queued.length > 0) throw new Error(`${queued.join(', ')} ${queued.length === 1 ? 'is' : 'are'} being learned already. Wait for that run to end, then start again.`);
    for (const repo of picked) buildJob(learnRepoKey(repo), 'learn-repo', 0);
    return picked.filter((repo) => start(learnRepoKey(repo), 'learn-repo')).length;
  };

  // The answer to the question a Learn this project run asked. It has no card, so the newest run under
  // the reserved key is the one that asked, the way a card's newest run is, and it asked when it ended
  // with a question. The session it made goes on with the answer.
  const answerLearn = (text: string): boolean => {
    const asked = learnAsking(db);
    if (asked === null) throw new Error('Learn this project is not waiting for an answer, so there is nothing to send it to.');
    if (text.trim() === '') throw new Error('The answer is empty. Pick one of the answers or write your own, then send it.');
    // Built first, as `learn` is. A start that failed would be the newest run under the key, and the
    // question would be gone with it, so a refusal is a sentence and the question still waits.
    buildJob(KB_MAINTENANCE_KEY, 'orient', 0, null, asked.engine, null, asked.sessionId);
    return start(KB_MAINTENANCE_KEY, 'orient', { sessionId: asked.sessionId, message: text, engine: asked.engine });
  };

  /**
   * A read-only assessment of one Scout finding.
   *
   * It takes the Scout lane, so a second finding's assessment waits and work that has nothing to do
   * with Scout goes past. The lane is what holds one at a time, which is why every assessment
   * carries the key of its own finding: the queue refuses a second run under one key with an
   * exception, and an exception is not a wait.
   *
   * A second assessment of the same finding is refused while the first one is in the queue. Once
   * that one has ended, another run writes over the file in the same folder, the way a second run of
   * any phase does.
   */
  const assess = (findingId: number): boolean => {
    const key = assessKey(findingId);
    const queue = scheduler.queue();
    // Before the run row, not after: `enqueue` throws for a key it already holds, and a throw there
    // would leave a row queued with no job behind it and nothing to end it.
    if ([...queue.waiting, ...queue.running].some((job) => job.cardKey === key)) {
      throw new Error(`Finding ${findingId} has an assessment in the queue already. Wait for it to end, then read what it wrote.`);
    }
    // Built first, so a refusal is a sentence the person reads on the Scout screen. There is no card
    // for a board to carry the failure on.
    buildJob(key, 'assess', 0);
    const started = start(key, 'assess');
    // After the start and not before it. A finding moved first would sit in the assessment column
    // with nothing running for it.
    if (started) assessScoutFinding(db, findingId);
    return started;
  };

  // The oldest waiting card goes, alone: its wrap-up may leave a change of its own waiting, and the
  // next card must run on top of it. A knowledge run that ends asks again, so the next one goes
  // once nothing waits.
  const reviewAnswered = (): void => {
    // A start that fails writes its reason on its card and starts nothing, so the next one is asked.
    for (;;) {
      if (closed) return;
      const oldest = [...waitingReview][0];
      if (oldest === undefined || pendingKnowledgeChanges(db).length > 0 || knowledgeBusy()) return;
      const [runId, held] = oldest;
      waitingReview.delete(runId);
      // The row only stood for the wait. The run that starts now writes its own.
      db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
      let started = false;
      try {
        started = held.go();
      } catch (error) {
        failStart(held.key, held.phase, error);
      }
      changed();
      if (started) return;
    }
  };
  // A knowledge run of this project in the queue: the one released last has not ended yet.
  const knowledgeBusy = (): boolean => {
    const queue = scheduler.queue();
    return [...queue.running, ...queue.waiting].some((job) => job.lane === 'knowledge');
  };

  const stopRun = (runId: number): void => {
    const held = waitingReview.get(runId);
    if (held !== undefined) {
      waitingReview.delete(runId);
      saveRun(db, runId, foldRun([], true));
      db.prepare("UPDATE cards SET state = 'idle' WHERE key = ?").run(held.key);
      changed();
      return;
    }
    // Asked before the stop, because the stop is what takes it out of the queue. A running job ends
    // through startJob, which writes both rows; a waiting one never gets there, and left alone its
    // run row stays queued and its card with it, which canMove refuses in both directions for good.
    const waiting = scheduler.queue().waiting.find((job) => job.runId === runId);
    scheduler.stop(runId);
    if (waiting === undefined) return;

    // The same fold and the same two writes startJob makes, so a stop reads the same either way.
    const record = foldRun([], true);
    saveRun(db, runId, record);
    // A triage stopped while it waited hands the card back as its end would.
    const phase = (db.prepare('SELECT phase FROM runs WHERE id = ?').get(runId) as { phase: string } | undefined)?.phase;
    const fixRun = fixOf(waiting.cardKey, runId);
    const check = checkOf(waiting.cardKey, runId);
    if (check !== undefined) checking.delete(waiting.cardKey);
    if (fixRun !== undefined) fixEnded(waiting.cardKey, fixRun, 'The fix was stopped before it started.');
    else db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(phase === 'feedback' ? triageBack(waiting.cardKey) : (check?.from ?? record.cardState), waiting.cardKey);
    changed();
  };

  // The slots are the machine's, so Ctrl+C stops the runs of every project (`sharedScheduler`).
  // A Start pressed by hand runs in its own process group, so it goes with Nolzu here too.
  // A card waiting for a review ends as stopped, so the next start does not read it as cut off.
  // Every project of this data folder, as the shared scheduler stops them all. Ended again once the
  // runs have stopped, for a wait a run's end made on the way.
  const stopAllWaits = (): void => {
    for (const [key, one] of open) if (key === dataFolder || key.startsWith(`${dataFolder}#`)) one.stopWaiting();
  };
  const shutdown = (): Promise<void> => {
    stopAllWaits();
    return Promise.all([shared.shutdown(), releaseAll()]).then(() => stopAllWaits());
  };

  // Where the knowledge folder's state before a card's wrap-up is kept while that wrap-up is not
  // finished. It sits in the data directory, because the engine may write in the card folder.
  // Learn this project keeps its own beside Optimize's under the same key: an Optimize that went on
  // from one waiting for an answer would commit what it wrote, which always waits for review.
  const beforeFile = (job: Pick<Job, 'cardKey' | 'phase'>): string =>
    join(dataDir, 'knowledge-before', `${job.cardKey}${job.cardKey === KB_MAINTENANCE_KEY && job.phase === 'orient' ? '-orient' : ''}.json`);

  /**
   * The state the knowledge folder had before this card's wrap-up started, when an earlier attempt
   * left one.
   *
   * A run that ended blocked or failed left its files in the folder. A fresh reading would take
   * them for the person's own work and never commit them, so the answer to a question, or a retry
   * after a refused commit, would report success and lose what the run wrote.
   */
  const rememberedBefore = (job: Pick<Job, 'cardKey' | 'phase'>): readonly string[] | null => {
    if (!existsSync(beforeFile(job))) return null;
    return JSON.parse(readFileSync(beforeFile(job), 'utf8')) as string[];
  };

  // Kept while the wrap-up has no end a person accepted, and dropped once one run of it ends ready,
  // because from then on what is in the folder is the person's again.
  const rememberBefore = (job: Pick<Job, 'cardKey' | 'phase'>, before: readonly string[] | null): void => {
    if (before === null) {
      rmSync(beforeFile(job), { force: true });
      return;
    }
    mkdirSync(join(dataDir, 'knowledge-before'), { recursive: true });
    writeFileSync(beforeFile(job), JSON.stringify(before));
  };

  /**
   * Gets the knowledge folder ready for a run that writes knowledge, and reads its state.
   *
   * Null for every other phase. The default folder inside the project is made here, because
   * `checkKnowledgeDir` refuses a folder that is not there and nothing has made it before the first
   * wrap-up. A folder a person typed is never made: they chose a path, and a typo would leave a new
   * empty folder somewhere on their machine instead of a sentence.
   */
  const openKnowledge = async (
    job: Job,
    project: string | null,
    signal: AbortSignal,
  ): Promise<{ run: RunGit; forPatch: RunGit; sweep: () => boolean; before: readonly string[] } | null> => {
    const folder = job.knowledgeDir ?? null;
    if (folder === null) return null;

    if (getSetting(db, 'knowledgeDir') === null) mkdirSync(folder, { recursive: true });
    // Held to the folder's repository as it is before the run, and `forPatch` stops reading past
    // the cap, the way `filePatch` does for a card.
    const { run, forPatch, sweep } = await knowledgeGit(folder, gitEnv(env), signal);
    const check = await checkKnowledgeDir(folder, { projectPath: project, run, repos: reposNow().map((repo) => repo.path) });
    // Before the engine, so a folder nothing can be committed from stops the run rather than
    // letting it write knowledge that stays where nobody sees it.
    if (!check.ok) throw new Error(check.reason ?? `The knowledge folder ${folder} cannot be used.`);
    return { run, forPatch, sweep, before: rememberedBefore(job) ?? (await knowledgeState(run)) };
  };

  // The team hub's writer, or the stub a test handed in. A machine on no team has none open, and
  // `sendToTeamHub` answers false there, which is the case the sentence below the send covers.
  const sendTeam = options.sendTeam ?? ((type: RunnerMessageType, payload: unknown) => sendToTeamHub(type, payload, registered.id));

  // One scheduler for every project of the data folder. The first loop makes it
  // with the machine's slot count, and is the boot that sweeps every project; each job comes back here
  // to run against this project.
  const booting = !schedulers.has(dataFolder);
  const shared = sharedScheduler(schedulers, dataFolder, getSetting(db, 'agentSlots'));
  const scheduler = shared.join(registered.id, {
    async startJob(queued, signal, onEvent) {
      // Rebound once, when the run's MCP servers are known, right before the engine starts.
      let job = queued;
      const started = Date.now();
      const events: RunEvent[] = [];
      // Held from the checkout to the fold, and let go on every way out. A fake run lasts seconds, so it
      // holds nothing unless a test hands in the helpers, and no test holds this machine awake.
      const helpers = options.awake ?? (isFakeMode(env) ? null : systemAwake(env));
      const release = helpers !== null && getSetting(db, 'keepAwake') ? holdAwake(helpers) : () => undefined;
      // The run has its slot. Stamped now, the elapsed time on the card starts with the run.
      markRunning(db, job.runId);
      // Quiet counts from here until the engine's first line. The checkout and a QA stack load come
      // first, and a load that takes minutes reads as Quiet, which is what the card is then.
      live.set(job.runId, { cwd: job.cwd, activity: { runId: job.runId, cardKey: job.cardKey, line: null, outputAt: started } });
      heard(job.runId);
      changed();
      let knowledge: { run: RunGit; forPatch: RunGit; sweep: () => boolean; before: readonly string[] } | null = null;
      let notes: WrittenNotes = { notes: {}, created: [] };
      // The apps this run started, each once it answers, with the Stop of your own commands beside it.
      // A start of your own commands that failed is here too, with no server, so its Stop still runs.
      const apps: { server: AppServer | null; stop: { hook: StackHook; at: string; command: string } | null }[] = [];
      // Why a start failed, for the stack row once its Stop ran.
      let startFailed: string | null = null;
      // A review's head and its newest round file at the start, so the end saves the head this run
      // read, and only when it wrote a new round. Null on every other phase.
      let review: { head: PullHead; before: number } | null = null;
      // The QA copy, once its making began, so it goes however the run ends.
      let copied: string | null = null;
      // The folder of the run's MCP config, which holds the secrets, so it goes however the run ends.
      const mcpDir = join(mcpRunsFolder(dataFolder), `${registered.id}-${job.runId}`);
      // An Implement run's checkouts as they were when it started, so its end can tell a commit or a push.
      let headsAtStart: { checkouts: Checkout[]; heads: Heads[] } | null = null;
      try {
        // The card's own checkout, made when the job gets its slot and before the engine starts, on
        // the card's branch. A second run of the card finds it and goes on in it. A failure here is
        // git's sentence on a failed run, and no engine starts in a folder that is not the card's.
        const project = getSetting(db, 'projectPath');
        // A run that belongs to no card has no branch and no checkout to make. For an assessment
        // that is the point: making one would be a git write by a phase that must cause none.
        if (project !== null && !belongsToNoCard(job.cardKey)) {
          const target = checkoutRoot(project, job.cardKey);
          const repos = reposNow();
          // Research and its kin follow the choice the build made, and a list cleared while the job
          // waited leaves it with a root nobody made, which is the missing list and not a folder error.
          const readsIfUnlisted = readsUnlisted(job.phase, boardOfCard(db, job.cardKey) ?? 'delivery');
          const unlistedNow = repos.length === 0 || reposOfCard(db, job.cardKey) === null;
          const looking = repos.length !== 1 && (picksRepos(job.phase) || (readsIfUnlisted && (unlistedNow || job.cwd === project)));
          if (looking && readsIfUnlisted && job.cwd === target && !existsSync(target)) throw new Error(noRepoList(job.cardKey, boardOf(job.cardKey)));
          // The job was built when it was queued, and it can wait long for its slot. A project changed
          // in between would get the checkout while the engine starts in the old one. Refine and plan
          // on several repositories, or on none, may have chosen the project folder, and an implement
          // can make the root while they wait, so either one is the builder's own choice.
          // A card on one repository starts in that repository's checkout, one folder inside the root.
          if (job.cwd !== target && dirname(job.cwd) !== target && !(looking && job.cwd === project)) {
            throw new Error(`The project changed while ${job.cardKey} waited for its turn, so this run would start in a checkout of the old one. Start the card again.`);
          }
          if (!looking) {
            if (repos.length === 0) throw new Error(NO_REPOSITORY);
            // Asked again here, because a person can clear the list while the job waits.
            const picked = repos.length > 1 ? reposOfCard(db, job.cardKey) : repos.map((repo) => repo.path);
            if (picked === null) throw new Error(noRepoList(job.cardKey, boardOf(job.cardKey)));
            // A list changed while the job waited would start the engine in a checkout nobody makes.
            if (job.cwd !== target && (picked.length !== 1 || job.cwd !== checkoutPath(project, job.cardKey, picked[0]))) {
              throw new Error(`The repositories of ${job.cardKey} changed while it waited for its turn, so this run would start in the wrong one. Start the card again.`);
            }
            // The loop's own environment, so git reads what the loop was given and nothing else.
            const forGit = gitEnv(env);
            const branch = await cardBranch(db, job.cardKey, picked.map((repo) => checkoutPath(project, job.cardKey, repo)), forGit);
            // A project folder that is no repository has no checkout of its own to be the root, so
            // the root is a plain folder that holds the others.
            if (!picked.includes('.')) mkdirSync(target, { recursive: true });
            // In the order the list gives, so the root checkout is made before anything sits in it.
            for (const repo of picked) {
              await ensureWorktree({
                projectPath: project,
                key: job.cardKey,
                repo,
                branch,
                baseBranch: repos.find((one) => one.path === repo)?.base ?? getSetting(db, 'baseBranch'),
                env: forGit,
                signal,
              });
            }
          }
        }
        // The diff the review reads, in the card folder before the engine starts. Here rather than
        // when the card was made, because a second round has to read the head as it is now. A pull
        // request nothing can be read from fails the run with `gh`'s reason and costs no engine call.
        if (job.phase === 'pr-review') {
          const card = db.prepare('SELECT source_ref FROM cards WHERE key = ?').get(job.cardKey) as { source_ref: string | null } | undefined;
          // The stub in a test, the real `gh` in a real run, and null in fake mode, where the writer
          // writes its own patch and nothing calls out. The same shape as `awake` above.
          const gh = options.gh ?? (isFakeMode(env) ? null : ghRunner());
          // The head the diff is read at, asked right before it, because a saved head older than the
          // reviewed code would send a card on Awaiting author back to Incoming with no push after the
          // review. With no answer, the head the last Read pull requests saw. Limit: a push between
          // these two calls is reviewed but saved as the older head, so the next read sends the card
          // back once too often. Never too seldom.
          const head = await readPrHead(card?.source_ref ?? null, gh, signal);
          review = { head: head ?? seenHead(db, job.cardKey), before: roundsIn(job.taskDir).at(-1)?.number ?? 0 };
          await writePrDiff({
            taskDir: job.taskDir,
            sourceRef: card?.source_ref ?? null,
            gh,
            signal,
            // Asked only when GitHub sends no diff: a pull request too big for it is read from git.
            localRepo: async (owner, name) => {
              const repo = await originRepo(db, owner, name);
              return project === null || repo === null ? null : repoFolder(project, repo);
            },
            gitEnv: gitEnv(env),
            note: (line) => noteInRunLog(job.logPath, line),
          });
        }
        // The comments a triage reads, in the card folder before the engine starts, as the diff is for
        // a review. Written now and not when the run was queued, so a read in between is in it.
        if (job.phase === 'feedback') {
          const card = db.prepare('SELECT title FROM cards WHERE key = ?').get(job.cardKey) as { title: string } | undefined;
          writeFeedbackFile(db, job.cardKey, card?.title ?? job.cardKey, job.taskDir);
        }
        // Implement, and a Fix with it, is told not to commit or push, and nothing in the wall stops it,
        // so its checkouts are read now and again at its end (`fix-check.ts`). After the checkout is
        // made, so a fresh one counts as the start. A resumed run is a run of its own here.
        if (project !== null && job.phase === 'implement') {
          const checkouts = (reposOfCard(db, job.cardKey) ?? []).map((repo) => ({ repo, path: checkoutPath(project, job.cardKey, repo) }));
          headsAtStart = { checkouts, heads: await readHeads(checkouts, gitEnv(env)) };
        }
        // A summary an earlier run of this phase left in the card folder is not this run's. The skill
        // writes a new one; without this, a run that wrote none would show the old one as its own.
        removeCardFile(job.taskDir, join(job.phase, 'summary.md'));
        // The same for the answers an earlier question offered. A run that asks again with no file
        // would show the old buttons under its new question.
        removeCardFile(job.taskDir, join(job.phase, QUESTION_FILE));
        // The knowledge folder, checked and read before the engine starts, so what this run changes
        // can be told from what was already there.
        knowledge = await openKnowledge(job, project, signal);
        // QA owns the local app, so its run starts the card's code first, the way each repository's answer
        // under Start the app says. Before the engine, because a verdict from an app that never came up is
        // worth nothing, and the sentence the run then fails with is the command's own.
        const qaApps = job.phase === 'qa' ? getSetting(db, 'qaApp') : null;
        // These files are written inside the card folder only, never through a link a run left there.
        const addresses = join('qa', 'addresses.md');
        const writeAddresses = (lines: readonly string[]): void => {
          if (lines.length === 0) return;
          writeCardFile(job.taskDir, addresses, `${lines.join('\n')}\n`);
        };
        // What your own start printed besides its addresses, such as a part of the app it could not
        // point at the card's code. QA reads it before it judges the app.
        const startNotes = join('qa', 'app-start.md');
        // The addresses and notes an earlier load printed are not this one's. Gone before the command
        // runs, so a load that throws or fails leaves QA no old address to check against.
        if (job.phase === 'qa') {
          removeCardFile(job.taskDir, addresses);
          removeCardFile(job.taskDir, startNotes);
        }
        // The qa skill moves each screenshot into `qa/evidence/`, and a move into a folder that is not
        // there fails, so the folder is there before the engine starts.
        if (job.phase === 'qa') makeCardFolder(job.taskDir, join('qa', 'evidence'));
        // The report this run writes over, kept, so every QA round can still be read.
        if (job.phase === 'qa') {
          const kept = keepReport(join(job.taskDir, 'qa'));
          if (kept !== null) noteInRunLog(job.logPath, `Kept the report of the QA before as ${kept}.`);
        }
        if (qaApps !== null) {
          // Each repository the card changed, with its own answer. A project of one repository has one.
          const several = reposNow().length > 1;
          const picked = (project === null ? [] : qaReposOf(db, job.cardKey)).map((repo) => ({ repo, answer: answerFor(qaApps, repo) }));
          const failed = (reason: string): never => {
            const status = { state: 'failed' as const, reason };
            saveStackStatus(db, job.runId, status);
            markStack(job.cardKey, status);
            throw new Error(reason);
          };
          // What a start that failed printed, in the run's log, as far as Nolzu keeps it (`OUTPUT_TAIL`).
          // The run's reason carries its last line only, and no engine log follows.
          const keepPrinted = (command: string, output: string | undefined): void => {
            const printed = output?.trim() ?? '';
            if (printed !== '') noteInRunLog(job.logPath, `${command} printed before it failed:\n\n\`\`\`\n${printed}\n\`\`\``);
          };
          const open = picked.find((one) => one.answer === null);
          if (open !== undefined) failed(`QA asks how to run ${open.repo} before it runs. Retry ${job.cardKey} on the board to answer.`);
          // The card's trail says whether the app QA checked was one Nolzu started.
          const running = picked.flatMap(({ repo, answer }) => (answer?.mode === 'running' ? [{ repo, address: answer.address }] : []));
          const lines = running.map((one) => `${several ? one.repo : 'app'} ${one.address}`);
          const said: string[] = [];
          const notes: string[] = [];
          // Own commands under `*` run once for the card, first, and a repository's own answer wins over them.
          const owns = ownStarts(qaApps, picked.map(({ repo }) => repo));
          type Start = { repo: string | null; answer: OwnApp } | { repo: string; answer: Extract<QaApp, { mode: 'dev' }> };
          const starts: Start[] = [
            ...owns.filter((own) => own.repo === null),
            ...picked.flatMap<Start>(({ repo, answer }) => (answer?.mode === 'dev' ? [{ repo, answer }] : owns.filter((own) => own.repo === repo))),
          ];
          // A Start pressed by hand goes first, so QA never starts the app on top of it.
          await releaseHeld(job.cardKey);
          if (starts.length > 0) markStack(job.cardKey, { state: 'loading', reason: null });
          for (const { repo, answer } of starts) {
            const name = repo === null || !several ? 'app' : repo;
            if (answer.mode === 'own') {
              // Outside the wall, because your own commands may start Docker, in the card's copy of the
              // repository with the stack variables (NOLZU_CARD_KEY, NOLZU_PROJECT, NOLZU_REPOS).
              const at = ownFolder(project ?? '', job.cardKey, repo);
              const command = stackCommand(answer.start, job.cardKey);
              if (!existsSync(at)) failed(`${job.cardKey} has no checkout${repo === null ? '' : ` of ${repo}`}, so Nolzu did not run ${command}. Start the card again.`);
              const started = await startApp(command, { cwd: at, env: cardStackEnv(db, job.cardKey, env), signal, mayExit: true, timeoutMs: STACK_TIMEOUT_MS }).catch(
                (error: Error & { output?: string }) => {
                  keepPrinted(command, error.output);
                  const reason = `${command} did not start the app. ${error.message}`;
                  // A load that got halfway is undone like one that answered: its Stop runs after the run.
                  if (answer.stop !== null) {
                    apps.push({ server: null, stop: { hook: { load: null, unload: answer.stop, status: null }, at, command } });
                    startFailed = reason;
                  }
                  return failed(reason);
                },
              );
              apps.push({ server: started, stop: { hook: { load: null, unload: answer.stop, status: null }, at, command } });
              said.push(`Nolzu started ${command}${repo !== null && several ? ` in ${repo}` : ''}${started.address === null ? '' : ` at ${started.address}`}, with no wall.`);
              const printed = stackNotes(started.output);
              if (printed !== '') {
                const note = `${command} printed:\n\n\`\`\`\n${printed}\n\`\`\``;
                noteInRunLog(job.logPath, note);
                notes.push(note);
              }
              // A start that exited names its apps by its `<name> <url>` lines. One that runs on is one app.
              lines.push(...(started.exited && started.named.length > 0 ? started.named : started.address === null ? [] : [`${name} ${started.address}`]));
              continue;
            }
            const dev = answer;
            // Only in the card's own checkout, never in the project's clone, which nobody installed for
            // the card. The checkout is made above for every repository of the card. A start command found
            // one folder down runs there, and so do its scripts check and its install.
            const checkout = checkoutPath(project ?? '', job.cardKey, dev.repo);
            const at = join(checkout, dev.folder ?? '');
            if (!existsSync(at)) failed(`${job.cardKey} has no checkout of ${join(dev.repo, dev.folder ?? '')}, so Nolzu did not run ${dev.command}. Start the card again.`);
            // Implement may have changed what the start command runs, so a change asks the person again.
            const changed = scriptsChanged(db, dev, at, job.cardKey);
            if (changed !== null) failed(changed);
            // Inside the wall, because the scripts come from the card's branch. Where the wall cannot
            // start on this machine, the app starts as before and the stack row says so.
            const ready = wallNow();
            const wall = ready.ready && project !== null ? appWall({ checkout, repoFolder: join(project, dev.repo), project, walls: getSetting(db, 'wallLists'), env }) : undefined;
            const how = { cwd: at, env, signal, ...(wall === undefined ? {} : { wall }) };
            // A fresh checkout has no node_modules, so the start would miss its tools.
            const install = installCommand(at);
            if (install !== null) {
              await installApp(install, how).catch((error: Error) => failed(`${install} failed in ${at}: ${error.message}. Install it by hand in that folder, then move the card into QA again.`));
            }
            const started = await startApp(dev.command, how).catch((error: Error & { output?: string }) => {
              keepPrinted(dev.command, error.output);
              return failed(`${dev.command} did not start the app. ${error.message}`);
            });
            apps.push({ server: started, stop: null });
            const where = join(several ? dev.repo : '', dev.folder ?? '');
            said.push(`Nolzu started ${dev.command}${where === '' || where === '.' ? '' : ` in ${where}`} at ${started.address}.${wall !== undefined ? '' : ready.ready ? ' Not walled: the project folder is not set.' : ` Not walled: ${ready.reason}`}`);
            lines.push(`${name} ${started.address}`);
          }
          const leftAlone = running.map((one) => `QA checks the app already running at ${one.address} and leaves it alone.`);
          const status =
            apps.length > 0
              ? { state: 'up' as const, reason: [...said, ...leftAlone].join(' ') }
              : { state: 'off' as const, reason: running.length > 0 ? ['Nolzu started no app.', ...leftAlone].join(' ') : 'Nolzu started no app. QA checks the code only.' };
          saveStackStatus(db, job.runId, status);
          markStack(job.cardKey, status);
          writeAddresses(lines);
          if (notes.length > 0) writeCardFile(job.taskDir, startNotes, `${notes.join('\n\n')}\n`);
        } else if (job.phase === 'qa') {
          // No answer at all, as on a project with no folder: QA runs the checks that need no app.
          saveStackStatus(db, job.runId, { state: 'off', reason: null });
          markStack(job.cardKey, { state: 'off', reason: null });
        }
        // One run: the engine's lines, parsed, with the quiet timeout and the missing result both
        // reported as a failed event with a reason, and an API error waited out and resumed.
        const retries = {
          waits: getSetting(db, 'retryWaitsMs'),
          // A wait lasts minutes. Saved now, the board reads retrying instead of a run that looks stuck.
          onWait: (wait: RunEvent) => {
            const waiting = foldRun([...events, wait]);
            saveRun(db, job.runId, waiting);
            db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(waiting.cardState, job.cardKey);
            changed();
          },
          // The resumed attempt is live work again, so Quiet counts from the resume and not from
          // the last line before the wait.
          onResume: () => {
            markRunning(db, job.runId);
            heard(job.runId);
            changed();
          },
        };
        // The git state before the run, ahead of the copy so that a stop while the copy is made
        // finds the engine started. The copy is outside the checkout and changes nothing in it.
        // The QA app and stack write their caches into the checkout while the run goes.
        const since = sinceNow();
        const watch = await readBefore(job, apps.length === 0);
        // Last before the engine, so the copy holds what the checkout holds when QA starts.
        if (project !== null && job.qaCopy != null) {
          copied = job.qaCopy;
          const made = await makeQaCopy(job.cwd, job.qaCopy, { skip: [dirname(job.taskDir), worktreesFolder(project)], signal });
          noteInRunLog(job.logPath, `QA works on a throwaway copy of ${job.cwd} at ${job.qaCopy}, made by ${made.method} in ${(made.ms / 1000).toFixed(1)} s. It is deleted after the run.`);
        }
        // The servers of the project's list this phase is on for, with their secrets, last before the
        // engine. Each one left out is a line in the log, never a secret.
        const vendor = engineFor(job.engine).vendor;
        // Cursor gets its servers merged into the `.cursor/mcp.json` it reads (`cursorMergesHere`).
        const tracked = async (root: string) => (await git(['ls-files', '--error-unmatch', '--', '.cursor/mcp.json'], { cwd: root, env: gitEnv(env) })).code === 0;
        const cursorHere = vendor === 'cursor' && project !== null && (await cursorMergesHere({ project, cwd: job.cwd, qaCopy: job.qaCopy, tracked }));
        const planned = promptMcp(project, job.phase, vendor, getSetting(db, 'qaMcpConfigPath'));
        const mcp = await runMcp({ project, projectId: registered.id, phase: job.phase, vendor, keychain, dir: mcpDir, cursorHere, legacy: getSetting(db, 'qaMcpConfigPath') });
        for (const note of mcp.notes) noteInRunLog(job.logPath, note);
        // The prompt names only the servers the run got.
        const got = new Set(mcpNames(mcp.mcp));
        const prompt = swapPromptLine(
          swapPromptLine(job.prompt, browserLine(planned.browser), browserLine(planned.browser.filter((name) => got.has(name)))),
          serversLine(planned.servers),
          serversLine(planned.servers.filter((server) => got.has(server.name))),
        );
        // The titles of the issues the ticket names by number, which the run cannot read itself. A
        // resumed session has the ticket already, and its prompt is the next message alone.
        const named = job.resumeFrom === null ? await namedIssues(db, job.cardKey, options.gh ?? (isFakeMode(env) ? null : ghRunner()), signal) : [];
        // Set with no server too, empty, so the run has its folder for Cursor's record; every walled run
        // hides the data folder's `mcp-runs` whatever this holds (`runConfigWall` in the runner).
        job = { ...job, prompt: withNamedIssues(prompt, named), mcp: mcp.mcp ?? { stdio: {}, remote: {}, rules: {}, dir: mcpDir } };
        // The adapter of the profile the job names, so a job of a Codex profile spawns Codex.
        // The knowledge folder is swept once the events end, also when the loop below throws.
        const sweep = () => {
          if (knowledge?.sweep() === true) noteInRunLog(job.logPath, 'The run made a git repository in the knowledge folder, so Nolzu removed its .git. Nolzu reads and commits the folder through the project repository only.');
        };
        for await (const event of sweptAfter(comparedAround(job, runWithRetries(engineFor(job.engine), job, signal, retries), { watch, since }), sweep)) {
          events.push(event);
          // Kept the moment the run read the line, under the profile the run belongs to, so the
          // Engines screen can say when the numbers were seen. It stays in this machine's store.
          if (event.type === 'rate_limit') saveLimit(db, job.engine, event.windows, Date.now(), belongsToNoCard(job.cardKey) ? undefined : job.cardKey);
          onEvent(event);
        }
        // One commit for the whole run, and one row per file in it. Only a run that finished: a run
        // that died halfway leaves what it wrote in the folder, where a person reads it, rather
        // than in a commit nobody reviewed.
        if (knowledge !== null && foldRun(events, signal.aborted).cardState === 'ready') {
          const state = { run: knowledge.run, cardKey: job.cardKey, runId: job.runId, before: knowledge.before, after: await knowledgeState(knowledge.run) };
          // The notes as the run left them, for the output check, read before a hold puts the folder back.
          notes = await writtenNotes(knowledge.run, job.knowledgeDir ?? '', knowledgeChanges(state.before, state.after)).catch(() => ({ notes: {}, created: [] }));
          // What git says happened to the file, not what the run said about it. The line the run
          // wrote for a person is in the card folder, in its changes file.
          const rows = (changes: readonly { path: string; kind: string }[]) => changes.map((change) => ({ path: change.path, summary: change.kind }));
          // The kept copy and one pending row per file. It is what a change waiting for this person
          // leaves behind, and what one waiting for the team leaves behind too.
          const keep = (held: HeldKnowledge) => {
            keepHeld(dataDir, held);
            recordKnowledgeChanges(db, { cardKey: job.cardKey, runId: job.runId, commitSha: null, status: 'pending', files: rows(held.files) });
          };
          // The one read that says this is a team project: the id the team hub minted, which a
          // `project.join` job wrote. Read now and not when the run started, because the machine
          // may have joined a team while the engine worked. While the cloud is closed no team hub can
          // be reached, so a stored id is no team: the change is handled as on a free project, committed,
          // or held for this person when review is on.
          const teamProjectId = CLOUD_OPEN ? getSetting(db, 'teamProjectId') : null;

          if (teamProjectId !== null) {
            // A team project's knowledge belongs to the team, so this machine commits nothing and
            // the folder goes back to what it was, as under review. The diffs are read first,
            // because git reads a patch off the files the run wrote and the hold takes them away.
            const files = await knowledgeDiffs({ ...state, run: knowledge.forPatch });
            await holdKnowledge({ ...state, keep });
            // `knowledgeDiffs` reads the change list `holdKnowledge` holds and describes every file
            // of it or throws, so an empty list here is a run that wrote nothing: the hold keeps
            // nothing, no row is written, and there is nothing to tell the team about.
            //
            // Limit: sent once, with no receipt. A true below is a socket write that did not
            // throw, `sendTeam` in `runner/src/hub.ts`, and the hub acks no frame of this kind, so
            // a frame it drops leaves a pending row here and nothing on the team board. Resending
            // on every connect, the way `registerProject` does, needs an ack to stop resending,
            // and an ack is a frame both sides have to learn. Store the frame as owed and resend
            // it the day the hub answers one.
            if (files.length > 0 && !sendTeam('knowledge.proposals', { teamProjectId, cardKey: job.cardKey, runId: job.runId, files })) {
              // The change is on this machine, whole, and the team does not have it. Nothing is
              // retried from here: the person reads this line, and the change waits under their own
              // Approve and Return on the Knowledge screen.
              console.error(
                `The knowledge change of ${job.cardKey} run ${job.runId} did not reach the team, because the link to the team hub is not open. It waits on the Knowledge screen.`,
              );
            }
          } else if (getSetting(db, 'reviewKnowledge') || policyFor(job.phase).alwaysHeld === true) {
            // Review on, or a run whose writing always waits, which is Learn this project: the
            // person's knowledge files never carry content nobody approved. The
            // run's writing is kept aside, the folder goes back to what it was, and one pending
            // row per file waits on the Knowledge screen.
            await holdKnowledge({ ...state, keep });
          } else {
            // In the project's commit turn, which the MCP list's commit takes too: in a workspace both
            // commit into the same repository, and two at once would stage each other's files.
            const commit = () =>
              commitKnowledge({
                ...state,
                record: (made) => {
                  recordKnowledgeChanges(db, { cardKey: job.cardKey, runId: job.runId, commitSha: made.commit, status: 'applied', files: rows(made.changes) });
                },
              });
            await (project === null ? commit() : inTurn(project, commit));
          }
        }
      } catch (error) {
        // A checkout that cannot be made lands here with git's sentence. runJob turns what the engine
        // throws into an event of its own. The scheduler swallows what leaves here, and a failure then
        // used to leave the row and the card exactly as the move left them, queued, which refuses
        // every drag for good. The card should carry the reason rather than a failure with nothing
        // in it.
        events.push({ type: 'failed', reason: (error as Error).message, status: null });
      }
      // The catch above ends every way out of the run, so this is reached however it went.
      release();
      // The engine loop has ended: Cursor's merge goes back if its spawn could not do it, and Claude Code's
      // config goes if a kill left it.
      restoreCursorMcp(mcpDir);
      try {
        rmSync(mcpDir, { recursive: true, force: true });
      } catch (error) {
        // The boot sweeps it. The run's end goes on: its row, the app's stop and the QA copy.
        noteInRunLog(job.logPath, `The run's MCP folder ${mcpDir} could not be removed (${(error as Error).message}). The next start of Nolzu removes it.`);
      }
      if (copied !== null) {
        const gone = copied;
        await removeQaCopy(gone).catch((error: Error) => noteInRunLog(job.logPath, `The QA copy at ${gone} could not be deleted (${error.message}). The next start of Nolzu deletes it.`));
      }
      // A Start pressed by hand before this run is held until the end of the card's QA.
      if (job.phase === 'qa') await releaseHeld(job.cardKey);
      // The apps go down whatever the run did. No signal, because a run a person stopped still has to give
      // the machine back. Each process still running is stopped, then the Stop of your own commands runs. A Stop that fails leaves the row saying the app is up.
      if (apps.length > 0) {
        markStack(job.cardKey, { state: 'unloading', reason: null });
        const left: string[] = [];
        for (const { server, stop } of apps) {
          await server?.stop();
          if (stop === null) continue;
          if (stop.hook.unload === null) {
            if (server?.exited === true) left.push(`No Stop command is set, so what ${stop.command} started is still up.`);
            continue;
          }
          const down = await runStackHook(stop.hook, 'unload', job.cardKey, { cwd: stop.at, env: cardStackEnv(db, job.cardKey, env), timeoutMs: STACK_UNLOAD_TIMEOUT_MS })
            .then((result) => stackStatusAfter('unload', result))
            .catch((error: Error) => ({ state: 'up' as const, reason: `The Stop command could not run: ${error.message}. The app is still up.` }));
          if (down.state === 'up') left.push(down.reason ?? '');
        }
        const status =
          left.length > 0
            ? { state: 'up' as const, reason: left.join(' ') }
            : startFailed !== null
              ? { state: 'off' as const, reason: `${startFailed} Nolzu ran the Stop command after it.` }
              : { state: 'off' as const, reason: apps.length === 1 ? 'The app Nolzu started for this run was stopped after it.' : 'The apps Nolzu started for this run were stopped after it.' };
        // The run's own row keeps that its start failed. The card's row is the stack as it is now.
        if (startFailed === null) saveStackStatus(db, job.runId, status);
        markStack(job.cardKey, status);
      }
      // One fold, and both writes read from it. Recomputing the card from the events instead threw
      // away what the fold knew about a stop, so the row said stopped and the board said failed.
      const ended = foldRun(events, signal.aborted);
      // What QA decided, read from what the run itself said. Only a run that reached its end: a
      // failure, a stop or a question is already the card's answer, and a verdict cannot undo it.
      const judged = job.phase === 'qa' && ended.cardState === 'ready';
      const verdict = judged ? extractVerdict(said(events)) : null;
      // BLOCKED is a question for a person and not a result, so it takes the path a blocked run
      // already takes: the card blocks on the reason, and answering it resumes this QA session.
      if (verdict?.verdict === 'BLOCKED') events.push({ type: 'needs_input', question: verdict.reason ?? NO_REASON });
      const record = verdict?.verdict === 'BLOCKED' ? foldRun(events, signal.aborted) : ended;
      // What a wrap-up that did not end ready left in the folder is still this card's work. Holding
      // its reading of the folder is what lets the next run of the card commit those files.
      if (knowledge !== null) rememberBefore(job, record.cardState === 'ready' ? null : knowledge.before);
      // Before the row reads complete, so whoever reads the run as done reads the card's list with it.
      if (record.cardState === 'ready') {
        keepNamedReposSafely(job, started);
        takeRefinedTitle(job, started);
        // After the title, because the template's {slug} reads the title Refine just set.
        await renameAfterRefine(job);
      }
      // The same for a review's round and the head it read. A run that wrote no new round file saves
      // nothing, so the card never claims a review that is not on the Review tab.
      const round = review === null || record.cardState !== 'ready' ? 0 : (roundsIn(job.taskDir).at(-1)?.number ?? 0);
      if (review !== null && round > review.before) savePullRound(db, job.cardKey, round, review.head);
      // A triage's verdicts onto the card's rows, before the card reads ready, so the PRs tab that
      // reloads on that change draws them. A file that does not parse changes no row; the tab shows
      // why, and the log keeps it too.
      if (job.phase === 'feedback' && record.cardState === 'ready') {
        try {
          const applied = applyTriageFile(db, job.cardKey, job.taskDir);
          if (!applied.ok) noteInRunLog(job.logPath, `${applied.problem} No row took a verdict from it.`);
        } catch (error) {
          noteInRunLog(job.logPath, `The triage could not be applied: ${(error as Error).message}`);
        }
      }
      // The card goes back to what it was, so nothing waits for an answer to a triage's question.
      if (job.phase === 'feedback' && record.cardState === 'blocked') noteInRunLog(job.logPath, 'The triage asked a question, and a triage takes no answer. No row took a verdict. Run triage again.');
      // Before the row says blocked, so the board never draws the question without the answers the
      // run offered. A missing or broken file stores none, and the question stays plain text.
      // A commit or a push the Implement run made, in the run log either way. The commits stay:
      // undoing them is the person's call. Read before the row says the run ended, so whoever waits
      // on the row finds the card landed with it. A read that throws lands on every checkout as its
      // reason, never as a pass.
      const start = headsAtStart;
      const end = start === null ? [] : await readHeads(start.checkouts, gitEnv(env)).catch((error: Error) => start.checkouts.map((one) => ({ repo: one.repo, problem: error.message })));
      const moved = start === null ? null : runMoved(start.heads, end, fixOf(job.cardKey, job.runId) === undefined ? 'implement' : 'fix');
      if (moved !== null) noteInRunLog(job.logPath, moved);
      if (record.cardState === 'blocked') saveQuestionOptions(db, job.runId, parseQuestionOptions(readCardText(job.taskDir, join(job.phase, QUESTION_FILE))));
      // The files other people read never say a tool wrote them, whatever the run ended as. An engine
      // adds such a line by habit, so it goes before the output check reads the files.
      try {
        const stripped = stripSharedAttribution(job.taskDir);
        if (stripped.length > 0) noteInRunLog(job.logPath, `Took the line that named a tool as the writer out of ${stripped.join(", ")}.`);
      } catch (error) {
        noteInRunLog(job.logPath, `The shared files could not be checked for a tool line: ${(error as Error).message}`);
      }
      saveRun(db, job.runId, record);
      // Only a run that ended ready wrote its files to the end. A failed check moves nothing.
      if (record.cardState === 'ready') checkRunOutputs(db, job, notes);
      // Stored on the run, so the card and the ticket page read back what QA decided and why.
      if (judged) saveVerdict(db, job.runId, verdict ?? { verdict: null, reason: NO_VERDICT });
      try {
        // The plain summary before the card reads ready. An extraction pass, when one is needed, holds
        // this slot, and the card stays running meanwhile: a card that read ready here could be
        // dragged into a second run while this one still holds its place in the queue.
        //
        // Not after a triage: its summary is about the comments, and as the card's summary it would
        // take the place of what the change did on the overview.
        if (record.cardState === 'ready' && job.phase !== 'feedback') {
          const summary = modelsFor(job.cardKey)['extract-summary'];
          await recordSummary(
            {
              db,
              engine: summary.engine,
              summaryModel: { model: summary.model, effort: summary.effort },
              read: (path) => readCardText(job.taskDir, relative(job.taskDir, path)),
              // Its own row's profile, which is where its model came from. A profile this machine
              // does not hold throws here, and the pass is saved as a failed run of its own.
              extract: (extraction) => comparedAround(extraction, runJob(engineFor(extraction.engine), extraction, signal)),
              signal,
            },
            job,
            events,
          );
        }
        // What the phase said, in the thread it belongs to. Without this the discussion is a
        // notebook a person writes into and nobody answers: the agent's reply is in the log, and
        // the thread shows one side of a conversation.
        recordPhaseSummary(db, job);
      } finally {
        live.delete(job.runId);
        // A run of the stage's own phase that ended ready takes the card on by its stage's
        // `advanceOn`, onto a person's column or the archive (`chainTo`). QA goes on with a PASS
        // alone, so FAIL, BLOCKED and a run with no verdict leave the card where a person reads the
        // reason. The chain onto an agent column is the one a person turned on, after it.
        // A Fix ends its row and hands the card back as a triage does: the run's plain summary is its
        // note, and anything but ready leaves the row new with the reason.
        const fixRun = fixOf(job.cardKey, job.runId);
        // A plain Implement run ends as it would, and the card page warns until the next one. A
        // Fix says it on its row instead, so it is not said twice.
        if (moved !== null && fixRun === undefined && !closed) saveCommitWarning(db, job.runId, moved);
        // A fix that stopped on a question, with nothing moved: the row stays fixing and the card waits
        // blocked, so the question is answered on the overview like any run's.
        let asks = false;
        if (fixRun !== undefined) {
          fixes.delete(job.cardKey);
          const outcome = fixOutcome(record, (db.prepare('SELECT plain_summary FROM runs WHERE id = ?').get(job.runId) as { plain_summary: string | null } | undefined)?.plain_summary ?? null);
          // However the run ended, a commit or a push it made sends the row back to new, with the
          // reason it failed after that.
          asks = moved === null && record.cardState === 'blocked';
          if (asks) fixes.set(job.cardKey, { ...fixRun, asked: record.question ?? 'nothing it wrote down' });
          else {
            const failed = moved !== null ? { ok: false as const, reason: outcome.ok ? moved : `${moved} ${outcome.reason}` } : outcome.ok ? null : outcome;
            // Fix all's notes are the lines of its file, one per row, because one summary cannot be split.
            const notes = failed === null && fixRun.all === true ? readFixNotes(job.taskDir) : null;
            for (const row of fixRun.rows) {
              const note = notes?.get(row.ref);
              const missing =
                notes === null
                  ? 'The run wrote no feedback/fixes.md, so it does not say what it did for this comment. Read its edits on the Changes tab.'
                  : `The run wrote no line for ${row.ref} in feedback/fixes.md. Read its edits on the Changes tab.`;
              endFix(db, row.id, failed ?? (fixRun.all !== true ? outcome : note !== undefined ? { ok: true, note } : { ok: false, reason: missing }));
            }
          }
        }
        // QA the fixes: a FAIL sends its failed rows back to new with QA's reason, and the card goes back
        // to the state it had, as after a triage. A question is not waited on.
        const check = checkOf(job.cardKey, job.runId);
        if (check !== undefined) {
          checking.delete(job.cardKey);
          if (verdict?.verdict === 'FAIL') reopenFixed(db, job.cardKey, failedFixes(readCardText(job.taskDir, join('qa', 'report.md')), check.refs, verdict.reason));
          if (record.cardState === 'blocked') {
            noteInRunLog(job.logPath, `QA of the fixes stopped on a question, and it takes no answer: ${record.question ?? 'nothing it wrote down'} Give it what it needs, then press QA the fixes again.`);
          }
        }
        landCard(
          job.cardKey,
          fixRun !== undefined ? (asks ? 'blocked' : fixRun.from) : check !== undefined ? check.from : job.phase === 'feedback' ? triageBack(job.cardKey) : record.cardState,
          fixRun !== undefined || check !== undefined || job.phase === 'feedback' ? null : { id: job.runId, phase: job.phase, verdict: verdict?.verdict ?? null },
        );
        // Kept for the bell, so the end is still there after its toast is gone. An Ask run and a run of
        // no card raise no toast either.
        if (job.phase !== ASK_PHASE && !belongsToNoCard(job.cardKey)) {
          noteRunEnd(db, { id: job.runId, key: job.cardKey, phase: job.phase }, record, judged ? (verdict ?? { verdict: null, reason: NO_VERDICT }) : null);
        }
        noteMaintenanceFailure(db, { id: job.runId, key: job.cardKey, phase: job.phase }, record);
        // Fix it's QA follows only this run, and only when it ended ready.
        const fixed = fixing.get(job.cardKey);
        const then = fixed?.runId === job.runId ? fixed.then : undefined;
        if (then !== undefined) fixing.delete(job.cardKey);
        // A Fix chains nothing without a check here: only a plan run chains on its own, and Fix it's QA
        // follows its own run id, never a fix's.
        if (record.cardState === 'ready' && job.phase !== 'feedback' && check === undefined) chaining.set(job.cardKey, { phase: job.phase, runId: job.runId, ...(then === undefined ? {} : { then }) });
      }
    },
    onEvent(runId, event) {
      heard(runId, event);
    },
    onChange() {
      // A run can end after the loop was closed, and the scheduler says so from its own finally,
      // where nothing can catch what this throws. Writing to a database that is gone takes the
      // process with it.
      if (closed) return;
      // The queue is in memory, so nothing about a position, a slot or a lane reaches the database
      // on its own. Without this bump two different boards would ship under one event id and a
      // stream keyed on it would never resend.
      bumpVersion(db);
      changed();
      // A run leaves the queue right before this is told, and only then can the card take the run of
      // its next stage: the queue holds one run per card. A microtask, so the scheduler finishes its
      // own step before the chain adds to it.
      const queue = scheduler.queue();
      for (const [key, ended] of chaining) {
        if ([...queue.running, ...queue.waiting].some((one) => one.cardKey === key)) continue;
        chaining.delete(key);
        // Nothing waits on this promise, and a rejection nobody catches takes the process with it.
        queueMicrotask(() => void chainOn(key, ended.phase, ended.runId, ended.then).catch(() => undefined));
      }
      // A knowledge run that left the queue may be the one a waiting card was waiting behind.
      if (waitingReview.size > 0) queueMicrotask(reviewAnswered);
    },
    stop: (runId) => stopRun(runId),
    leave: () => leaving.abort(),
    left: async () => {
      await Promise.all(asking);
    },
  });
  giveBack = () => shared.leave(registered.id);

  // Limit: outside the scheduler, so a pass does not wait for a slot or count against one. It is one
  // short read-only call. Put it on a lane if they ever pile up.
  // A pass on the plain summary row: a commit message, or the subject of an Ask discussion. Its own run
  // row carries the card, the model and the cost, so the Log tab and the card's spend show it. `keep`
  // stores a complete answer before the run's end is announced, so a page that reads the card on that
  // news finds what the pass wrote.
  const runPass = async (
    key: string,
    phase: 'commit-message' | 'thread-title',
    prompt: string,
    signal: AbortSignal | undefined,
    folder: (project: string) => string,
    extra: { thread?: string; keep?: (answer: string) => void; scratch?: boolean } = {},
  ): Promise<{ ok: true; answer: string; model?: string; cost?: number | null } | { ok: false; reason: string }> => {
    const project = getSetting(db, 'projectPath');
    if (project === null && !isFakeMode(env)) return { ok: false, reason: 'There is no project set, so this card has no checkout to write a message for.' };
    const resolved = modelsFor(key)['extract-summary'];
    if (resolved.missingProfile) {
      return { ok: false, reason: `The plain summary row runs on the engine profile ${resolved.engine}, which this machine has no login for. Add it on the Engines settings page, or pick another profile for that row.` };
    }
    // Before the run row, so a repository that names no checkout leaves no run behind.
    // A pass that reads nothing runs in a scratch folder of the data folder, not in the person's files,
    // so nothing the person saves meanwhile can look like the pass wrote it.
    const cwd = extra.scratch === true ? join(dataDir, 'passes') : project === null ? dataDir : folder(project);
    if (extra.scratch === true) mkdirSync(cwd, { recursive: true });
    const runId = startRun(db, { cardKey: key, phase, engine: resolved.engine, model: resolved.model, effort: resolved.effort, sessionId: null, logPath: '', lane: null, thread: extra.thread });
    const logPath = join(dataDir, 'logs', `${key}-${phase}-${runId}.ndjson`);
    db.prepare('UPDATE runs SET log_path = ? WHERE id = ?').run(logPath, runId);
    const job: Job = {
      runId,
      cardKey: key,
      engine: resolved.engine,
      phase,
      cwd,
      taskDir: join(project ?? dataDir, '.tasks', key),
      projectDir: project,
      prompt,
      model: resolved.model,
      effort: resolved.effort,
      sessionId: null,
      resumeFrom: null,
      timeoutMs: getSetting(db, 'runTimeoutMs'),
      logPath,
      lane: null,
      mcpConfigPath: null,
      // The guard as well: the pass reads the checkout, and the guard is what holds it to reading.
      settingsPath: engineSettings(project),
      tools: EXTRACT_SUMMARY_POLICY.tools,
    };
    const events: RunEvent[] = [];
    const stopping = signal === undefined ? leaving.signal : AbortSignal.any([signal, leaving.signal]);
    try {
      // The git compare watches the folder a pass reads. A scratch folder holds no repository to watch.
      const run = runJob(engineFor(job.engine), job, stopping);
      for await (const event of extra.scratch === true ? run : comparedAround(job, run)) events.push(event);
    } catch (error) {
      events.push({ type: 'failed', reason: (error as Error).message, status: null });
    }
    const ended = foldRun(events, stopping.aborted);
    saveRun(db, runId, ended);
    if (ended.state === 'complete') extra.keep?.(said(events));
    changed();
    if (ended.state !== 'complete') return { ok: false, reason: ended.failureReason ?? `The ${resolved.engine} engine wrote no message. Its log is on the Log tab.` };
    // The model as the row names it ("haiku"), and the cost the engine reported, null when it reported none.
    return { ok: true, answer: said(events), model: resolved.model, cost: ended.costUsd };
  };

  const writeMessage: Loop['writeMessage'] = async (key, prompt, signal, repo = '.') => {
    if (!isPlainName(key)) return { ok: false, reason: `The card key ${JSON.stringify(key)} is not one plain name, so it names no checkout.` };
    const passing = runPass(key, 'commit-message', prompt, signal, (project) => checkoutPath(project, key, repo));
    const ends = passing.then(
      () => undefined,
      () => undefined,
    );
    asking.add(ends);
    void ends.finally(() => asking.delete(ends));
    return passing;
  };

  // The subject of an Ask discussion, from its first question and answer. Nothing waits on it: the
  // conversation goes on while it runs, and a pass that fails leaves the list on the first message.
  // It reads nothing, so it runs in a scratch folder with no git compare around it.
  const titleThread = (key: string, thread: string, question: string, reply: string): Promise<void> =>
    runPass(key, THREAD_TITLE, threadTitlePrompt(question, reply), undefined, (project) => project, {
      thread,
      scratch: true,
      keep: (answer) => {
        const subject = cleanSubject(answer);
        if (subject === null) return;
        saveSubject(db, key, thread, subject, false);
        bumpVersion(db);
      },
    }).then(() => undefined);

  const made: Loop = {
    db,
    project: registered.id,
    dataDir,
    boardOf,
    get engine() {
      // The shared fake itself, so a spawn replaced on it reaches every vendor's adapter.
      return fake ?? defaultEngine();
    },
    models: offered,
    scheduler,
    // Asked every time, so a model an engine stops offering reads as gone on the next board.
    // The board a screen asks for. Delivery by default, because every caller that reads the queue
    // lanes off a snapshot wants any board and that one is always there.
    snapshot: (kind: BoardKind = 'delivery') =>
      withAfterLearn(
        boardSnapshot(db, { board: boardFor(kind, getSetting(db, 'deliveryFlow')), queue: shared.queue(), project: registered.id, models: offered(), planned: (key) => planSteps(db, key, env), wall: wallNow() }),
        { db, scheduler },
      ),
    buildJob,
    start: (key, phase) => start(key, phase),
    optimize,
    learn,
    learnRepos,
    assess,
    answer,
    discuss,
    retry,
    fix,
    sendBack,
    triage,
    fixFeedback,
    fixAll,
    qaFixes,
    writeMessage,
    stop: stopRun,
    reviewAnswered,
    stopWaiting: () => {
      stoppingWaits = true;
      for (const runId of [...waitingReview.keys()]) stopRun(runId);
    },
    shutdown,
    onChange(listen) {
      listeners.add(listen);
      return () => {
        listeners.delete(listen);
      };
    },
    listeners: () => listeners.size + watchers.size,
    changed,
    activity: () => [...live.values()].map((entry) => entry.activity),
    onActivity(listen) {
      watchers.add(listen);
      return () => {
        watchers.delete(listen);
      };
    },
    watchPulls,
    close() {
      // A burst of grid clicks still waiting for its commit goes now, and the boot commits what is left.
      void flushMcpCommit(getSetting(db, 'projectPath'));
      closed = true;
      clearInterval(pullTimer);
      listeners.clear();
      watchers.clear();
      db.close();
      open.delete(cacheKey);
      shared.leave(registered.id);
    },
  };

  // A crash leaves rows claiming work no process is doing, and this is the first moment anything can
  // say so. The lock comes first and the sweep second, which is why startWriting does both: a second
  // Nolzu that swept before being refused would close the runs the first one is still doing. The lock
  // is in machine.db, so a second server is refused whatever project it opens.
  startWriting(db, { dataDir: dataFolder, startedAt: processStart });
  sayCutOff(db);
  // The QA copies a crash left. Only at the boot of the data folder, when no project runs anything,
  // so every copy there is old.
  const sweepCopies = (project: string | null) => {
    if (project !== null) sweepQaCopies(qaCopyRoot(dataFolder, project));
  };
  // The checkouts a crashed forced removal left in each repository's `.git/nolzu-removing`, deleted in
  // the background, so a large one does not hold up the boot.
  const sweepRemoved = (from: DatabaseSync) => {
    const project = getSetting(from, 'projectPath');
    if (project === null) return;
    for (const repo of projectRepos({ repos: getSetting(from, 'repos'), baseBranch: getSetting(from, 'baseBranch') })) {
      let folder: string;
      try {
        folder = repoFolder(project, repo.path);
      } catch {
        continue;
      }
      sweepRemovals(folder, env).catch((error: Error) => console.error(`The checkouts moved aside in ${folder} were not deleted: ${error.message}`));
    }
  };
  if (booting) {
    // A Cursor run's merged `.cursor/mcp.json` goes back first, a QA copy's while the copy is there,
    // then the run folders a crash left go.
    sweepMcpRuns(dataFolder);
    sweepQaCopies(join(dataFolder, 'qa-copies'));
    sweepCopies(getSetting(db, 'projectPath'));
    sweepRemoved(db);
  }
  // The QA browser of the old setting moves into the list once, under the lock. A refusal keeps the
  // setting, which QA goes on using, and both settings pages say why.
  const projectAtBoot = getSetting(db, 'projectPath');
  migrateQaBrowser(db, registered.id, keychain, join(dataDir, PLAYWRIGHT_FILE))
    .then(async (problem) => {
      if (problem !== null) console.error(problem);
      // A list a closed loop left uncommitted, such as a burst of grid clicks, is committed now.
      const unsaved = await commitMcpList(projectAtBoot, env);
      if (unsaved !== null) console.error(unsaved);
    })
    .catch((error: Error) => console.error(`The QA browser was not moved to Settings, MCP servers: ${error.message}`));
  // One scheduler runs every project, so the boot sweeps the others too, under the lock it now holds. A
  // project whose loop opens later was swept here and has run nothing since.
  if (booting) {
    for (const other of registeredProjects(db)) {
      if (other.id === registered.id) continue;
      let swept: DatabaseSync;
      // A project whose database cannot open does not stop this one. Its own loop sweeps it when it
      // opens, or says why it cannot.
      try {
        swept = openProject(dataFolder, other.id);
      } catch {
        continue;
      }
      try {
        recoverRuns(swept);
        sayCutOff(swept);
        sweepCopies(getSetting(swept, 'projectPath'));
        sweepRemoved(swept);
      } finally {
        swept.close();
      }
    }
  }

  // Learn and then start: the held moves, made once no Learn run is left, a restart included.
  afterLearn = followLearn(made, (key, to) => (closed ? null : moveTo(made, key, to)));
  afterLearn();

  open.set(cacheKey, made);
  return made;
  }
}
