import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { type QaApp, recipeHeading, REPO_FILE, repoKnowledgePath, RUN_RECIPE_FILE, SHARE_FILES, SHARED_FOLDER } from '@nolzu/core';
import { ASK_PHASE, NEEDS_INPUT_PREFIX, phaseLabel, SENTINEL_COMPLETE } from '@nolzu/protocol';

// The prompt a run was sent, written beside the method so the Files tab shows what the run was told.
export const PROMPT_FILE = 'prompt.md';

// The file every engine reads the phase method from. It lies in the card folder, under the phase,
// which the run already has open, so nothing new is opened to the run for it.
export const INSTRUCTIONS_FILE = 'instructions.md';

// The list of what QA will check. Plan writes it, in QA's folder because QA reads it there. It is the
// one file a phase writes outside its own folder, so the Files tab credits it to Plan from this name.
export const QA_CHECKS_FILE = 'qa/checks.md';
// The plan an epic's Plan writes for colleagues, one plain task per step.
export const SHARE_PLAN_FILE = 'share/PLAN.md';
// The epic's internal notes for one of its tasks, at the top of the task's card folder. Add N tasks
// writes it, and every run of that card reads it, because the ticket holds only the shareable text.
export const FROM_EPIC_FILE = 'from-epic.md';

// The file at the top of the card folder every phase adds what it met on the way to. The wrap-up reads
// it first, and a task's wrap-up reads its epic's too.
export const DISCOVERIES_FILE = 'discoveries.md';

// The documents of an epic a task's run reads, relative to the epic's card folder, in the order the
// epic's phases write them, then the discoveries all of them add to. Mockups is the old name of
// Design, kept for an epic made before it. The epic's QA checks say what QA checks across its tasks.
export const EPIC_DOCS = ['refine/refined.md', 'architecture/architecture.md', 'mockups/mockups.md', 'design/design.md', 'plan/plan.md', QA_CHECKS_FILE, DISCOVERIES_FILE];

// The lists of an epic's drawn screens. Each one's folder also holds the screens and the tokens.
const SCREEN_LISTS = new Set(['mockups/mockups.md', 'design/design.md']);

/**
 * The epic's documents that exist, as paths under its card folder, in the order of `EPIC_DOCS`.
 *
 * The screens and tokens of its design follow its list, so a task's Implement can reuse the tokens
 * and match the screens, and its QA can compare with them. Each file is named, because a task's run
 * gets a read rule per file and none for a folder.
 */
