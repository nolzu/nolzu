import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import { parseRound, type ReviewBlock } from './review.ts';
import ReviewTab from './ReviewTab.svelte';

const THREE = `issue: src/recipes/import.ts:88
A recipe file with no ingredients throws, so one bad file stops the whole import. Return an empty list here.

suggestion (non-blocking): src/recipes/import.ts:120
The caller reads the same file twice. Read it once and pass the parsed recipe down.

praise: src/recipes/list.ts:14
The list reads in one pass and names the file its error came from.
`;

const blocksOf = (text: string): ReviewBlock[] => {
  const found = parseRound(text);
  if (!found.ok) throw new Error(found.problem);
  return found.blocks;
};

interface Props {
  rounds: readonly { number: number; file?: string }[];
  current: number | null;
  blocks: readonly ReviewBlock[];
  problem: string | null;
  read?: readonly { number: number; blocks: readonly ReviewBlock[] }[];
  reviewer: { decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null; author: string | null; draft: boolean };
  head?: string | null;
  filesHref?: string | null;
  oncopy: (text: string) => Promise<string | null>;
}

const defaults: Props = {
  rounds: [{ number: 1, file: 'pr-review/round.md' }],
  current: 1,
  blocks: blocksOf(THREE),
  problem: null,
  read: [{ number: 1, blocks: blocksOf(THREE) }],
  reviewer: { decision: 'CHANGES_REQUESTED', author: 'dana', draft: false },
  oncopy: async () => null,
};

const draw = (over: Partial<Props> = {}): string => render(ReviewTab, { props: { ...defaults, ...over } as Props }).body;
const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// What the plan asks the tab to do.
it('draws a round of three findings, each with its label, its file and its line', () => {
  const html = draw();
  const shown = text(html);

  expect(html.match(/data-finding="\d+"/g)).toHaveLength(3);
  for (const label of ['issue', 'suggestion', 'praise']) expect(shown).toContain(label);
  expect(shown).toContain('src/recipes/import.ts:88');
  expect(shown).toContain('src/recipes/import.ts:120');
  expect(shown).toContain('src/recipes/list.ts:14');
  expect(shown).toContain('A recipe file with no ingredients throws');
  expect(shown).toContain('The list reads in one pass');
});

it('gives every finding its own copy button', () => {
  expect(draw().match(/data-copy="\d+"/g)).toHaveLength(3);
});

it('draws the decoration a block carries', () => {
  expect(text(draw())).toContain('src/recipes/import.ts:120 non-blocking');
});

// The label is a word on the screen and the colour repeats it, so a reader who cannot tell the
// colours apart still reads the label.
it('names each label in words and not by colour alone', () => {
  expect(draw()).toContain('data-label="issue"');
  expect(text(draw())).toMatch(/issue/);
});

it('says where the review stands, and never who approved', () => {
  const shown = text(draw({ reviewer: { decision: 'APPROVED', author: 'dana', draft: true } }));

  expect(shown).toContain('Approved');
  expect(shown).toContain('Draft');
  expect(shown).toContain('By dana');
  expect(shown).toContain('1 round');
});

it('says a field the pull request answer did not carry rather than drawing nothing', () => {
  const shown = text(draw({ reviewer: { decision: null, author: null, draft: false } }));

  expect(shown).toContain('Review decision unknown');
  expect(shown).toContain('Author unknown');
});

// The refusal reaching the screen. The bad block is named, and no part of the round is drawn as a
// finding, which is the whole point of the rule.
it('shows the refusal instead of the round, and draws no finding', () => {
  const found = parseRound(`Looks fine to me.\n\n${THREE}`);
  expect(found.ok).toBe(false);
  const problem = found.ok ? '' : found.problem;

  const html = draw({ blocks: [], problem });
  const shown = text(html);

  expect(shown).toContain('Looks fine to me.');
  expect(shown).toContain('which is not a location');
  expect(html).not.toContain('data-finding');
  expect(shown).not.toContain('A recipe file with no ingredients throws');
});

it('says where the file itself can be read when the round is refused', () => {
  expect(text(draw({ blocks: [], problem: 'The block starting "x" carries no label.' }))).toContain('Files tab');
});

// A card with no round file yet draws no empty frame and no selector.
it('says there is no round yet rather than drawing an empty list', () => {
  const html = draw({ rounds: [], current: null, blocks: [] });

  expect(text(html)).toContain('No review round yet');
  expect(html).not.toContain('data-finding');
  expect(html).not.toContain('data-round');
});

