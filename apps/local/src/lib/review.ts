import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { newCommitsOf } from '@nolzu/core/node';
import type { PullDecision } from '@nolzu/protocol';
import { readCardFile } from '@nolzu/runner';
import { parseRound, type ReviewBlock, rereviewWhy, type RoundBlocks } from '@nolzu/ui/review';
import { cardFolder } from './files.ts';

export interface ReviewRound {
  number: number;
  // Where the file sits under the card folder, so the Files tab and this tab name one path.
  file: string;
}

// What the card row knows about the review. GitHub answers one decision word for the whole pull
// request and no list of reviewers, so this says where the review stands and never who approved.
// The stage the card sits on is not here: the page header above this tab already shows it.
export interface ReviewerState {
  decision: PullDecision | null;
  author: string | null;
  draft: boolean;
}

export interface ReviewView {
  // Oldest first, which is the order a person walks them.
  rounds: readonly ReviewRound[];
  current: number | null;
  blocks: readonly ReviewBlock[];
  // Why the shown round cannot be drawn, or null. Never a throw: a round file is a run's output and
  // a bad one is something to read about, not a broken page.
  problem: string | null;
  // Every round that could be read, oldest first, the shown one too, so the tab compares the shown
  // round with all the rounds before it and counts each. A round that cannot be read is left out
  // rather than read as empty, which would call every finding before it fixed.
  read: readonly RoundBlocks[];
  reviewer: ReviewerState;
  // The head commit the shown round read, short, or null when no review saved one for that round.
  head: string | null;
  // Why another round makes sense, for the decision panel: the commits pushed since the last round and
  // the findings it left open. Null before the first round.
  why: string | null;
}

// `round.md` is the name the skill writes for a first round, so it is round 1. A later round is
// `round-2.md` beside it, which is what makes a second round cost no reader change.
//
// The skill numbers the file, not this app. The app never touches the card folder between two runs:
// the round the run is about to write is the only file that could carry the number, and naming it
// from here would mean handing a file name through the job and the prompt for one phase out of ten.
// The cost is that a run that miscounts writes over a round, which the reader cannot undo, so the
// skill is told to list the folder first and never write over a round that is there.
const ROUND_FILE = /^round(?:-(\d+))?\.md$/;

// One number, one file. `round-1.md` and `round-02.md` are second spellings of numbers this list
// already has, and two rounds with one number key the selector twice, which Svelte refuses, so the
// whole tab would stop drawing. A file that is not a round is still on the Files tab as it was
// written.
const roundNumber = (digits: string | undefined): number | null => {
  if (digits === undefined) return 1;
  const number = Number(digits);
  return number < 2 || digits !== String(number) ? null : number;
};

export function roundsIn(dir: string): ReviewRound[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, 'pr-review'));
  } catch {
    // No folder is the normal case before the first review, and an unreadable one shows the same
    // empty tab. Either way there is no round to name.
    return [];
  }
  return names
    .flatMap((name) => {
      const found = ROUND_FILE.exec(name);
      const number = found === null ? null : roundNumber(found[1]);
      return number === null ? [] : [{ number, file: `pr-review/${name}` }];
    })
    .sort((one, other) => one.number - other.number);
}

interface CardRow {
  author: string | null;
  decision: PullDecision | null;
  draft: number;
  pr_round: number | null;
  pr_seen_sha: string | null;
  pr_seen_commits: number | null;
  pr_head_sha: string | null;
  pr_head_commits: number | null;
}

// One round read back into blocks, or the sentence why it cannot be. Read through the card folder's
// own reader, so a round file that is a folder, a link out of the card folder or bigger than a page
// shows answers with its own sentence instead of reaching the parser. A round file is a run's output,
// and a run writes what it likes.
function readRound(dir: string, round: ReviewRound): { ok: true; blocks: ReviewBlock[] } | { ok: false; problem: string } {
  const read = readCardFile(dir, round.file);
  if (!read.ok) return { ok: false, problem: read.reason };
  return parseRound(read.bytes.toString('utf8'));
}

/**
 * A card's review rounds, and where the review stands.
 *
 * The round the URL asks for, or the newest one. A number the card has no round for falls back to
 * the newest, the same way an unknown tab falls back to the overview. Every round is read, because the
 * tab compares the shown one with all before it; a round file is small and a card has a few.
 */
export function reviewFor(db: DatabaseSync, key: string, asked: string | null, env: Record<string, string | undefined> = process.env): ReviewView {
  const row = db
    .prepare(
      'SELECT pr_author AS author, pr_decision AS decision, pr_draft AS draft, pr_round, pr_seen_sha, pr_seen_commits, pr_head_sha, pr_head_commits FROM cards WHERE key = ?',
    )
    .get(key) as CardRow | undefined;
  const reviewer: ReviewerState = {
    decision: row?.decision ?? null,
    author: row?.author ?? null,
    draft: row?.draft === 1,
  };

  const dir = cardFolder(db, key, env);
  const rounds = dir === null ? [] : roundsIn(dir);
  const shown = rounds.find((round) => String(round.number) === asked) ?? rounds.at(-1) ?? null;
  const parsed = dir === null ? [] : rounds.map((round) => ({ round, found: readRound(dir, round) }));
  const read = parsed.flatMap(({ round, found }) => (found.ok ? [{ number: round.number, blocks: found.blocks }] : []));

  // The round the last review saved, against the head the last Read pull requests saw. With no head
  // saved for the round, or none in the last read, nothing is known about a push, which is not the
  // same as no push.
  const round = row?.pr_round ?? null;
  const pushed = row === undefined || row.pr_head_sha === null || row.pr_seen_sha === null ? null : (newCommitsOf(row) ?? 0);
  const open = read.find((one) => one.number === round)?.blocks.filter((block) => block.label !== 'praise').length ?? 0;
  const why = rereviewWhy({ author: reviewer.author, round, pushed, open });

  const found = parsed.find((one) => one.round === shown)?.found ?? null;
  if (shown === null || found === null) return { rounds, current: null, blocks: [], problem: null, read, reviewer, head: null, why };
  return {
    rounds,
    current: shown.number,
    blocks: found.ok ? found.blocks : [],
    problem: found.ok ? null : found.problem,
    read,
    reviewer,
    head: shown.number === round && row?.pr_head_sha != null ? row.pr_head_sha.slice(0, 7) : null,
    why,
  };
}
