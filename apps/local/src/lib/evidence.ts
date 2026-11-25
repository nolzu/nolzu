import type { DatabaseSync } from 'node:sqlite';
import { boardFor } from '@nolzu/core';
import { allCardMoves, allRuns, getSetting, type StoredRun } from '@nolzu/core/node';
import {
  type DeliveryFlow,
  type EvidenceBlock,
  type EvidenceDay,
  evidenceDays,
  isBoardKind,
  isMaintenanceKey,
  phaseLabel,
  previousWorkingDay,
  spendOf,
  type Standup,
  type StandupCard,
  type Verdict,
} from '@nolzu/protocol';
import { git, gitEnv } from '@nolzu/runner';
import { cardBranch, cardCheckouts, templateBranch } from './checkout.ts';

/**
 * What the Evidence screen reads, from the database and from git.
 *
 * The rules are in `@nolzu/protocol`; this file only gathers and writes the words. It is built the
 * way `knowledge-page.ts` is, because that is the other screen that mixes stored rows with facts
 * only the repository holds: core may not spawn a process, so the git call lives here.
 *
 * The day is the UTC day, the same one `spendReport` groups a run by. On a machine east of UTC that
 * means an evening run belongs to the day the cost report puts it on and not to the one the wall
 * clock shows, which is why the screen says which day it means.
 */

interface CardRow {
  key: string;
  title: string;
  board: string;
}

interface OpenCardRow extends CardRow {
  stage: string;
  state: string;
}

// A run's `card_key` has no foreign key behind it, so it can name a card that was deleted or the
// key a maintenance run holds. Neither can be linked, so the block carries no card and its line
// names the owner instead.
function owner(key: string, cards: Map<string, CardRow>): { card: string | null; cardTitle: string | null; about: string } {
  if (isMaintenanceKey(key)) return { card: null, cardTitle: null, about: ' for maintenance' };
  const card = cards.get(key);
  if (card === undefined) return { card: null, cardTitle: null, about: ` for ${key}` };
  return { card: key, cardTitle: card.title, about: '' };
}

const VERDICT_WORDS: Readonly<Record<Verdict, string>> = { PASS: 'passed', FAIL: 'failed', BLOCKED: 'blocked' };

// A null `ended_at` is the honest test for a run still going: it is stamped only when the run
// reports one of the four states it does not come back from, and the state column can hold a value
// nothing has folded yet.
const outcome = (run: StoredRun): string => {
  if (run.endedAt === null) return 'still going';
  // A QA run's verdict is what a person wants off the line. BLOCKED is neither a pass nor a fail:
  // QA could not get far enough to judge.
  if (run.verdict !== null) return VERDICT_WORDS[run.verdict];
  return run.state === 'complete' ? 'finished' : (run.state ?? 'ended');
};

// The stage as it is named on its board. A board this version does not know, which a hand edit can
// write, falls back to the stored id rather than reading another board's columns.
function stageLabel(card: CardRow | undefined, stage: string, flow: DeliveryFlow): string {
  if (card === undefined || !isBoardKind(card.board)) return stage;
  return boardFor(card.board, flow).stages.find((one) => one.id === stage)?.label ?? stage;
}

function runBlock(run: StoredRun, cards: Map<string, CardRow>): EvidenceBlock | null {
  // A queued run has no start, so it is in no day. The cost report drops it for the same reason:
  // putting it under today would invent a day it never ran on.
  if (run.startedAt === null) return null;
  const { card, cardTitle, about } = owner(run.cardKey, cards);
  return {
    start: run.startedAt,
    source: 'run',
    ref: String(run.id),
    card,
    cardTitle,
    description: `${phaseLabel(run.phase)} run${about}, ${outcome(run)}`,
    durationMs: run.durationMs,
    spend: spendOf([run]),
    running: run.endedAt === null,
  };
}

