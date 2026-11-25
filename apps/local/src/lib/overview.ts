import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { boardFor, type ModelsByVendor, phaseStrip, projectRepos, resolveKnowledgeDir } from '@nolzu/core';
import { type BoardKind, decisionLines, type DeliveryFlow, isResearchKind, type KnowledgeStatus, phaseLabel, RESEARCH_REPORTS, refinedCriteria, type QuestionOption, type ReadOnlyBreak, type Segment, type Spend, spendOf, storedQuestionOptions } from '@nolzu/protocol';
import { allKnowledgeChanges, cardRepos, cardRuns, commitWarningOf, getSetting, NOT_A_PASS, peekLocalKey, readOnlyBreakOf, relatedCards, setExtraContext, shownRunState, unlinkCards } from '@nolzu/core/node';
import { checkoutPath, checkoutRoot, DISCOVERIES_FILE, git, gitEnv, isPlainName, pushedReason, readCardFile, SHARE_PLAN_FILE } from '@nolzu/runner';
import { engineName } from '@nolzu/protocol';
import { type EpicSeed, parsePlan } from '@nolzu/ui/plan';
import { settingsFor } from './card-models.ts';
import { cardCheckouts, templateBranch } from './checkout.ts';
import { isClosed } from './checkouts.ts';
import { cardFolder, filesFor } from './files.ts';
import { type CardGate, gateFor } from './gate.ts';
import { commitPatch } from './knowledge-page.ts';
import { reviewFor } from './review.ts';

export interface Overview {
  // "What changed, in plain words" of the newest run that has one. Only a run that ended ready gets one.
  summary: string | null;
  // Which phase wrote it, as the line under the lede says it, and when the run ended, which the page
  // draws as "3 hours ago". On a closed card the wrap-up's summary is the one of the whole card.
  summaryFrom: string | null;
  summaryAt: string | null;
  // The phase that wrote it, so a card ready after Plan links the plan and not the diff.
  summaryPhase: string | null;
  // The newest summary a run other than QA wrote, which a QA FAIL shows last as what the build changed.
  // A QA run writes a summary too, and on a FAIL that one only says the verdict again. `at` is when
  // that run ended, for the time in the block's meta.
  built: { summary: string; phase: string; at: string | null } | null;
  // The ticket's meta: where it came from, and when the newest Refine run ended ("local, refined 20 minutes ago").
  ticketSource: string;
  refinedAt: string | null;
  // The documents an epic's phases wrote, each opening the Files tab, and the excerpt of its
  // `architecture.md` (`architectureExcerpt`). Null on every other board.
  docs: EpicDoc[] | null;
  solution: string | null;
  // The answer of a question or the report of an investigation, as its run wrote it, with the
  // "## Sources" list split off into chips. Left out on every other board and before the file is there.
  research?: { title: string; file: string; body: string; sources: { at: string; note: string | null }[] };
  // The text of `plan/plan.md` on a card past Plan, closed too, which the Overview draws as steps.
  plan: string | null;
  // The card sits in a stage that runs Plan or Implement, which work from the plan, so the Overview
  // opens it. It starts folded everywhere else.
  planOpen: boolean;
  // On an epic, what each task's ticket copies by the ids its step names: the brief's criteria and the
  // decisions of the architecture and the plan. Left out on every other board.
  seed?: EpicSeed;
  // On an epic, the plan for colleagues its Plan wrote (`share/PLAN.md`), whose tasks are the shareable
  // descriptions of the task table, and the name of the project's ticket system a task row links to.
  // Each is left out when there is none.
  sharePlan?: string;
  linkSystem?: string;
  ticket: string | null;
  extra: string | null;
  related: { key: string; title: string }[];
  // The tasks of an epic, on an Epics card only, and null on every other board. A task also shows
  // as a Related chip, which is where its link is removed.
  tasks: { key: string; title: string; done: boolean; step?: string }[] | null;
  // The key the next local card gets, which the epic's first task not added yet proposes. On an Epics
  // card only.
  nextKey?: string;
  // The question of a blocked card, and the session an answer goes on in. Null unless the card is blocked.
  // The run id tells two questions apart, so a new question never inherits the composer of the last.
  // The options are the answers the run offered, left out when it offered none.
  // The phase that asked, and the engine profile, model and effort it ran on: the answer resumes that
  // session on that profile.
  blocked: {
    runId: number;
    question: string;
    sessionId: string | null;
    options?: QuestionOption[];
    phase: string;
    engine: string;
    model: string | null;
    effort: string | null;
  } | null;
  strip: Segment[];
  // Every run of the card, rolled up. Not the segments added together: a run whose phase is no stage
  // of this board, such as the summary pass, is in no segment, and the total would drop its cost and
  // then call itself complete.
  spend: Spend;
  // Every move of the card, oldest first, with who made it and when. The trail reads the mover of each
  // phase off it, and a closed card's record draws it whole.
  moves: CardMoveLine[];
  // The newest run that changed files while it should have read only, with its phase and engine in
  // words. Null when no run did. The wall should keep this null; the git compare after a read-only
  // run writes it.
  readOnlyBreak: (ReadOnlyBreak & { phase: string; engine: string; walled: boolean }) | null;
  // What the newest Implement run committed or pushed, in the sentences its log has. Null when
  // it moved nothing, and once the next Implement run is made.
  commitWarning: string | null;
  // The review block of the phase that ran last, its questions marked `blocks: yes` and what the
  // output check found on that run (`gateFor`). Null on a closed card, while a run goes, and on a
  // card that never ran.
  gate: CardGate | null;
}

