import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, openDatabase, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tabCounts } from './overview.ts';
import { reviewFor } from './review.ts';

const THREE = `issue: src/recipes/import.ts:88
A recipe file with no ingredients throws, so one bad file stops the whole import. Return an empty
list here and let the caller name the file it came from.

suggestion: src/recipes/import.ts:120
The caller reads the same file twice. Read it once and pass the parsed recipe down.

praise: src/recipes/list.ts:14
The list reads in one pass and names the file its error came from.
`;

let dir = '';
let project = '';
let db: DatabaseSync;

// The key GitHub gives a pull request card, which holds a `#` and no slash, so it is one folder name.
const KEY = 'recipes#42';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-review-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-review-project-'));
  db = openDatabase(dir);
  writeSetting(db, 'projectPath', project);
  createCard(db, { key: KEY, board: 'prreview', stage: 'pre-review', title: 'Import recipes from a folder' });
  db.prepare("UPDATE cards SET pr_author = 'dana', pr_decision = 'CHANGES_REQUESTED', pr_draft = 1 WHERE key = ?").run(KEY);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const writeRound = (name: string, text: string) => {
  const folder = join(project, '.tasks', KEY, 'pr-review');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), text);
};

it('reads the round the review wrote into the card folder', () => {
  writeRound('round.md', THREE);

  const view = reviewFor(db, KEY, null);

  expect(view.rounds).toEqual([{ number: 1, file: 'pr-review/round.md' }]);
  expect(view.current).toBe(1);
  expect(view.problem).toBeNull();
  expect(view.blocks.map((block) => block.label)).toEqual(['issue', 'suggestion', 'praise']);
});

// The round file is the only thing that says a review happened, so a card with none says so rather
// than showing an empty round.
it('names no round on a card whose folder has none', () => {
  const view = reviewFor(db, KEY, null);

  expect(view.rounds).toEqual([]);
  expect(view.current).toBeNull();
  expect(view.blocks).toEqual([]);
  expect(view.problem).toBeNull();
});

it('reads the review state off the card row', () => {
  expect(reviewFor(db, KEY, null).reviewer).toEqual({ decision: 'CHANGES_REQUESTED', author: 'dana', draft: true });
});

it('says a card that is not a pull request carries no decision', () => {
  createCard(db, { key: 'RECI-1', board: 'delivery', stage: 'inbox', title: 'Add a recipe' });

  expect(reviewFor(db, 'RECI-1', null).reviewer).toEqual({ decision: null, author: null, draft: false });
});

// A second round sits beside the first, which is what makes the selector worth drawing. `round.md`
// is the name the skill writes, so it is round 1.
it('lists every round in order and shows the newest by default', () => {
  writeRound('round.md', THREE);
  writeRound('round-2.md', 'praise: src/recipes/import.ts:88\nThe empty file now returns an empty list, and the caller names the file.\n');

  const view = reviewFor(db, KEY, null);

  expect(view.rounds.map((round) => round.number)).toEqual([1, 2]);
  expect(view.current).toBe(2);
  expect(view.blocks).toHaveLength(1);
});

it('shows the round the address asks for', () => {
  writeRound('round.md', THREE);
  writeRound('round-2.md', 'praise: src/recipes/import.ts:88\nThe empty file now returns an empty list.\n');

  expect(reviewFor(db, KEY, '1').current).toBe(1);
  expect(reviewFor(db, KEY, '1').blocks).toHaveLength(3);
});

// The same fallback an unknown tab gets, because the address is one a person can have bookmarked.
it('falls back to the newest round when the address asks for one that is not there', () => {
  writeRound('round.md', THREE);

  expect(reviewFor(db, KEY, '7').current).toBe(1);
  expect(reviewFor(db, KEY, 'nonsense').current).toBe(1);
});

// A file in the folder that is not a round is not one. The review also writes a summary there.
it('reads no round out of the other files the review leaves in the folder', () => {
  writeRound('round.md', THREE);
  writeRound('summary.md', 'The import stops on one bad file.');
  writeRound('diff.patch', 'diff --git a/src/recipes/import.ts b/src/recipes/import.ts\n');

  expect(reviewFor(db, KEY, null).rounds.map((round) => round.file)).toEqual(['pr-review/round.md']);
});

// The refusal reaching the page as data, never as a throw: a round file is a run's output, and a bad
// one is something to read about rather than a broken tab.
it('hands back the refusal sentence and no block when a block carries no label', () => {
  writeRound('round.md', `Looks fine to me.\n\n${THREE}`);

  const view = reviewFor(db, KEY, null);

  expect(view.blocks).toEqual([]);
  expect(view.problem).toContain('"Looks fine to me."');
  expect(view.current).toBe(1);
});