export function epicDocPaths(epicFolder: string): string[] {
  return EPIC_DOCS.flatMap((doc) => {
    const at = join(epicFolder, doc);
    const found = existsSync(at) ? [at] : [];
    if (!SCREEN_LISTS.has(doc) || !existsSync(dirname(at))) return found;
    const drawn = readdirSync(dirname(at), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(html?|css)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    return [...found, ...drawn.map((name) => join(dirname(at), name))];
  });
}

// The files of its own card folder each phase reads before it starts, written by the phases before it.
// The prompt names them, because a run left to find them by itself often never opens them. The skills
// name the same files, so a run that skips the list still finds them. A phase missing here reads no
// earlier file. A re-review's earlier rounds are found by name, with the Review tab's reader.
// The share files ride along: QA corrects TESTING.md, and the wrap-up gives both a last pass.
const IMPLEMENT_FILES = ['implement/progress.md', 'implement/deviations.md', 'implement/pr.md', ...SHARE_FILES];
export const READ_FIRST: Readonly<Record<string, readonly string[]>> = {
  architecture: ['refine/refined.md', DISCOVERIES_FILE],
  design: ['refine/refined.md', 'architecture/architecture.md', DISCOVERIES_FILE],
  plan: EPIC_DOCS.filter((doc) => doc !== 'plan/plan.md' && doc !== QA_CHECKS_FILE),
  implement: EPIC_DOCS,
  qa: [...EPIC_DOCS, ...IMPLEMENT_FILES],
  wrapup: [...EPIC_DOCS, ...IMPLEMENT_FILES, 'qa/report.md', 'research/answer.md', 'investigate/report.md'],
};

/**
 * The files of `READ_FIRST` for this phase that exist in the card folder, as paths under it. The card
 * folder is open to every run, so no file here needs a read rule of its own.
 */
export function readFirstPaths(cardFolder: string, phase: string): string[] {
  return (READ_FIRST[phase] ?? []).map((doc) => join(cardFolder, doc)).filter((path) => existsSync(path));
}

// The most files the knowledge index lists, and the longest line it gives one, about 750 tokens in all.
export const KNOWLEDGE_INDEX_CAP = 30;
const KNOWLEDGE_LINE = 150;

// One file of the knowledge folder: its path in the folder, what it holds (its description, else its
// first line) and when it last changed, in milliseconds.
export interface KnowledgeEntry {
  path: string;
  about: string;
  changed: number;
}

// The notes of each card repository the index lists even past its cap, newest first, with the
// repository's own file. Limit: one number for every card; tune it if a card ever needs more.
export const CARD_NOTES = 5;

// The card a knowledge index is for: the repositories the card works in, and every repository of the
// project, which says which folder of the knowledge folder is whose.
export interface KnowledgeScope {
  card: readonly string[];
  repos: readonly string[];
}

/**
 * The knowledge files the index lists, how many it leaves out, and how many it leaves out because
 * they are about other repositories than the card's.
 *
 * With no scope, for a run that belongs to no card, the whole folder: the run recipe and the
 * repository files first, because every card needs them, then the newest. With a scope: the run
 * recipe, then each of the card's repositories with its `repository.md` and its notes, newest first,
 * then `shared/`, then the other notes at the top. The files of the other repositories are only
 * counted. The card's own part, each repository's file and `CARD_NOTES` newest notes, always fits,
 * also past the cap, so a project with many repositories never pushes a card's notes out. A card on
 * every repository gets the whole folder, capped.
 */
export function pickKnowledge(files: readonly KnowledgeEntry[], cap = KNOWLEDGE_INDEX_CAP, scope?: KnowledgeScope): { kept: KnowledgeEntry[]; left: number; other: number } {
  const newest = (a: KnowledgeEntry, b: KnowledgeEntry) => b.changed - a.changed;
  const isRepoFile = (one: KnowledgeEntry) => one.path.split('/').at(-1) === REPO_FILE;
  // A card on every repository has nothing to leave out, so it reads like a run of no card.
  if (scope === undefined || scope.repos.every((repo) => scope.card.includes(repo))) {
    const rank = (one: KnowledgeEntry) => (one.path === RUN_RECIPE_FILE ? 0 : isRepoFile(one) ? 1 : 2);
    const sorted = [...files].sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? (a.path < b.path ? -1 : 1) : newest(a, b)));
    return { kept: sorted.slice(0, cap), left: Math.max(0, sorted.length - cap), other: 0 };
  }
  // Whose each file is: a listed repository by its folder, the project folder's repository at the
  // top, `shared/`, or OTHER for any other note, which comes after the card's own.
  const OTHER = '';
  const ownerOf = (path: string): string => {
    const cut = path.indexOf('/');
    if (cut === -1) return scope.repos.includes('.') ? '.' : OTHER;
    const first = path.slice(0, cut);
    return first === SHARED_FOLDER || (first !== '.' && scope.repos.includes(first)) ? first : OTHER;
  };
  const notes = files.filter((one) => one.path !== RUN_RECIPE_FILE);
  const of = (owner: string) => notes.filter((one) => ownerOf(one.path) === owner).sort((a, b) => Number(isRepoFile(b)) - Number(isRepoFile(a)) || newest(a, b));
  // Each card repository keeps its file and its newest notes past the cap. The rest of its notes come
  // after, with shared/ and the other notes, while the cap has room.
  const own = [...files.filter((one) => one.path === RUN_RECIPE_FILE), ...scope.card.flatMap((repo) => of(repo).slice(0, CARD_NOTES + 1))];
  const ordered = [...own, ...scope.card.flatMap((repo) => of(repo).slice(CARD_NOTES + 1)), ...of(SHARED_FOLDER), ...of(OTHER)];
  const limit = Math.max(cap, own.length);
  return { kept: ordered.slice(0, limit), left: Math.max(0, ordered.length - limit), other: files.length - ordered.length };
}