// One document chip of an epic: its name, the file the Files tab opens on, and the screen count of the
// design.
export interface EpicDoc {
  label: string;
  path: string;
  screens: number | null;
}

// The source word of the ticket meta, beside the heading.
const SOURCE_WORDS: Readonly<Record<string, string>> = { local: 'local', github: 'GitHub', jira: 'Jira', linear: 'Linear' };
const DOC_NAMES = ['solution.md', 'architecture.md', 'plan.md'];

/**
 * The document chips of an epic and the excerpt of its architecture, read off the card folder as
 * the Files tab lists it. No skill writes a `solution.md`, so the excerpt comes from `architecture.md`.
 */
function epicDocs(db: DatabaseSync, key: string, env: Record<string, string | undefined>): { docs: EpicDoc[]; solution: string | null } {
  const files = filesFor(db, key, env).flatMap((group) => group.files);
  const docs: EpicDoc[] = DOC_NAMES.flatMap((name) => {
    const file = files.find((one) => one.name === name);
    return file === undefined ? [] : [{ label: name, path: file.path, screens: null }];
  });
  // Mockups is the old name of Design. An epic drawn before the rename keeps its button.
  for (const [folder, label] of [['design', 'Design'], ['mockups', 'Mockups']] as const) {
    const screens = files.filter((file) => file.path.startsWith(`${folder}/`) && file.name.endsWith('.html'));
    if (screens.length > 0) docs.push({ label, path: files.find((file) => file.path === `${folder}/${folder}.md`)?.path ?? screens[0]!.path, screens: screens.length });
  }
  const at = docs.find((doc) => doc.label === 'architecture.md')?.path;
  const folder = at === undefined ? null : cardFolder(db, key, env);
  const read = folder === null || at === undefined ? null : readCardFile(folder, at);
  return { docs, solution: read?.ok ? architectureExcerpt(read.bytes.toString('utf8')) : null };
}

/**
 * The first bullet of the review block, where the phase says what it concluded. An architecture
 * written before the review block existed gives the first paragraph of `## The shape` instead.
 */
export function architectureExcerpt(text: string): string | null {
  const section = (heading: string) => {
    const at = text.split('\n').findIndex((line) => line.trim() === heading);
    if (at === -1) return null;
    const lines = text.split('\n').slice(at + 1);
    const end = lines.findIndex((line) => line.startsWith('#'));
    return (end === -1 ? lines : lines.slice(0, end)).join('\n');
  };
  const review = section('## Before you approve')?.split('\n').find((line) => line.startsWith('- '));
  if (review !== undefined) return review.slice(2).trim() || null;
  const shape = section('## The shape')?.split(/\n\s*\n/).map((part) => part.trim()).find((part) => part !== '');
  return shape ?? null;
}

export interface CardMoveLine {
  // The stage the card moved into, as its board names it.
  label: string;
  // "moved by you", and when, which the trail draws as "5 minutes ago" on the page's clock.
  said: string;
  at: string;
  // The phase the move started, or null when it started none.
  phase: string | null;
  // The line the person wrote for the move, such as why a QA FAIL went on anyway, and the phase of
  // the stage the move left, which the trail draws it under. Only on a move that has one.
  reason?: string;
  from?: string | null;
  // True on a move back with a reason: Send back from the web or the phone, and its note.
  back?: true;
}