export interface EvidenceOptions {
  // The UTC day to read, `YYYY-MM-DD`. Today by default, and injectable so a test pins a day
  // without faking the clock.
  day?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * The commits of one day, from the project's own repository.
 *
 * One `git log` for the whole day. `--all` is what reaches the card branches: a card worktree
 * shares the project's object store, so its commits are here and a plain log would show none of
 * them. `%cI` carries the committer's own offset, so it is read back in UTC before the day is
 * taken, or a commit made late in the evening lands on the next day while the runs beside it do
 * not.
 */
async function commitBlocks(
  db: DatabaseSync,
  day: string,
  cards: Map<string, CardRow>,
  options: EvidenceOptions,
): Promise<{ blocks: EvidenceBlock[]; problem: string | null }> {
  const projectPath = getSetting(db, 'projectPath');
  // No project yet. There is nothing to read and nothing to report, the way the Changes tab treats it.
  if (projectPath === null) return { blocks: [], problem: null };

  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  // Never drawn as a day with no commits: that would tell a person nothing happened on a day they
  // worked. git answers a bad range with an exit code and a folder that is gone with a throw, so
  // both end in the same sentence, with git's own words on it.
  const refused = (why: string) =>
    `The commits of this day could not be read from ${projectPath}. Check the folder is still a git repository. ${why}`.trim();
  let said;
  try {
    said = await git(
      [
        'log',
        '--all',
        '--source',
        '--no-merges',
        `--since=${day}T00:00:00Z`,
        `--until=${next.toISOString()}`,
        '--format=%H%x09%cI%x09%S%x09%s',
      ],
      { cwd: projectPath, env: gitEnv(options.env ?? process.env), signal: options.signal },
    );
  } catch (error) {
    return { blocks: [], problem: refused(error instanceof Error ? error.message : String(error)) };
  }
  if (said.code !== 0) return { blocks: [], problem: refused(said.stderr.trim()) };

  // A started card is asked for the branch its checkout is on, since it keeps that one when the title
  // or the template changes. A card with no checkout is worked out from the template, with no git call.
  const forGit = gitEnv(options.env ?? process.env);
  const named = await Promise.all(
    [...cards.values()].map(async (card) => {
      try {
        const checkouts = cardCheckouts(db, card.key).map((one) => one.path);
        return [checkouts.length > 0 ? await cardBranch(db, card.key, checkouts, forGit) : templateBranch(db, card.key, card.title), card.key] as const;
      } catch {
        // A template the settings screen would refuse, from a hand edit. The commits still show; they
        // just carry no card.
        return null;
      }
    }),
  );
  const branches = new Map(named.filter((one) => one !== null));

  const blocks: EvidenceBlock[] = [];
  for (const line of said.stdout.split('\n')) {
    const [sha = '', at = '', ref = '', ...rest] = line.split('\t');
    if (sha === '' || at === '') continue;
    const stamp = new Date(at);
    if (Number.isNaN(stamp.getTime())) continue;
    const start = stamp.toISOString();
    // git's window is generous at both edges, so the day is checked here against the same rule
    // every other block is grouped by.
    if (start.slice(0, 10) !== day) continue;
    const key = branches.get(ref.replace(/^refs\/heads\//, '')) ?? null;
    const card = key === null ? undefined : cards.get(key);
    blocks.push({
      start,
      source: 'commit',
      ref: sha.slice(0, 7),
      card: card === undefined ? null : card.key,
      cardTitle: card?.title ?? null,
      description: rest.join('\t').trim() === '' ? 'A commit with no message' : rest.join('\t').trim(),
      durationMs: null,
      spend: null,
      running: false,
    });
  }
  return { blocks, problem: null };
}

/** One day of evidence, today by default. */
export async function evidenceFor(db: DatabaseSync, options: EvidenceOptions = {}): Promise<EvidenceDay> {
  const day = options.day ?? today();
  const flow = getSetting(db, 'deliveryFlow');
  const rows = db.prepare('SELECT key, title, board FROM cards ORDER BY key').all() as unknown as CardRow[];
  const cards = new Map(rows.map((row) => [row.key, row]));

  const runs = allRuns(db).flatMap((run) => {
    const block = runBlock(run, cards);
    return block !== null && block.start.slice(0, 10) === day ? [block] : [];
  });
  const moves = allCardMoves(db).flatMap((move): EvidenceBlock[] => {
    if (move.at.slice(0, 10) !== day) return [];
    const card = cards.get(move.cardKey);
    const to = stageLabel(card, move.toStage, flow);
    const from = move.fromStage === null ? null : stageLabel(card, move.fromStage, flow);
    return [
      {
        start: move.at,
        source: 'move',
        ref: String(move.id),
        card: card === undefined ? null : move.cardKey,
        cardTitle: card?.title ?? null,
        description: from === null ? `Moved to ${to}` : `Moved from ${from} to ${to}`,
        durationMs: null,
        spend: null,
        running: false,
      },
    ];
  });
  const commits = await commitBlocks(db, day, cards, options);

  // Moves first, then runs, then commits: a tie on the stamp keeps this order, and inside each
  // source the rows arrive oldest id first.
  // Every block here is already of the one day, so the fold gives back that day or nothing at all.
  const [found] = evidenceDays([...moves, ...runs, ...commits.blocks]);
  return { ...(found ?? { day, blocks: [], spend: spendOf([]) }), problem: commits.problem };
}

/**
 * The phase of each run block of a day, by the block's ref, as the short word a timeline block prints
 * ("plan", "wrap-up"). Read off the rows and never out of the block's sentence, which is written for
 * people. Apart from the block, because the block is what the hub stores and this is screen only.
 */
export function runPhases(db: DatabaseSync, day: EvidenceDay): Record<string, string> {
  const refs = new Set(day.blocks.flatMap((block) => (block.source === 'run' ? [block.ref] : [])));
  return Object.fromEntries(allRuns(db).flatMap((run) => (refs.has(String(run.id)) ? [[String(run.id), phaseLabel(run.phase).toLowerCase()]] : [])));
}

/**
 * The standup of one day: the previous working day's evidence, and the board as it stands now.
 *
 * A card is in progress once it left its board's first stage and until it reaches the archive. A
 * stage this version does not know, from a hand edit, counts as in progress: the card is on the board
 * somewhere and a standup that dropped it would hide work.
 */
export async function standupFor(db: DatabaseSync, options: EvidenceOptions = {}): Promise<Standup> {
  const day = options.day ?? today();
  const flow = getSetting(db, 'deliveryFlow');
  const rows = db.prepare('SELECT key, title, board, stage, state FROM cards ORDER BY key').all() as unknown as OpenCardRow[];
  const cards = rows.flatMap((row): StandupCard[] => {
    const stages = isBoardKind(row.board) ? boardFor(row.board, flow).stages : [];
    const at = stages.findIndex((one) => one.id === row.stage);
    if (at === 0 || stages[at]?.role === 'archive') return [];
    return [{ key: row.key, title: row.title, stage: stageLabel(row, row.stage, flow), blocked: row.state === 'blocked' }];
  });
  return { day, yesterday: await evidenceFor(db, { ...options, day: previousWorkingDay(day) }), cards };
}