it('reads no round for a key that is not one folder name', () => {
  expect(reviewFor(db, 'over/there', null).rounds).toEqual([]);
});

// One number, one file. Two names that mean round 1 would key the selector twice, which Svelte
// refuses, and the tab would stop drawing instead of showing a round it cannot number.
it('reads no round out of a second spelling of a number it already has', () => {
  writeRound('round.md', THREE);
  writeRound('round-1.md', 'praise: src/a.ts:1\nA copy of round one under another name.\n');
  writeRound('round-02.md', 'praise: src/a.ts:2\nRound two with a leading zero.\n');

  expect(reviewFor(db, KEY, null).rounds).toEqual([{ number: 1, file: 'pr-review/round.md' }]);
});

// A backup file the author left beside the round. Read as a round it carries a number the list
// already has, which keys the selector twice, and Svelte refuses that, so the whole tab stops drawing.
it('reads no round out of a file whose name carries more after the .md', () => {
  writeRound('round.md', THREE);
  writeRound('round.md.orig', 'praise: src/a.ts:1\nA copy of the round under another name.\n');
  writeRound('round-2.md.bak', 'praise: src/a.ts:2\nA copy of the second round.\n');

  expect(reviewFor(db, KEY, null).rounds).toEqual([{ number: 1, file: 'pr-review/round.md' }]);
});

// The round file is read through the card folder's own reader, so what a run wrote cannot reach the
// parser from outside the folder, as a folder, or at a size no page shows. The sentence says which.
it('refuses a round file that is a folder and names it', () => {
  mkdirSync(join(project, '.tasks', KEY, 'pr-review', 'round.md'), { recursive: true });

  const view = reviewFor(db, KEY, null);

  expect(view.current).toBe(1);
  expect(view.blocks).toEqual([]);
  expect(view.problem).toContain('is a folder, not a file');
});

it('refuses a round file bigger than a page shows', () => {
  writeRound('round.md', `issue: src/a.ts:1\n${'x'.repeat(2_000_000)}\n`);

  expect(reviewFor(db, KEY, null).problem).toContain('over the');
});

/**
 * The round the fake engine's pr-review scenario writes, read by this tab.
 *
 * Fake mode is the only mode the PR review board can use with no `gh`, so the round it leaves
 * behind has to be one this tab draws. The runner may not import the parser, so the two texts meet
 * here: a scenario whose blocks stopped parsing would show an empty tab after a run that read
 * as finished.
 */
it('draws the round the fake pr-review scenario writes', async () => {
  const { fakeEngine } = await import('@nolzu/runner');
  const folder = join(project, '.tasks', KEY);
  mkdirSync(folder, { recursive: true });
  for await (const line of fakeEngine(0).spawn({ phase: 'pr-review', taskDir: folder }, new AbortController().signal)) void line;

  const view = reviewFor(db, KEY, null);

  expect(view.problem).toBeNull();
  expect(view.rounds).toEqual([{ number: 1, file: 'pr-review/round.md' }]);
  expect(view.blocks.map((block) => block.label)).toEqual(['issue', 'suggestion', 'praise']);
});

// The comparison the tab draws. The shown round is read against every round before it, so a person
// reading it knows what the author fixed without opening each one.
it('hands over every round that could be read, the shown one too', () => {
  writeRound('round.md', THREE);
  writeRound('round-2.md', 'praise: src/recipes/import.ts:88\nThe empty file now returns an empty list.\n');

  const view = reviewFor(db, KEY, '1');

  expect(view.current).toBe(1);
  expect(view.read.map((round) => round.number)).toEqual([1, 2]);
  expect(view.read[0]?.blocks.map((block) => block.label)).toEqual(['issue', 'suggestion', 'praise']);
});

// A comparison against half a round would call findings fixed that are still in the file, so a round
// that cannot be drawn is left out of the comparison.
it('leaves out a round that cannot be drawn', () => {
  writeRound('round.md', 'Looks fine to me.\n');
  writeRound('round-2.md', 'praise: src/recipes/import.ts:88\nThe empty file now returns an empty list.\n');

  const view = reviewFor(db, KEY, null);

  expect(view.current).toBe(2);
  expect(view.read.map((round) => round.number)).toEqual([2]);
});