// The card events store "you" for a move by hand and "auto" for one Nolzu made on its own.
const MOVER: Readonly<Record<string, string>> = { you: 'you', auto: 'Nolzu' };

/**
 * Whether the card is past Plan on its own board: in a later stage, the archive too, or in the plan
 * stage with the plan done. A card that never reached Plan, or whose board has none, has no plan to
 * show. A closed card that never planned has no file, so it shows none either.
 */
function pastPlan(stages: readonly { id: string; phase?: string }[], stage: string, state: string): boolean {
  const plan = stages.findIndex((one) => one.phase === 'plan');
  const at = stages.findIndex((one) => one.id === stage);
  if (plan === -1 || at < plan) return false;
  return at > plan || state === 'ready';
}

/**
 * The Delivery cards linked to an epic, oldest first.
 *
 * Ordered by rowid and not by key: a key sorts as text, so APP-10 would land before APP-2. Done is
 * the Delivery board's archive stage, read off the board the way the board card's count reads it.
 */
function epicTasks(db: DatabaseSync, key: string, flow: DeliveryFlow): { key: string; title: string; done: boolean; step?: string }[] {
  const closed = boardFor('delivery', flow).stages.find((stage) => stage.role === 'archive')?.id ?? 'closed';
  const rows = db
    .prepare(
      `SELECT c.key, c.title, c.stage, l.step FROM card_links l
       JOIN cards c ON c.key = CASE WHEN l.a = ? THEN l.b ELSE l.a END AND c.board = 'delivery'
       WHERE l.a = ? OR l.b = ? ORDER BY c.rowid`,
    )
    .all(key, key, key) as unknown as { key: string; title: string; stage: string; step: string | null }[];
  return rows.map((row) => ({ key: row.key, title: row.title, done: row.stage === closed, ...(row.step === null ? {} : { step: row.step }) }));
}

// Read the way the Files tab reads it, so a plan that links out of the card folder or runs past the
// cap is not sent with the page.
function planText(folder: string): string | null {
  const read = readCardFile(folder, 'plan/plan.md');
  return read.ok ? read.bytes.toString('utf8') : null;
}