export interface PromptInput {
  phase: string;
  key: string;
  title: string;
  // The ticket text as the person wrote it.
  ticket: string;
  // Anything they added for this run. Empty is the normal case.
  extra: string;
  readOnly: boolean;
  // The card folder, relative to the folder the run starts in, such as `../../.tasks/APP-1`. The
  // skills name no path of their own and say "the card folder", so this is the one place it is set.
  // A run that starts in the card folder itself gets `.`.
  folder: string;
  // Every path outside the folder the run starts in is a full path, for a run in QA's throwaway copy.
  // From the copy in the data folder the card folder is three or more folders up, and Codex wrote
  // its report one or two folders too high in three QA runs, though its shell read the same path right.
  fullPaths?: boolean;
  // The project's checkout, relative to the folder the run starts in, for a run that does not
  // start there. Only a read-only phase on Codex does not: it starts in the card folder, because
  // that is what makes the project unwritable for it. Left out for every other run, which starts
  // in the checkout and needs no path to reach it.
  checkout?: string;
  // The knowledge folder, relative to the folder the run starts in, for a phase that writes
  // knowledge. The wrap-up skill says the knowledge folder is named in the prompt, and this is
  // where it is named.
  knowledgeFolder?: string;
  // What a person wrote when they returned this card's last knowledge change. A return nobody
  // reads is the same as a silent delete, so the next run of the card reads it here.
  knowledgeNote?: string;
  // The one knowledge file a maintenance run rewrites, relative to the knowledge folder. Set for
  // Optimize and left out everywhere else, and it is also what tells this run it has no card.
  knowledgeFile?: string;
  // The one repository a Learn your repositories run learns: its folder name and where it is read,
  // relative to the folder the run starts in. Set for that phase alone, and it also says the run has
  // no card.
  learnRepo?: { name: string; path: string };
  // What an earlier run of this phase wrote into its progress file, for a run that starts fresh
  // where one stopped. Left out when there is no such file.
  progress?: string;
  // The project's repositories, for refine and plan on a project with several. Each one is named by
  // its path in the project, with where to read it and its knowledge file, both relative to the
  // folder the run starts in. Knowledge is null when the file is not there. Left out on a project
  // with one repository, so its prompt does not change.
  repositories?: readonly { name: string; path: string; knowledge: string | null }[];
  // The repositories a card on several changes, each with its checkout relative to the folder the run
  // starts in, for a run that may use the shell. Left out, or one entry, and the prompt does not change.
  folderRepos?: readonly { name: string; path: string }[];
  // The epic this card is a task of, with the epic's documents that exist, each relative to the folder
  // the run starts in. Left out, or no file, for a card that is no task, so its prompt does not change.
  epic?: { key: string; title: string; files: readonly string[] };
  // True for a card on the Epics board. Its Plan also writes the plan for other people
  // (`SHARE_PLAN_FILE`), which the read-only line then allows. Left out, and the prompt does not change.
  epicCard?: boolean;
  // `FROM_EPIC_FILE` in the card folder, relative to the folder the run starts in, when it is there.
  // Left out, and the prompt does not change.
  epicNotes?: string;
  // The project's own instructions for this phase, from `.nolzu/phases/<phase>.md` in the project
  // folder, read by `readPhaseInstructions`. Left out when there is no such file, so the prompt does
  // not change.
  projectInstructions?: { text: string; cut: boolean };
  // The files of the card folder this phase reads before it starts (`readFirstPaths`), each relative to
  // the folder the run starts in. Left out, or empty, and the prompt does not change.
  readFirst?: readonly string[];
  // Plan's read of the project's own instructions for the later phases, each by phase and by its path
  // relative to the folder the run starts in, the ones that exist. A rule in `implement.md` otherwise
  // reaches no plan step and no QA check.
  laterInstructions?: readonly { phase: string; path: string }[];
  // What the person said on this card, for a fresh run of any phase (`personsWords` in the app reads
  // it). Left out, or every list empty, and the prompt does not change.
  personsWords?: PersonsWords;
  // The card's runs before this one, for the wrap-up, which looks for what cost time (`cardHistory`
  // in the app reads it): how often each phase ran, in the order the phases first ran, and each QA
  // verdict that was not PASS, oldest first. Left out, or both lists empty, and the prompt does not change.
  history?: { runs: readonly { phase: string; count: number }[]; verdicts: readonly { verdict: string; reason: string | null }[] };
  // The project's knowledge folder, relative to the folder the run starts in, with the files
  // `pickKnowledge` kept and how many it left out. Given to a phase that reads code and writes no
  // knowledge. Left out, or no file, and the prompt does not change.
  // `other` counts the files about repositories the card does not work in, left out of the list.
  knowledgeIndex?: { folder: string; files: readonly Pick<KnowledgeEntry, 'path' | 'about'>[]; left: number; other?: number };
  // The commit of the code this run reads, short, with its date, which a phase copies as `Read at:`.
  // Refine and Plan have no shell to ask git. Left out when there is no one repository to name.
  commit?: { sha: string; date: string };
  // The browser servers a QA run has, by their names in the browser config. Codex lists no MCP tool
  // until one is called, and a QA run there decided it had no browser. Left out, or empty, and the
  // prompt does not change.
  browser?: readonly string[];
  // The MCP servers of any other phase, from the project's list, with their descriptions. Left out, or
  // empty, and the prompt does not change.
  servers?: readonly { name: string; description: string }[];
}