it('shows no round selector while there is one round', () => {
  expect(draw()).not.toContain('data-round');
});

it('shows a selector of both rounds, with the shown one named, once there are two', () => {
  const html = draw({ rounds: [{ number: 1 }, { number: 2 }], current: 2 });
  const shown = text(html);

  expect(html).toContain('data-round');
  expect(shown).toContain('Round 1');
  expect(shown).toContain('Round 2');
  expect(shown).toContain('2 rounds');
  expect(html).toContain('href="?round=1"');
  // Said by aria-current as well, so the shown round is not a border alone.
  expect(html).toMatch(/href="\?round=2"[^>]*aria-current="page"|aria-current="page"[^>]*href="\?round=2"/);
});

it('says a block names no file rather than drawing an empty slot', () => {
  expect(text(draw({ blocks: blocksOf('question:\nThe import runs twice on a retry. Is that on purpose?\n') }))).toContain('No file named');
});

// The second round of a card, against the first. The empty file was fixed, the double read is still
// there under another line number, and the second round found one new small thing.
const SECOND = `suggestion: src/recipes/import.ts:96
Two reads of one file are still two reads. Parse once and hand the recipe down.

nitpick: src/recipes/import.ts:30
Call the flag skipEmpty. Its name says nothing today.
`;

// The third round: the nitpick is fixed, the double read is still there, and one question is new.
const THIRD = `question: src/db/schema.sql:12
The new index is only in the schema file. Does it need a migration?

suggestion: src/recipes/import.ts:97
The import still reads each file twice.
`;

const read = [
  { number: 1, blocks: blocksOf(THREE) },
  { number: 2, blocks: blocksOf(SECOND) },
  { number: 3, blocks: blocksOf(THIRD) },
];
const rounds = {
  rounds: [
    { number: 1, file: 'pr-review/round.md' },
    { number: 2, file: 'pr-review/round-2.md' },
  ],
  current: 2,
  blocks: blocksOf(SECOND),
  read: read.slice(0, 2),
};

// The word has to sit on the finding it belongs to. Round two carries the double read from round one
// and one nitpick nobody wrote before, in that order, so the two words are pinned in that order and a
// list read the wrong way round fails here.
it('says of every finding whether it is new in this round or open since an earlier one', () => {
  const html = draw(rounds);

  expect(html.match(/data-change="(?:new|open)"/g)).toEqual(['data-change="open"', 'data-change="new"']);
  expect(text(html)).toContain('open since round 1');
  expect(text(html)).toContain('new in round 2');
});

// The attribute and the word are one signal, and the word is the whole of it for a reader who cannot
// tell the colours apart. Swapping the two words leaves the attributes right and the screen wrong.
it('reads the word of each finding out of the attribute beside it', () => {
  const html = draw(rounds);

  expect(html).toMatch(/data-change="open"[^>]*>open since round 1</);
  expect(html).toMatch(/data-change="new"[^>]*>new in round 2</);
});

// Across all rounds, not the round before alone: the double read is from round one, though round two
// carried it in between.
it('names the round that first raised a finding, over three rounds', () => {
  const html = draw({ ...rounds, rounds: [...rounds.rounds, { number: 3, file: 'pr-review/round-3.md' }], current: 3, blocks: blocksOf(THIRD), read });

  const marks = [...html.matchAll(/data-change="(new|open)"[^>]*>([^<]*)</g)].map((mark) => `${mark[1] ?? ''}: ${mark[2] ?? ''}`);

  expect(marks).toEqual(['new: new in round 3', 'open: open since round 1']);
});

// The point of the comparison: a person reading round two wants to know what the author fixed.
it('folds the fixed findings into one line, and names them when it opens', () => {
  const html = draw(rounds);
  const shown = text(html);

  expect(html).toContain('data-gone');
  expect(html).toMatch(/<details[^>]*data-gone/);
  expect(html).toMatch(/<summary[^>]*>[\s\S]*1 finding from round 1 is fixed[\s\S]*<\/summary>/);
  expect(shown).toContain('A recipe file with no ingredients throws');
  expect(shown).toContain('src/recipes/import.ts:88 fixed in round 2');
});

it('counts the fixed findings of every earlier round in the one line', () => {
  const html = draw({ ...rounds, current: 3, blocks: blocksOf(THIRD), read });

  expect(text(html)).toContain('2 findings from earlier rounds are fixed');
  expect(text(html)).toContain('src/recipes/import.ts:30 fixed in round 3');
});