// The "## Sources" list the research and investigate skills end their file with, split off the report so
// the card page draws it as chips. An item's first word is its `path:line`, backticks or not, and what follows
// is the skill's own note, which the chip keeps because it says why the line matters. A file with no
// such list has no sources.
export function reportSources(report: string): { body: string; sources: { at: string; note: string | null }[] } {
  const heading = /^##[ \t]+Sources[ \t]*$/m.exec(report);
  if (heading === null) return { body: report, sources: [] };
  const rest = report.slice(heading.index + heading[0].length);
  const after = rest.search(/^#{1,2}[ \t]/m);
  const list = after === -1 ? rest : rest.slice(0, after);
  const sources = list.split('\n').flatMap((line) => {
    const item = /^[ \t]*[-*][ \t]+`?([^`\s,]*[^`\s,:])`?[,:]?[ \t]*(.*)$/.exec(line);
    if (item === null) return [];
    const note = item[2]!.replace(/^[-\u2013\u2014][ \t]*/, '').trim();
    return [{ at: item[1]!, note: note === '' ? null : note }];
  });
  const before = report.slice(0, heading.index).trimEnd();
  return { body: after === -1 ? before : `${before}\n\n${rest.slice(after)}`, sources };
}

// The answer or the report of a Research card, read the way the Files tab reads it.
function researchReport(folder: string, board: BoardKind): Overview['research'] {
  if (!isResearchKind(board)) return undefined;
  const file = RESEARCH_REPORTS[board];
  const read = readCardFile(folder, file);
  return read.ok ? { title: board === 'questions' ? 'The answer' : 'The report', file, ...reportSources(read.bytes.toString('utf8')) } : undefined;
}

// The plan for colleagues, read the way the Files tab reads it.
function sharePlan(folder: string): string | null {
  const read = readCardFile(folder, SHARE_PLAN_FILE);
  return read.ok ? read.bytes.toString('utf8') : null;
}

// The epic's criteria and decisions its tasks copy, read the way the Files tab reads each file. A file
// that is not there, or one in the shape from before the ids, gives none.
function epicSeed(folder: string, key: string): EpicSeed {
  const text = (path: string) => {
    const read = readCardFile(folder, path);
    return read.ok ? read.bytes.toString('utf8') : '';
  };
  return { key, criteria: refinedCriteria(text('refine/refined.md')), decisions: decisionLines(`${text('architecture/architecture.md')}\n${text('plan/plan.md')}`) };
}

// The entries of the card's discoveries, read the way the Files tab reads the file, for the fact that
// opens it.
function discoveriesIn(folder: string): number {
  const read = readCardFile(folder, DISCOVERIES_FILE);
  return read.ok ? read.bytes.toString('utf8').split(/\r?\n/).filter((line) => /^[-*] /.test(line)).length : 0;
}

// The step titles of a card's plan, or null with no plan in the step form. The board counts an epic's
// steps not added to Delivery yet with these, read as the Overview reads them.
export function planSteps(db: DatabaseSync, key: string, env: Record<string, string | undefined> = process.env): string[] | null {
  const folder = cardFolder(db, key, env);
  const text = folder === null ? null : planText(folder);
  return text === null ? null : (parsePlan(text)?.steps?.map((step) => step.text) ?? null);
}

// What the overview tab reads, or null for a card that is not there.
export function overviewFor(db: DatabaseSync, key: string, env: Record<string, string | undefined> = process.env): Overview | null {
  const card = db.prepare('SELECT state, stage, summary, extra_context, board, source FROM cards WHERE key = ?').get(key) as
    | { state: string; stage: string; summary: string | null; extra_context: string | null; board: BoardKind; source: string }
    | undefined;
  if (card === undefined) return null;
  const newest = db
    .prepare('SELECT plain_summary, phase, ended_at FROM runs WHERE card_key = ? AND plain_summary IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get(key) as { plain_summary: string; phase: string; ended_at: string | null } | undefined;
  const built = db
    .prepare("SELECT plain_summary AS summary, phase, ended_at FROM runs WHERE card_key = ? AND plain_summary IS NOT NULL AND phase <> 'qa' ORDER BY id DESC LIMIT 1")
    .get(key) as { summary: string; phase: string; ended_at: string | null } | undefined;
  // The newest run is the one that asked, the same row the answer route continues.
  const asked =
    card.state === 'blocked'
      ? (db
          .prepare(`SELECT id, question, question_options, session_id, phase, engine, coalesce(asked_model, model) AS model, effort FROM runs WHERE card_key = ? AND ${NOT_A_PASS} ORDER BY id DESC LIMIT 1`)
          .get(key) as
          | { id: number; question: string | null; question_options: string | null; session_id: string | null; phase: string; engine: string; model: string | null; effort: string | null }
          | undefined)
      : undefined;
  const options = storedQuestionOptions(asked?.question_options ?? null);
  // In the state a person is shown, so the trail says what the board and the panel say.
  const shown = shownRunState(db);
  const runs = cardRuns(db, key).map((run) => ({ ...run, state: shown(run.state) }));
  const flow = getSetting(db, 'deliveryFlow');
  const stages = boardFor(card.board, flow).stages;
  const closed = isClosed(card.board, card.stage, flow);
  const events = db.prepare('SELECT from_stage, to_stage, who, at, started_phase, reason FROM card_events WHERE card_key = ? ORDER BY id').all(key) as {
    from_stage: string | null;
    to_stage: string;
    who: string;
    at: string;
    started_phase: string | null;
    reason: string | null;
  }[];
  const folder = cardFolder(db, key, env);
  const refined = db.prepare("SELECT ended_at FROM runs WHERE card_key = ? AND phase = 'refine' AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1").get(key) as { ended_at: string } | undefined;
  const epic = card.board === 'epics' ? epicDocs(db, key, env) : null;
  const broke = readOnlyBreakOf(db, key);
  const phase = stages.find((one) => one.id === card.stage)?.phase;
  const shared = card.board === 'epics' && folder !== null ? sharePlan(folder) : null;
  const research = folder === null ? undefined : researchReport(folder, card.board);
  return {
    ...(research === undefined ? {} : { research }),
    ...(card.board === 'epics' && folder !== null ? { seed: epicSeed(folder, key) } : {}),
    ...(shared === null ? {} : { sharePlan: shared }),
    // A project of local tickets links a task to a GitHub issue, which Nolzu reads through `gh`.
    ...(card.board === 'epics' ? { linkSystem: getSetting(db, 'ticketSystem') === 'jira' ? 'Jira' : 'GitHub' } : {}),
    summary: newest?.plain_summary ?? null,
    summaryPhase: newest?.phase ?? null,
    built: built === undefined ? null : { summary: built.summary, phase: built.phase, at: built.ended_at },
    ticketSource: SOURCE_WORDS[card.source] ?? card.source,
    refinedAt: refined?.ended_at ?? null,
    docs: epic?.docs ?? null,
    solution: epic?.solution ?? null,
    summaryFrom: newest === undefined ? null : closed && newest.phase === 'wrapup' ? 'The whole card, written at wrap-up' : `Written after ${phaseLabel(newest.phase)}`,
    summaryAt: newest?.ended_at ?? null,
    plan: folder !== null && pastPlan(stages, card.stage, card.state) ? planText(folder) : null,
    planOpen: phase === 'plan' || phase === 'implement',
    ticket: card.summary,
    extra: card.extra_context,
    related: relatedCards(db, key),
    tasks: card.board === 'epics' ? epicTasks(db, key, flow) : null,
    ...(card.board === 'epics' ? { nextKey: peekLocalKey(db, 1, getSetting(db, 'localKeyPrefix')).key } : {}),
    blocked:
      asked === undefined
        ? null
        : {
            runId: asked.id,
            question: asked.question ?? '',
            sessionId: asked.session_id,
            ...(options === null ? {} : { options }),
            phase: asked.phase,
            engine: asked.engine,
            model: asked.model,
            effort: asked.effort,
          },
    // The card's own board, or the strip would name the Delivery phases under an Epics card.
    strip: phaseStrip(boardFor(card.board, flow), runs),
    spend: spendOf(runs),
    readOnlyBreak: broke === null ? null : { ...broke, phase: phaseLabel(broke.phase), engine: engineName(broke.engine) },
    commitWarning: commitWarningOf(db, key),
    gate: closed ? null : gateFor(db, key, env),
    moves: events.map((event, index) => {
      const at = (id: string | null) => stages.findIndex((stage) => stage.id === id);
      // A move into Review reads as the person's move on out of it: "approved by you". A move
      // back from Review is no approval, so the row then keeps who moved the card in.
      const approved = event.to_stage === 'review' ? events.find((later, after) => after > index && later.from_stage === 'review') : undefined;
      const onward = approved !== undefined && at(approved.to_stage) > at('review') ? approved : undefined;
      return {
        label: stages.find((stage) => stage.id === event.to_stage)?.label ?? event.to_stage,
        ...(onward === undefined ? { said: `moved by ${MOVER[event.who] ?? event.who}`, at: event.at } : { said: `approved by ${MOVER[onward.who] ?? onward.who}`, at: onward.at }),
        phase: event.started_phase,
        ...(event.reason === null ? {} : { reason: event.reason, from: stages.find((stage) => stage.id === event.from_stage)?.phase ?? null }),
        ...(event.reason !== null && at(event.to_stage) < at(event.from_stage) ? { back: true as const } : {}),
      };
    }),
  };
}

export interface KnowledgeLine {
  id: number;
  // From the knowledge repository's root, as git prints it.
  path: string;
  status: KnowledgeStatus;
  summary: string | null;
  // The change the commit made to the file, or null with no commit to read it from.
  diff: string | null;
  // When the commit was made, read with the same git call, which the closed card draws as a time ago.
  applied: string | null;
}

/**
 * The knowledge change a closed card's wrap-up made: the files of its newest run that touched any,
 * each with the patch its commit made. One git call per file, and a card's wrap-up touches few. With
 * `patches` false git is not asked, so the card page draws the rows at once and streams the patches.
 */
export async function cardKnowledge(
  db: DatabaseSync,
  key: string,
  env: Record<string, string | undefined> = process.env,
  patches = true,
): Promise<KnowledgeLine[]> {
  const mine = allKnowledgeChanges(db).filter((row) => row.cardKey === key);
  const run = Math.max(...mine.map((row) => row.runId));
  const folder = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: getSetting(db, 'projectPath') });
  const lines: KnowledgeLine[] = [];
  for (const row of mine.filter((one) => one.runId === run)) {
    // A moved change's commit is in another repository, so this folder is not asked for it.
    const read = patches && folder !== null && existsSync(folder) && row.commitSha !== null && row.movedFrom === null;
    const said = read ? await commitPatch(folder, row.commitSha ?? '', row.filePath, env) : null;
    lines.push({ id: row.id, path: row.filePath, status: row.status, summary: row.summary, diff: said?.diff ?? null, applied: said?.committedAt ?? null });
  }
  return lines;
}