/** The line that names QA's browser servers, or nothing with none. */
export const browserLine = (browser: readonly string[]): string =>
  browser.length === 0
    ? ''
    : `A browser is configured for this run, as the MCP server${browser.length === 1 ? '' : 's'} ${browser.map((name) => `\`${name}\``).join(' and ')}. Its tools may not be\nlisted until you call one, so do not decide there is no browser. Use it for every check that\nneeds a page, and for the screenshots.`;

/** The line that names a run's other MCP servers with their descriptions, or nothing with none. */
export const serversLine = (servers: readonly { name: string; description: string }[]): string =>
  servers.length === 0
    ? ''
    : `This run has the MCP server${servers.length === 1 ? '' : 's'} ${servers.map((server) => `\`${server.name}\`${server.description === '' ? '' : ` (${server.description})`}`).join(' and ')}. Its tools may not be\nlisted until you call one, so do not decide a server is missing.`;

/**
 * The prompt with one of the lines above swapped for another, as a run does once it knows which servers
 * it got. A line that becomes nothing takes its blank line with it, as `buildPrompt` leaves none.
 */
export function swapPromptLine(prompt: string, was: string, now: string): string {
  if (was === '' || was === now) return prompt;
  // A function, so a `$` in a server's description is never read as a replacement pattern.
  return now === '' ? prompt.replace(`\n\n${was}`, () => '') : prompt.replace(was, () => now);
}

export interface PersonsWords {
  // Each question a run of this card asked, oldest first, with the answer, or null when none is stored.
  questions: readonly { phase: string; question: string; answer: string | null }[];
  // The line typed on a move, by stage label: Accept anyway on a forward move, a Send back note on a
  // move back. Oldest first.
  moves: readonly { from: string; to: string; back: boolean; reason: string }[];
  // The person's own Discussion messages, oldest first, without the answers above and without the
  // agent's replies.
  messages: readonly { thread: string; text: string }[];
  // The answers at the first QA for the card's repositories, for a run that may use the shell.
  firstQa?: readonly QaApp[];
  // The commands the run may use. Empty for a run with no shell.
  allowedCommands: readonly string[];
}

// One item of the person's words, on one line and at most this long, and the room each list gets in
// all. A card that lives long gathers many, so each list keeps its newest that fit, and an old
// thread cannot crowd out the last word.
const WORDS_ITEM = 500;
const WORDS_QUESTIONS = 5000;
const WORDS_MOVES = 2500;
const WORDS_MESSAGES = 2500;
const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > WORDS_ITEM ? `${line.slice(0, WORDS_ITEM)} (cut)` : line;
};

// Inside the wall the home folder refuses every write, and an agent that meets EPERM there tends to
// blame files owned by root and move its cache into the card folder.
const HOME_READ_ONLY =
  'Your home folder is read-only by design, so a write refused under it comes from the wall, not\nfrom files owned by root. The package caches already point outside it and outside the card\nfolder. Never put a package cache or an install log in the card folder.';

function firstQaLine(app: QaApp): string {
  const how =
    app.mode === 'dev'
      ? `Nolzu starts it with \`${app.command}\`${app.repo === '.' || app.repo === '' ? '' : ` in \`${app.repo}\``}.`
      : app.mode === 'running'
        ? `it is already running at ${app.address}, and Nolzu leaves it alone.`
        : app.mode === 'own'
          ? `Nolzu starts it with their own command \`${app.start}\` before the run and stops it after.`
          : 'QA checks the code only, with no app running.';
  return `At the first QA the person chose how QA gets the app: ${how}`;
}

// The newest lines that fit in the room, oldest first, under their heading, and a line that counts
// the ones left out and says where they all are.
function newest(lines: readonly string[], room: number, heading: string, what: [string, string], where: string): string {
  const kept: string[] = [];
  for (const line of [...lines].reverse()) {
    if (line.length > room) break;
    room -= line.length;
    kept.unshift(line);
  }
  const left = lines.length - kept.length;
  return [
    kept.length === 0 ? '' : `${heading}\n\n${kept.join('\n')}`,
    left === 0 ? '' : `${left} older ${left === 1 ? `${what[0]} is` : `${what[1]} are`} left out. ${where}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

// The person's words: answers, the lines typed on a move and their Discussion messages. Each was
// typed to one run, and a fresh run of a later phase has no session to find them in.
function personsBlocks(words: PersonsWords | undefined): string[] {
  if (words === undefined) return [];
  const { questions, moves, messages, firstQa, allowedCommands } = words;
  const said = questions.length + moves.length + messages.length > 0;
  if (!said && firstQa === undefined && allowedCommands.length === 0) return [];
  return [
    '## What the person said',
    said ? 'A person wrote these on this card. They are decisions: follow them, and do not ask again\nwhat an answer here already says.' : '',
    newest(
      questions.map((one) => `- ${phaseLabel(one.phase)} asked: ${oneLine(one.question)}\n  ${one.answer === null ? 'No answer is stored.' : `Answer: ${oneLine(one.answer)}`}`),
      WORDS_QUESTIONS,
      'The questions earlier runs asked, with the answers:',
      ['question', 'questions'],
      'The Discussion tab has them all.',
    ),
    newest(
      moves.map((one) => `- ${one.back ? `Sent back from ${one.from} to ${one.to}` : `Moved on anyway from ${one.from} to ${one.to}`}: ${oneLine(one.reason)}`),
      WORDS_MOVES,
      'What the person wrote when the card moved:',
      ['move', 'moves'],
      'The trail on the Overview has them all.',
    ),
    newest(
      messages.map((message) => `- On ${phaseLabel(message.thread)}: ${oneLine(message.text)}`),
      WORDS_MESSAGES,
      "The person's own messages in the card's Discussion, newest last:",
      ['message', 'messages'],
      'The Discussion tab has them all.',
    ),
    firstQa === undefined ? '' : firstQa.map(firstQaLine).join('\n'),
    allowedCommands.length === 0
      ? ''
      : `The commands this run may use. Any other command is refused, and nobody is there to\nallow it:\n\n${allowedCommands.map((command) => `- \`${command}\``).join('\n')}\n\n${HOME_READ_ONLY}`,
  ];
}

// The card's history. The QA report of a failed round is written over by the next QA, so its verdict
// is only here.
function historyBlocks(history: PromptInput['history']): string[] {
  if (history === undefined || history.runs.length + history.verdicts.length === 0) return [];
  return [
    '## What this card went through',
    history.runs.length === 0 ? '' : `How often each phase ran: ${history.runs.map((one) => `${phaseLabel(one.phase)} ${one.count}`).join(', ')}.`,
    history.verdicts.length === 0
      ? ''
      : `The QA runs that did not pass, oldest first:\n\n${history.verdicts.map((one) => `- ${one.verdict}: ${one.reason === null ? 'no reason is stored.' : oneLine(one.reason)}`).join('\n')}`,
  ];
}

// The read-first block. The project's instructions are read only: the run that follows them is the
// later phase, and Plan only turns what it can check into steps and checks.
function readFirstBlocks(folder: string, files: readonly string[], later: readonly { phase: string; path: string }[]): string[] {
  if (files.length === 0 && later.length === 0) return [];
  return [
    '## Read first',
    files.length === 0 ? '' : `Earlier phases of this card wrote these files. Read them before you start.\n\n${files.map((path) => `- \`${path}\``).join('\n')}`,
    later.length === 0
      ? ''
      : `The project has its own instructions for the phases after this one. Read them, and change\nnothing in them:\n\n${later.map((one) => `- \`${one.path}\`, for ${phaseLabel(one.phase)}`).join('\n')}\n\nTurn each rule in them that you can check into a plan step or a line in\n\`${folder}/${QA_CHECKS_FILE}\`, and name the file the rule came from.`,
  ];
}