// The other half of the same rule: a round the reader would not open at all, rather than one the
// parser refused. Compared as an empty round, every finding in the round shown reads as new and
// nothing on the screen says the earlier round is missing.
it('leaves out a round that cannot be read at all', () => {
  mkdirSync(join(project, '.tasks', KEY, 'pr-review', 'round.md'), { recursive: true });
  writeRound('round-2.md', 'issue: src/recipes/import.ts:88\nOne bad file still stops the whole import.\n');

  const view = reviewFor(db, KEY, null);

  expect(view.current).toBe(2);
  expect(view.read.map((round) => round.number)).toEqual([2]);
});

// A card whose round 2 file was deleted still has round 1 to compare round 3 with.
it('compares with the rounds there are below the one shown', () => {
  writeRound('round.md', THREE);
  writeRound('round-3.md', 'praise: src/recipes/import.ts:88\nFixed.\n');

  expect(reviewFor(db, KEY, null).read.map((round) => round.number)).toEqual([1, 3]);
});

// What the decision panel says beside the Review tab: the commits pushed since the round the review
// saved, from the heads the reads saw, and the findings that round left open.
describe('why another round makes sense', () => {
  const saved = (seen: string) =>
    db
      .prepare("UPDATE cards SET pr_round = 2, pr_head_sha = 'a1b2c3d4e5f6', pr_head_commits = 3, pr_seen_sha = ?, pr_seen_commits = 4 WHERE key = ?")
      .run(seen, KEY);
  beforeEach(() => {
    writeRound('round.md', THREE);
    writeRound('round-2.md', 'issue: src/recipes/import.ts:90\nOne bad file still stops the whole import.\n\npraise: src/recipes/list.ts:14\nStill one pass.\n');
  });

  it('names the commits pushed since the round and the findings it left open, praise not counted', () => {
    saved('f9e8d7c6b5a4');

    expect(reviewFor(db, KEY, null).why).toBe('dana pushed 1 commit after round 2. 1 finding from round 2 is still open.');
  });

  it('says nothing was pushed when the last read saw the head the round read', () => {
    saved('a1b2c3d4e5f6');

    expect(reviewFor(db, KEY, null).why).toBe('The last Read pull requests saw no push after round 2. Another round would read the same code. 1 finding from round 2 is still open.');
  });

  // No head saved for the round is no knowledge of a push, which is not the same as no push.
  it('says nothing of a push when no head was saved for the round', () => {
    db.prepare('UPDATE cards SET pr_round = 2 WHERE key = ?').run(KEY);

    expect(reviewFor(db, KEY, null).why).toBe('1 finding from round 2 is still open.');
  });

  // Read pull requests writes a head the answer lacked as null, so that read knows nothing of a push.
  it('says nothing of a push when the last read carried no head', () => {
    saved('a1b2c3d4e5f6');
    db.prepare('UPDATE cards SET pr_seen_sha = NULL, pr_seen_commits = NULL WHERE key = ?').run(KEY);

    expect(reviewFor(db, KEY, null).why).toBe('1 finding from round 2 is still open.');
  });

  it('says nothing before a review saved a round', () => {
    expect(reviewFor(db, KEY, null).why).toBeNull();
  });

  it('shows the head the saved round read, short, and no head on another round', () => {
    saved('f9e8d7c6b5a4');

    expect(reviewFor(db, KEY, null).head).toBe('a1b2c3d');
    expect(reviewFor(db, KEY, '1').head).toBeNull();
  });

  // The count beside the tab's name in the card head.
  it('counts the findings of the newest round on the Review tab', () => {
    expect(tabCounts(db, KEY).review).toBe('2');
    expect(tabCounts(db, 'RECI-9').review).toBeUndefined();
  });
});

// The skill numbers the round file and this module reads the number back, so the two are one pair.
// A skill taught another scheme would write rounds this tab cannot list, and nothing else in the
// suite would say so.
it('reads back the round names the skill is told to write', () => {
  const skill = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'skills', 'skills', 'nolzu-pr-review', 'SKILL.md'), 'utf8');

  expect(skill).toContain('pr-review/round.md');
  expect(skill).toContain('round-2.md');
  expect(skill).toContain('round-3.md');

  writeRound('round.md', THREE);
  writeRound('round-2.md', 'praise: src/recipes/import.ts:88\nThe empty file returns an empty list.\n');
  writeRound('round-3.md', 'praise: src/recipes/import.ts:90\nStill good.\n');

  expect(reviewFor(db, KEY, null).rounds.map((round) => round.number)).toEqual([1, 2, 3]);
});