export interface Fact {
  label: string;
  value: string;
  // On the branch of an open card: the page offers to rename it, unless `locked` says why it cannot.
  edit?: { locked: string | null };
  // A file of the card folder the fact opens on the Files tab, as the discoveries do.
  file?: string;
  // On the source of a card that came from a ticket system: the ticket's key, and its page there when
  // Nolzu knows the address. "Jira (PROJ-123)".
  ticket?: SourceTicket;
}

const SOURCES: Readonly<Record<string, string>> = { local: 'local ticket', github: 'GitHub', 'github-pr': 'GitHub', jira: 'Jira', linear: 'Linear' };

export interface SourceTicket {
  key: string;
  href: string | null;
}

/**
 * The ticket a card came from, with the address of its page where Nolzu can build it: a Jira key on
 * the project's site, the way Jira does (`<site>/browse/PROJ-123`), and a GitHub issue or pull request
 * kept as `owner/repo#42`. A Linear page needs the workspace name and a GitLab one the host, and the
 * card keeps neither, so those show the key alone, as a Jira key does on a project with no site.
 */
export function sourceTicket(source: string, ref: string | null, jiraSite: string | null): SourceTicket | null {
  if (source === 'local' || ref === null || ref === '') return null;
  if (source === 'jira') return { key: ref, href: jiraSite === null ? null : `${jiraSite}/browse/${encodeURIComponent(ref)}` };
  const github = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(ref);
  if ((source === 'github' || source === 'github-pr') && github !== null) {
    return { key: ref, href: `https://github.com/${github[1]}/${github[2]}/${source === 'github-pr' ? 'pull' : 'issues'}/${github[3]}` };
  }
  return { key: ref, href: null };
}