// The knowledge index. It names the project folder's knowledge and not the copy in the checkout, which
// can be behind: knowledge commits land on the branch open in the project folder.
function knowledgeBlocks(index: PromptInput['knowledgeIndex']): string[] {
  if (index === undefined || index.files.length === 0) return [];
  const line = (text: string) => {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > KNOWLEDGE_LINE ? `${one.slice(0, KNOWLEDGE_LINE)} (cut)` : one;
  };
  return [
    '## Project knowledge',
    `The project's knowledge folder is \`${index.folder}/\`. Each line names one of its files and\nwhat it holds. Pick at most three files that match your work and read them before the code. The\nfolder is read only for this run.`,
    index.files.map((file) => `- \`${file.path}\`: ${line(file.about)}`).join('\n'),
    index.left === 0 ? '' : `${index.left} more ${index.left === 1 ? 'file is' : 'files are'} left out. The folder holds them all.`,
    (index.other ?? 0) === 0 ? '' : `${index.other} ${index.other === 1 ? 'file about another repository is' : 'files about other repositories are'} left out.`,
  ];
}

// The project's instructions under their own heading. The last line keeps them from moving the files
// the loop and the next phase read back, which a project's wording cannot know about. Ask writes no
// file, so its last line keeps the run reading instead.
function projectBlocks(phase: string, instructions: PromptInput['projectInstructions']): string[] {
  if (instructions === undefined) return [];
  return [
    `## Project instructions for ${phaseLabel(phase)}`,
    instructions.text,
    instructions.cut ? 'The file was longer than 16 KB, and the rest of it is left out.' : '',
    phase === ASK_PHASE
      ? 'These instructions may change how you read and answer, but not that this run changes nothing.'
      : // Code reads these back, so an instruction such as "write in Hungarian" must leave them as they are.
        'These instructions may change how you work, the language of your text, and what goes into your\ndocuments, with extra sections under their own `##` headings after the ones the skill gives. They\nmay not change what Nolzu reads back: the names and places of the files (summary.md and the others\nthe skill names), the headings and field names the skill gives, the ids, the review block, and the\nverdict line. Keep those exactly as the skill writes them, in English.',
  ];
}

// The progress file the implement skill keeps, one line per plan step it finished, each line
// starting with the step number.
export const PROGRESS_FILE = 'progress.md';

/**
 * The plan steps a progress file lists as done, in order and without repeats.
 *
 * The skill writes one line per finished step, and the line starts with the step number. A number
 * further into the line is not read as a step: a line that says "3 tests pass" would otherwise
 * count as step 3 and the next run would skip it.
 */
export function stepsDone(progress: string): number[] {
  const found = progress
    .split('\n')
    .flatMap((line) => {
      const match = /^(?:[-*]\s*)?(?:step\s*)?(\d{1,3})\b/i.exec(line.trim());
      return match === null ? [] : [Number(match[1])];
    })
    .filter((step) => step > 0);
  return [...new Set(found)].sort((one, other) => one - other);
}