// A round that repeats every finding of the round before has nothing fixed, and a line over an empty
// list reads as a review that lost something.
it('draws no fixed line when the round repeats every finding', () => {
  const html = draw({ ...rounds, blocks: blocksOf(THREE), read: [{ number: 1, blocks: blocksOf(THREE) }, { number: 2, blocks: blocksOf(THREE) }] });

  expect(html).not.toContain('data-gone');
  expect(text(html)).not.toContain('is fixed');
  expect(text(html)).not.toContain('are fixed');
});

it('says nothing about what changed on a first round', () => {
  const html = draw();

  expect(html).not.toContain('data-gone');
  expect(html).not.toContain('data-change=');
  expect(text(html)).not.toContain('new in round 1');
});

// A round before that could not be read is not in the list, and with nothing left to compare there
// is no comparison: every finding would read as new.
it('compares with nothing when no round before the shown one could be read', () => {
  const html = draw({ ...rounds, read: read.slice(1, 2) });

  expect(html).not.toContain('data-change=');
  expect(html).not.toContain('data-gone');
});

// A refused round draws the refusal and nothing else, so no comparison is drawn either. The blocks
// are empty there, and a comparison would call every finding of the round before fixed.
it('draws the refusal alone, with no comparison, when the round cannot be read', () => {
  const html = draw({ ...rounds, blocks: [], problem: 'The block starting "x" carries no label.' });

  expect(html).toContain('data-problem');
  expect(html).not.toContain('data-gone');
  expect(html).not.toContain('data-change=');
});

it('counts the findings of each round in the round selector', () => {
  const html = draw(rounds).replace(/<!--[^>]*-->/g, '');

  expect(html).toMatch(/href="\?round=1"[^>]*>Round 1<span[^>]*>3<\/span>/);
  expect(html).toMatch(/href="\?round=2"[^>]*>Round 2<span[^>]*>2<\/span>/);
});

// Read as text, the round and its count run together: "Round 1" and 3 would be "Round 13".
it('names each round link with its count of findings in words', () => {
  const html = draw({ ...rounds, read: [{ number: 1, blocks: blocksOf(THREE) }, { number: 2, blocks: blocksOf(SECOND).slice(0, 1) }] });

  expect(html).toMatch(/aria-label="Round 1, 3 findings"[^>]*href="\?round=1"/);
  expect(html).toMatch(/aria-label="Round 2, 1 finding"[^>]*href="\?round=2"/);
});

it('names the round file and links the Files tab, where it is too', () => {
  const html = draw({ ...rounds, filesHref: '/t/recipes%2342/files' });

  expect(text(html)).toContain('Round file pr-review/round-2.md , also on the Files tab .');
  expect(html).toContain('href="/t/recipes%2342/files"');
});

it('shows the head the round read, in mono, when a review saved one', () => {
  expect(draw({ head: '9b41c07' })).toMatch(/class="mono[^"]*" data-head="">head 9b41c07</);
  expect(draw()).not.toContain('data-head');
});

// The next round starts an agent, so it is the decision panel's one amber button beside the tab, and
// the tab itself moves nothing.
it('draws no move and nothing amber', () => {
  const html = draw(rounds);

  expect(html).not.toMatch(/class="[^"]*\bgo\b/);
  expect(html).not.toContain('data-rereview');
  expect(html).not.toContain('data-send-to-author');
});

it('shows a hard-wrapped finding as one flowing paragraph, and keeps a code fence as written', () => {
  const wrapped = blocksOf('issue: a.ts:1\nFirst line of the finding\ncontinues here.\n');
  expect(draw({ blocks: wrapped, read: [{ number: 1, blocks: wrapped }] })).toContain('First line of the finding continues here.');
  const fenced = blocksOf('issue: a.ts:1\nCall it like this\n```\nscale(2)\n```\n');
  expect(draw({ blocks: fenced, read: [{ number: 1, blocks: fenced }] })).toContain('Call it like this\n```\nscale(2)');
});

it('says "open since" for a carried finding and never for carried praise', () => {
  const one = blocksOf('suggestion: a.ts:1\nKeep it short.\n\npraise: b.ts:2\nNice.\n');
  const shown = text(draw({ rounds: [{ number: 1 }, { number: 2 }], current: 2, blocks: one, read: [{ number: 1, blocks: one }, { number: 2, blocks: one }] }));
  expect(shown).toContain('open since round 1');
  expect(shown.match(/open since round 1/g)).toHaveLength(1);
});