/**
 * The facts under the trail on the overview: the branch, on a closed card the repositories it worked
 * in, the checkout, the newest session of each phase, the engine, how many discoveries the card wrote
 * and where the ticket came from. The branch is read off the checkout with one git call. An open card
 * with no checkout shows the name its first run will take, so the person can change it before then. A
 * pushed branch is locked. The engine is the newest run's, or with `models` the next step's on a card
 * that never ran.
 */
export async function cardFacts(db: DatabaseSync, key: string, env: Record<string, string | undefined>, models?: ModelsByVendor): Promise<Fact[]> {
  const card = db.prepare('SELECT source, source_ref, board, stage FROM cards WHERE key = ?').get(key) as
    | { source: string; source_ref: string | null; board: BoardKind; stage: string }
    | undefined;
  if (card === undefined) return [];
  const facts: Fact[] = [];
  const flow = getSetting(db, 'deliveryFlow');
  const closed = isClosed(card.board, card.stage, flow);
  // An open card shows its repositories on the Settings tab. The removed checkout's time stays out:
  // no record holds it.
  const repos = closed ? cardRepos(db, key)?.repos : undefined;
  const repoFact = repos === undefined ? [] : [{ label: repos.length === 1 ? 'Repository' : 'Repositories', value: repos.join(', ') }];
  const project = getSetting(db, 'projectPath');
  if (project !== null && isPlainName(key)) {
    const at = checkoutRoot(project, key);
    // The root is the checkout of ".", or a plain folder that holds one checkout per child repository
    // when the project's list has no ".". Either way the card has a checkout once one of them has its .git.
    const held = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') })
      .map((repo) => checkoutPath(project, key, repo.path))
      .find((path) => existsSync(join(path, '.git')));
    if (held !== undefined) {
      const forGit = gitEnv(env);
      const branch = (await git(['branch', '--show-current'], { cwd: held, env: forGit })).stdout.trim();
      if (branch !== '') {
        let locked: string | null = closed ? 'A closed card keeps its branch.' : null;
        // Each of the card's checkouts, since a push from any of them makes the name known.
        for (const one of cardCheckouts(db, key)) {
          locked ??= await pushedReason((args) => git(args, { cwd: one.path, env: forGit }), branch);
        }
        facts.push({ label: 'Branch', value: branch, edit: { locked } });
      }
      facts.push(...repoFact, { label: 'Checkout', value: relative(project, at) });
    } else {
      if (!closed) {
        try {
          facts.push({ label: 'Branch', value: templateBranch(db, key), edit: { locked: null } });
        } catch {
          // A template branchName refuses names nothing. Settings says what is wrong with it.
        }
      }
      // A closed card gets no checkout any more, and its own may have been removed.
      facts.push(...repoFact, { label: 'Checkout', value: closed ? 'none' : 'none yet' });
    }
  } else facts.push(...repoFact);
  // The phases of the card's own board, so a summary pass or a commit message names no session here.
  const stages = boardFor(card.board, flow).stages;
  const phases = new Set<string | undefined>(stages.map((stage) => stage.phase));
  const sessions = new Map<string, string>();
  const runs = cardRuns(db, key).filter((run) => phases.has(run.phase));
  for (const run of runs) if (run.sessionId !== null) sessions.set(run.phase, run.sessionId);
  for (const [phase, id] of sessions) facts.push({ label: `${phaseLabel(phase)} session`, value: id.slice(0, 8) });
  const next = stages.slice(stages.findIndex((stage) => stage.id === card.stage) + 1).find((stage) => stage.phase !== undefined)?.phase;
  const engine = runs.at(-1)?.engine ?? (models === undefined || next === undefined ? undefined : settingsFor(db, key, models)?.rows.find((row) => row.action === next)?.resolved.engine);
  if (engine !== undefined) facts.push({ label: 'Engine', value: engineName(engine) });
  // Read off the project's card folder only. Left out at none, like a session that never ran.
  const folder = project === null ? null : cardFolder(db, key, env);
  const discoveries = folder === null ? 0 : discoveriesIn(folder);
  if (discoveries > 0) facts.push({ label: 'Discoveries', value: String(discoveries), file: DISCOVERIES_FILE });
  const ticket = sourceTicket(card.source, card.source_ref, getSetting(db, 'jiraSite'));
  facts.push({ label: 'Source', value: SOURCES[card.source] ?? card.source, ...(ticket === null ? {} : { ticket }) });
  return facts;
}