// The first step the progress file does not list as done. A run goes on from there, and the checks
// come first, because the stopped run may have left a step half finished.
export function nextStep(done: readonly number[]): number {
  for (let step = 1; ; step += 1) if (!done.includes(step)) return step;
}

// The phase instruction, the card and the contract. The sentinel lines are built from the
// protocol constants and never typed out here, so the contract cannot drift away from the
// parser that reads the stream. The same two lines are written once more in the shared skill
// text, which is what each pipeline skill copies.
export function buildPrompt(input: PromptInput): string {
  const { phase, key, title, ticket, extra, readOnly, folder, fullPaths = false, checkout, knowledgeFolder, knowledgeNote, knowledgeFile, learnRepo, progress, repositories, folderRepos = [], epic, epicCard = false, epicNotes, projectInstructions, readFirst = [], laterInstructions = [], personsWords, history, knowledgeIndex, commit, browser = [], servers = [] } = input;
  // An absolute path would name a folder on the person's machine, which then travels into the log
  // and into whatever the agent writes from it.
  // Empty is refused with the absolute paths, because the phase is joined to it and `/refine/` is
  // what a run that starts in the card folder would read. `.` is the value for that run. A run in
  // QA's copy is the one that gets full paths, and only when the loop says so.
  const machinePath = (path: string) => !fullPaths && isAbsolute(path);
  if (folder === '' || machinePath(folder)) {
    throw new Error(`The card folder ${JSON.stringify(folder)} has to be a relative path from the working folder, such as \`.\`, so no machine path reaches the prompt.`);
  }
  const at = `\`${folder}/${phase}/\``;
  if (checkout !== undefined && machinePath(checkout)) {
    throw new Error(`The checkout ${JSON.stringify(checkout)} has to be relative to the working folder, so no machine path reaches the prompt.`);
  }
  if (knowledgeFolder !== undefined && machinePath(knowledgeFolder)) {
    throw new Error(`The knowledge folder ${JSON.stringify(knowledgeFolder)} has to be relative to the working folder, so no machine path reaches the prompt.`);
  }
  const epicFiles = epic?.files ?? [];
  for (const path of epicFiles) {
    if (machinePath(path)) throw new Error(`The epic document ${JSON.stringify(path)} has to be relative to the working folder, so no machine path reaches the prompt.`);
  }
  if (knowledgeIndex !== undefined && machinePath(knowledgeIndex.folder)) {
    throw new Error(`The knowledge folder ${JSON.stringify(knowledgeIndex.folder)} has to be relative to the working folder, so no machine path reaches the prompt.`);
  }
  for (const path of [...readFirst, ...laterInstructions.map((one) => one.path), ...(epicNotes === undefined ? [] : [epicNotes])]) {
    if (machinePath(path)) throw new Error(`The file to read first ${JSON.stringify(path)} has to be relative to the working folder, so no machine path reaches the prompt.`);
  }
  if (learnRepo !== undefined && machinePath(learnRepo.path)) {
    throw new Error(`The repository path ${JSON.stringify(learnRepo.path)} has to be relative to the working folder, so no machine path reaches the prompt.`);
  }
  for (const repo of [...(repositories ?? []), ...folderRepos.map((one) => ({ ...one, knowledge: null }))]) {
    for (const path of [repo.path, repo.knowledge ?? '']) {
      if (machinePath(path)) {
        throw new Error(`The repository path ${JSON.stringify(path)} has to be relative to the working folder, so no machine path reaches the prompt.`);
      }
    }
  }

  // A maintenance run is the one that names a file to rewrite inside a knowledge folder. It belongs
  // to no card, so the two headings that would call it one say what it is instead.
  const maintenance = knowledgeFile !== undefined && knowledgeFolder !== undefined;
  // Learn this project belongs to no card either. It names no file, because it writes the few it picks.
  // Learn your repositories belongs to no card, and writes the two files of the one repository it names.
  const learning = learnRepo !== undefined && knowledgeFolder !== undefined;
  const noCard = maintenance || learning || (phase === 'orient' && knowledgeFolder !== undefined);

  // The steps an earlier run of this phase finished. A fresh run needs them in the prompt: it has
  // no session and no memory of that run, and its changes are in the checkout with nothing
  // committed. A file with no step in it is left to the skill, which says to read it anyway.
  const done = progress === undefined ? [] : stepsDone(progress);

  // The card folder is `.tasks/<key>` in the project folder. A run in a checkout sees that folder in
  // every card and knowledge path, and a refine run read the code there instead of its own.
  const projectFolder = join(folder, '..', '..');

  // The example names a child folder, because `npm --prefix . test` would show nothing.
  const example = (folderRepos.find((repo) => repo.path !== '.') ?? folderRepos[0])?.path;

  const blocks = [
    // The phase method, on the first line, on every engine. The run writes it into the card folder
    // from the installed skill. Claude Code once got `/nolzu-<phase>` here and expanded the copy
    // committed in the project, which kept the old method after every Nolzu upgrade.
    `Read \`${folder}/${phase}/${INSTRUCTIONS_FILE}\` first. It holds the method for this phase, and this run follows it.`,
    `Run the ${phase} phase for ${key}.`,
    `The card folder is \`${folder}/\`. Every file of this card lives there, and the\nskills call it the card folder. Write what you produce to ${at},\nand the short summary to \`${folder}/${phase}/summary.md\`.`,
    commit === undefined ? '' : `The code you read is at commit ${commit.sha} (${commit.date}).`,
    // A run that starts in the project folder reads the code there, and one in the card folder has
    // the checkout line below. A list of repositories says where each is read, and one the card has
    // no checkout of is read in the project folder.
    checkout !== undefined || projectFolder === '.' || (repositories?.length ?? 0) > 0
      ? ''
      : `The code of this card is in the folder you start in, \`./\`, its own checkout. Read the code\nthere, and name a file by its path from there. The card folder lies in the project folder\n\`${projectFolder}/\`, outside the checkout, like the other folders this prompt names. The code in\nthe project folder is not this card's code.`,
    // The model turns a path into the one its file tool takes, and a long `../` path was miscounted.
    fullPaths ? 'Every path this prompt names outside `./` is a full path. Use it as it stands, and do not\nwork it out again from `./`.' : '',
    noCard ? '## This run' : '## The card',
    `${key}: ${title}`,
    ticket.trim(),
    extra.trim() === '' ? '' : '## Extra context',
    extra.trim(),
    ...personsBlocks(personsWords),
    ...historyBlocks(history),
    ...projectBlocks(phase, projectInstructions),
    // Without it a task's Refine starts from one line and does the epic's work again.
    epicFiles.length === 0 ? '' : '## The epic',
    epicFiles.length === 0
      ? ''
      : `This card is a task of ${epic?.key}: ${epic?.title}. Read the epic's documents first: they say what the\nwhole epic is for and how it is split. They are read only. Never change a file in that folder.\n\n${epicFiles.map((path) => `- \`${path}\``).join('\n')}`,
    epicNotes === undefined ? '' : `${epicFiles.length === 0 ? '## The epic\n\n' : ''}\`${epicNotes}\` holds the epic's notes for this task: the files, decisions and checks its plan step named. Read it\nbefore you start.`,
    ...readFirstBlocks(folder, readFirst, laterInstructions),
    ...knowledgeBlocks(knowledgeIndex),
    '## How this run works',
    'This run is not interactive. Nobody is reading along, so a question asked in the middle of\nyour output is never answered and the run is wasted.',
    // Plan also writes the list QA will check, in QA's folder because QA reads it, and every phase adds
    // to the discoveries file. Without them this line would forbid files the skills ask for.
    readOnly && knowledgeFolder === undefined
      ? `This phase changes no code. Write only inside ${at}${phase === 'plan' ? `, and the list of what QA will check to \`${folder}/${QA_CHECKS_FILE}\`` : ''}.\nAdd what you met on the way to \`${folder}/${DISCOVERIES_FILE}\`.`
      : '',
    phase === 'plan' && epicCard ? `This card is an epic. Write the plan for other people to \`${folder}/${SHARE_PLAN_FILE}\` too, as the method says.` : '',
    phase === 'qa' ? browserLine(browser) : '',
    serversLine(servers),
    // A run that starts in the card folder has the project beside it and not under it. Without this
    // the agent reads the folder it starts in as the project, and a plan would name its files from
    // the wrong place for the implement run that reads that plan back.
    checkout === undefined
      ? ''
      : `You start in the card folder, and the project is at \`${checkout}/\`. Read the project there.\nYou cannot change it, and nothing you write belongs in it. Name a file of the project by its\npath inside the project, not by the path from here.`,
    // A project of several repositories leaves the card to pick the ones it changes. The skill says
    // how to name them, and the loop reads that line back.
    repositories === undefined || repositories.length === 0
      ? ''
      : `This project has several repositories. Read each one where this list says, and its\nknowledge file first when it has one.\n\n${repositories
          .map((repo) => `- \`${repo.name}\` at \`${repo.path}/\`${repo.knowledge === null ? '' : `, knowledge in \`${repo.knowledge}\``}`)
          .join('\n')}`,
    // The run starts at the checkout root, and an allowed command matches the start of the line, so
    // `cd api && npm test` asks for a permission nobody is there to give.
    folderRepos.length < 2
      ? ''
      : `This card changes several repositories. Each one is a folder here:\n\n${folderRepos
          .map((repo) => `- \`${repo.name}\` in \`${repo.path}/\``)
          .join('\n')}\n\nRun a command in one of them with the tool's own folder option, for example\n\`npm --prefix ${example} test\`, \`pnpm --dir ${example} test\` or \`git -C ${example} status\`.\nNever \`cd ${example} && ...\`. The allowed commands match the start of the command line, so a\ncommand that starts with \`cd\` is not allowed.`,
    knowledgeFolder === undefined
      ? ''
      : `This phase changes no code. The knowledge folder is \`${knowledgeFolder}/\`, and it is the\nonly folder outside the card folder you may write in. Make no commit. The runner commits\nwhat you leave there.`,
    maintenance
      ? `Rewrite \`${knowledgeFolder}/${knowledgeFile}\` and no other file. Every other file in\nthat folder is there to be read.`
      : '',
    learning
      ? `Learn the repository \`${learnRepo.name}\` at \`${learnRepo.path}/\`. Write \`${knowledgeFolder}/${repoKnowledgePath(learnRepo.name)}\`\nand the \`${recipeHeading(learnRepo.name)}\` section of \`${knowledgeFolder}/${RUN_RECIPE_FILE}\`, and no other\nknowledge file. Leave every other section of the run recipe as it is.`
      : '',
    knowledgeNote === undefined || knowledgeNote.trim() === ''
      ? ''
      : noCard
        ? '## The last knowledge change a maintenance run made was returned'
        : '## The last knowledge change of this card was returned',
    knowledgeNote === undefined || knowledgeNote.trim() === ''
      ? ''
      : `A person read what an earlier run wrote to the knowledge folder and sent it back with this\nnote:\n\n${knowledgeNote.trim()}\n\nNothing of that change is in the folder. Write knowledge again, the way the note asks.`,
    done.length === 0 ? '' : '## An earlier run of this phase stopped',
    done.length === 0
      ? ''
      : `\`${folder}/${phase}/${PROGRESS_FILE}\` lists ${done.length === 1 ? 'step' : 'steps'} ${done.join(', ')} as done.\nThat run left its changes in the checkout, and nothing was committed. Run the\nproject's checks first and fix what they show, then go on from step ${nextStep(done)}. Do not redo a\nstep the file lists as done.`,
    'When a question blocks the work and a guess would waste the run, end with it on its own line:',
    `    ${NEEDS_INPUT_PREFIX}<your question on one line>`,
    'When the work is done, end with this line on its own line, with nothing after it:',
    `    ${SENTINEL_COMPLETE}`,
  ];

  return `${blocks.filter((block) => block !== '').join('\n\n')}\n`;
}

/**
 * The message a resumed run goes on with: what the person or Nolzu said, then the finish rules a
 * message alone drops. Every run starts with its phase's summary.md removed, so a fix round after QA,
 * a pull request comment or a discussion message that resumed the session with a short message wrote
 * no summary, and the output check then found it missing. Implement also brings the share files up
 * to date on every run, as its skill says. An Ask writes no summary, so its message stays as it is.
 */
export function resumeMessage(phase: string, message: string): string {
  if (phase === ASK_PHASE) return message;
  const share = phase === 'implement' ? ` Bring ${SHARE_FILES.map((file) => `\`${file}\``).join(' and ')} in the card folder up to date with\nthis change too.` : '';
  return `${message.trim()}\n\n## Before you end\n\nNolzu clears \`${phase}/summary.md\` in the card folder when a run starts. Write the short\nsummary of this run there.${share}\n`;
}

/**
 * The prompt of an Ask run: a read-only session that answers a person's question about a card.
 *
 * It has no skill, so the method is here, short. The question goes after it, under the last
 * heading, and a later message in the same discussion resumes the session with the message alone.
 * What holds the run to reading is its tool list and the guard, not these words.
 */
export function askPrompt(input: Pick<PromptInput, 'key' | 'title' | 'ticket' | 'extra' | 'folder' | 'projectInstructions'>): string {
  const { key, title, ticket, extra, folder, projectInstructions } = input;
  // The same rule as `buildPrompt`, so no machine path reaches the prompt.
  if (folder === '' || isAbsolute(folder)) {
    throw new Error(`The card folder ${JSON.stringify(folder)} has to be a relative path from the working folder, such as \`.\`, so no machine path reaches the prompt.`);
  }
  const blocks = [
    `Answer a question about ${key}. A person asks it on the card's Discussion tab.`,
    '## The card',
    `${key}: ${title}`,
    ticket.trim(),
    extra.trim() === '' ? '' : '## Extra context',
    extra.trim(),
    ...projectBlocks(ASK_PHASE, projectInstructions),
    '## How this run works',
    `This run reads and answers. It changes nothing: you can read and search, and you have no tool that\nwrites a file or runs a command. Read the code from here. The card folder is \`${folder}/\`, and it\nholds what the card's phases wrote, such as the plan, their summaries and the QA report.`,
    'Answer in plain words in your last message. Name each file you read by its path. Say what the code\nshows, and say so when it does not show the answer. Nobody reads along while you work, so do not\nask a question in the middle. A person reads the answer and can ask a follow-up in this session.',
    '## The question',
  ];
  return `${blocks.filter((block) => block !== '').join('\n\n')}\n`;
}