// What the tabs hold, by tab id, for "Files 3" and "Discussion 2". Cheap reads only, because
// the head loads them on every tab: the Changes count needs git and is left out.
export function tabCounts(db: DatabaseSync, key: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const files = filesFor(db, key, env).reduce((sum, group) => sum + group.files.length, 0);
  const said = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE card_key = ?').get(key) as { n: number }).n;
  // The newest review round's findings. A card with no pr-review folder reads one empty folder list.
  const findings = reviewFor(db, key, null, env).blocks.length;
  // Every run the Log tab lists, passes too.
  const runs = (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE card_key = ?').get(key) as { n: number }).n;
  return {
    ...(files > 0 ? { files: String(files) } : {}),
    ...(said > 0 ? { discussion: String(said) } : {}),
    ...(findings > 0 ? { review: String(findings) } : {}),
    ...(runs > 0 ? { log: runs === 1 ? '1 run' : `${runs} runs` } : {}),
  };
}

// Enough for pages of notes, and small enough that no one pastes a log into the prompt by mistake.
export const CONTEXT_LIMIT = 64_000;

const answer = (status: number, body: object): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function saveContext(db: DatabaseSync, key: string, request: Request): Promise<Response> {
  const tooLarge = answer(413, { message: `The extra context is over ${CONTEXT_LIMIT / 1000} kB, which is the limit. Shorten it and save again.` });
  // A body far over the limit is refused before it is read. The limit itself is on the text, because
  // JSON writes every quote and line break of it twice.
  if (Number(request.headers.get('content-length') ?? 0) > CONTEXT_LIMIT * 8) return tooLarge;
  let text: unknown;
  try {
    text = ((await request.json()) as { text?: unknown }).text;
  } catch {
    text = undefined;
  }
  if (typeof text !== 'string') return answer(400, { message: 'The extra context needs a text, which can be empty to clear it.' });
  if (Buffer.byteLength(text, 'utf8') > CONTEXT_LIMIT) return tooLarge;
  if (!setExtraContext(db, key, text)) return answer(404, { message: `There is no card ${key} here, so there is nothing to add context to.` });
  return answer(200, { ok: true });
}

export function unlink(db: DatabaseSync, key: string, other: string): Response {
  if (!unlinkCards(db, key, other)) return answer(404, { message: `${key} and ${other} are not linked.` });
  return answer(200, { ok: true });
}
