import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ageWord, blockPlace, conventionalComments, diffRounds, fixedLine, isBlocking, normaliseRound, parseRound, rereviewWhy, type ReviewBlock, ROUND_LABELS } from './review.ts';

// The blocks written back out as a file. It lives here and not in `review.ts`, because nothing in the
// app writes a round file: the copy button hands over one block's own text. Here it is the inverse of
// the parser, and the round trip is what proves the blocks cover the whole file with nothing dropped
// and nothing added.
const roundText = (blocks: readonly ReviewBlock[]): string =>
  blocks.length === 0 ? '' : `${blocks.map((block) => block.text).join('\n\n')}\n`;

// A round of three findings, the way the skill asks for it: one block per finding, one blank line
// between two blocks, no blank line inside a block. The second body runs over two lines and the
// third block carries a decoration from the published format.
const THREE = `issue: src/recipes/import.ts:88
A recipe file with no ingredients throws, so one bad file stops the whole import. Return an
empty list here and let the caller name the file it came from.

suggestion: src/recipes/import.ts:120
The two loops read the same file twice, once for the name and once for the steps. Read it once
and pass the parsed recipe down, which also drops the second error path.

nitpick (non-blocking): src/recipes/list.ts:14
The name \`res\` says nothing about what the list holds. Call it \`recipes\`.
`;

const read = (text: string) => {
  const found = parseRound(text);
  if (!found.ok) throw new Error(`expected a round, got: ${found.problem}`);
  return found.blocks;
};

const refused = (text: string): string => {
  const found = parseRound(text);
  if (found.ok) throw new Error(`expected a refusal, got ${found.blocks.length} blocks`);
  return found.problem;
};

describe('parseRound', () => {
  it('reads one block per finding, with its label, its file and its line', () => {
    const blocks = read(THREE);

    expect(blocks.map((block) => block.label)).toEqual(['issue', 'suggestion', 'nitpick']);
    expect(blocks.map((block) => block.path)).toEqual(['src/recipes/import.ts', 'src/recipes/import.ts', 'src/recipes/list.ts']);
    expect(blocks.map((block) => block.line)).toEqual([88, 120, 14]);
  });

  it('keeps the problem and the fix as the block body, over as many lines as it holds', () => {
    expect(read(THREE)[1]?.body).toBe(
      'The two loops read the same file twice, once for the name and once for the steps. Read it once\nand pass the parsed recipe down, which also drops the second error path.',
    );
  });

  // The published format allows a decoration between the label and the colon. The skill offers none,
  // so this is tolerance for a legal conventional comment rather than a second shape.
  it('keeps a decoration the published format allows', () => {
    const blocks = read(THREE);

    expect(blocks[2]?.decoration).toBe('non-blocking');
    expect(blocks[2]?.label).toBe('nitpick');
    expect(blocks[0]?.decoration).toBeNull();
  });

  // The whole point of the round file: a person selects one block and pastes it into the pull
  // request. So each block carries its own text exactly as the file holds it.
  it('carries each block as the text the file holds, so the block can be pasted unchanged', () => {
    expect(read(THREE)[0]?.text).toBe(
      'issue: src/recipes/import.ts:88\nA recipe file with no ingredients throws, so one bad file stops the whole import. Return an\nempty list here and let the caller name the file it came from.',
    );
  });

  // Empty brackets are not a decoration. The page draws the brackets it is given, so `''` here puts a
  // bare pair of them between the label and the path.
  it('reads empty brackets as no decoration at all', () => {
    expect(read('suggestion (): src/a.ts:1\nRead the file once.\n')[0]?.decoration).toBeNull();
    expect(read('suggestion (non-blocking): src/a.ts:1\nRead the file once.\n')[0]?.decoration).toBe('non-blocking');
  });

  // The round trip the plan asks for: blocks back into the file they came from.
  it('writes the blocks back into the file they were read from', () => {
    expect(roundText(read(THREE))).toBe(normaliseRound(THREE));
    expect(roundText(read(THREE))).toBe(THREE);
  });

  it('writes a round of one block back without a trailing blank line', () => {
    const one = 'praise: src/recipes/list.ts:14\nThe round found nothing to change. The new list reads in one pass and names its own errors.\n';

    expect(roundText(read(one))).toBe(one);
  });

  // A file written on another machine must not turn every block into a malformed one, so the text is
  // normalised first and the round trip is measured against the normalised text.
  it('reads a file whose lines end with CRLF', () => {
    const blocks = read(THREE.replaceAll('\n', '\r\n'));

    expect(blocks).toHaveLength(3);
    expect(roundText(blocks)).toBe(THREE);
  });

  // Two blank lines still separate two blocks and nothing else. A run that wrote one extra newline
  // has still written two findings.
  it('reads three blocks through more than one blank line', () => {
    expect(read(THREE.replace('\n\nsuggestion:', '\n\n\n\nsuggestion:'))).toHaveLength(3);
  });

  // One newline more than a separator, which is the mistake a run actually makes. Refused, the whole
  // round is refused with it and the sentence quotes the empty line it stopped on.
  it('reads three blocks through one extra newline', () => {
    expect(read(THREE.replace('\n\nsuggestion:', '\n\n\nsuggestion:'))).toHaveLength(3);
  });

  // The case a naive blank-line split gets wrong in the other direction. This line is inside a body,
  // not the start of a block, so it stays in the body and comes back out in the round trip.
  it('leaves a line that looks like another block inside the body it sits in', () => {
    const tricky = `issue: src/recipes/import.ts:88
One bad file stops the whole import. The line below is what the round would have said about it:
suggestion: src/recipes/import.ts:120 is the caller, and it swallows the error.
`;
    const blocks = read(tricky);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.body).toContain('suggestion: src/recipes/import.ts:120 is the caller');
    expect(roundText(blocks)).toBe(tricky);
  });

  // A praise block that names no fix is a finished review, which the skill says in as many words.
  it('reads a praise block that names no fix', () => {
    const blocks = read('praise: src/recipes/list.ts:14\nThe round found nothing to change.\n');

    expect(blocks[0]?.label).toBe('praise');
    expect(blocks[0]?.body).toBe('The round found nothing to change.');
  });

  // A label with nothing after it is still a labelled finding, which is the one thing the rule is
  // about. The page draws that it names no file rather than an empty slot.
  it('reads a block that carries a label and names no file', () => {
    const blocks = read('question:\nThe import runs twice on a retry. Is that on purpose?\n');

    expect(blocks[0]?.label).toBe('question');
    expect(blocks[0]?.path).toBeNull();
    expect(blocks[0]?.line).toBeNull();
  });

  // The line number is the last `:digits` of the subject and nothing may follow it. Read from a
  // subject that carries words after the number, those words are dropped and a person sees nowhere
  // what the round wrote.
  it('keeps the words a subject carries after the line number', () => {
    expect(read('issue: src/a.ts:88 and its caller\nThe caller swallows the error.\n')[0]).toMatchObject({
      path: 'src/a.ts:88 and its caller',
      line: null,
    });
  });

  it('reads a subject that names a file and no line', () => {
    expect(read('issue: src/recipes/import.ts\nThe file has no test. Add one for an empty recipe.\n')[0]).toMatchObject({
      path: 'src/recipes/import.ts',
      line: null,
    });
  });

  it('reads a very long subject and a subject that is not ASCII', () => {
    const long = `nested/${'folder/'.repeat(40)}import.ts`;
    const blocks = read(`issue: ${long}:9\nThe path is long. Shorten the folders.\n\nsuggestion: src/recipes/hűtő.ts:3\nThe name is not the one the diff uses. Rename it to the diff's spelling.\n`);

    expect(blocks[0]?.path).toBe(long);
    expect(blocks[0]?.line).toBe(9);
    expect(blocks[1]?.path).toBe('src/recipes/hűtő.ts');
    expect(blocks[1]?.line).toBe(3);
  });
});

// The sharp edge of this tab. A block with no label is refused, and the refusal takes the whole
// round with it: a chunk with no label is also what a stray blank line inside a body looks like, so
// showing the good blocks beside it would print half a finding as a whole one.
describe('a block with no label', () => {
  const STRAY = `Looks fine to me.

issue: src/recipes/import.ts:88
One bad file stops the whole import. Return an empty list here.
`;

  it('is refused rather than shown unlabelled', () => {
    const found = parseRound(STRAY);

    expect(found.ok).toBe(false);
    expect(found).not.toHaveProperty('blocks');
  });

  it('names the block it refused and says what a block must start with', () => {
    const problem = refused(STRAY);

    expect(problem).toContain('"Looks fine to me."');
    expect(problem).toContain('its file and line on a line of its own');
  });

  // Nothing unlabelled reaches the output, and neither does the finding that stood beside it.
  it('lets no part of the file through', () => {
    const found = parseRound(STRAY);

    expect(JSON.stringify(found)).not.toContain('One bad file stops the whole import');
  });

  it('refuses a heading written above the first block the same way', () => {
    expect(refused(`# Round 1\n\nissue: src/recipes/import.ts:88\nOne bad file stops the whole import.\n`)).toContain('"# Round 1"');
  });

  it('refuses a block whose label is not one of the nine, and lists the nine', () => {
    const problem = refused('fixme: src/recipes/import.ts:88\nRewrite the loop before this merges.\n');

    expect(problem).toContain('fixme');
    expect(problem).toContain('praise, nitpick, suggestion, issue, todo, question, thought, chore, note');
  });

  // Two mistakes at once. The sentence has to name the label the round file may not use, and say the
  // block is indented as well, or a person fixes one of the two and gets refused again.
  it('names both problems when a block outside the nine is indented as well', () => {
    const problem = refused('  fixme: src/recipes/import.ts:88\nRewrite the loop before this merges.\n');

    expect(problem).toContain('fixme');
    expect(problem).toContain('left margin');
    expect(problem).not.toContain('carries no label');
    // The label alone in the quotes, and not the whole line: a sentence that names the path and the
    // line number as the label tells a person nothing they can fix.
    expect(problem).toContain('the label "fixme"');
  });

  it('refuses an indented block and says to move it to the left margin', () => {
    const problem = refused('  issue: src/recipes/import.ts:88\nOne bad file stops the whole import.\n');

    expect(problem).toContain('indented');
    expect(problem).toContain('left margin');
    // Its own sentence, and not the one above it. `issue` is a label a round file may use, so a
    // refusal that listed it as one it may not use would refuse and allow the same word in one breath.
    expect(problem).not.toContain('may not use');
  });

  it('refuses a file with nothing in it', () => {
    for (const text of ['', '   \n\n\t\n']) {
      const problem = refused(text);
      expect(problem).toContain('empty');
      expect(problem).toContain('praise block');
    }
  });

  // A long first line is quoted short, so the sentence stays readable on the screen that shows it.
  it('quotes a long first line short', () => {
    const problem = refused(`${'word '.repeat(60)}\n`);

    expect(problem).toContain('...');
    expect(problem.length).toBeLessThan(400);
  });
});

// A decoration is not a status this page acts on, so an unknown one is not a reason to refuse a
// block that carries its label plainly. It comes back out in the round trip either way.
it('keeps a decoration the published format does not define', () => {
  const text = 'suggestion (needs-a-word): src/recipes/list.ts:14\nThe name says nothing. Call it recipes.\n';
  const blocks = read(text);

  expect(blocks[0]?.decoration).toBe('needs-a-word');
  expect(roundText(blocks)).toBe(text);
});

// The skill and the parser are one pair. A label renamed in one and not in the other would make
// every round file unreadable, and nothing else in the suite would say so.
it('reads the nine labels the skill asks the run to write', () => {
  const skill = readFileSync(join(import.meta.dirname, '..', '..', '..', 'skills', 'skills', 'nolzu-pr-review', 'SKILL.md'), 'utf8');

  for (const label of ROUND_LABELS) expect(skill, label).toContain(`- \`${label}\``);
  expect(ROUND_LABELS).toEqual(['praise', 'nitpick', 'suggestion', 'issue', 'todo', 'question', 'thought', 'chore', 'note']);
});

// The shape the skill writes now: the place on a line of its own, then the conventional comment, a
// blank line and the discussion, which may hold blank lines of its own.
describe('a round with location lines', () => {
  const ROUND = `src/recipes/import.ts:88-92
issue (blocking): An empty recipe file stops the whole import

A file with no ingredients throws, so one bad file stops every other one.

Return an empty list here and let the caller name the file.

src/recipes/list.ts:14
praise: The list reads in one pass
`;
  // The file back from its blocks: each comment under its place.
  const back = (blocks: readonly ReviewBlock[]) => `${blocks.map((block) => `${blockPlace(block) ?? ''}\n${block.text}`).join('\n\n')}\n`;

  it('reads each block with its place, a range, its label, decoration, subject and discussion', () => {
    const [issue, praise] = read(ROUND);

    expect(issue).toMatchObject({ label: 'issue', decoration: 'blocking', subject: 'An empty recipe file stops the whole import', path: 'src/recipes/import.ts', line: 88, end: 92 });
    expect(issue?.body).toBe('A file with no ingredients throws, so one bad file stops every other one.\n\nReturn an empty list here and let the caller name the file.');
    expect(praise).toMatchObject({ label: 'praise', decoration: null, subject: 'The list reads in one pass', line: 14, end: null, body: '' });
    expect(back(read(ROUND))).toBe(ROUND);
  });

  // One block pasted into the pull request is the comment alone; the place is where it goes, not what it says.
  it('carries the comment without its place, and the whole round with each place above its comment', () => {
    const blocks = read(ROUND);

    expect(blocks[0]?.text).toBe('issue (blocking): An empty recipe file stops the whole import\n\nA file with no ingredients throws, so one bad file stops every other one.\n\nReturn an empty list here and let the caller name the file.');
    expect(conventionalComments(blocks)).toBe(ROUND.trimEnd());
    expect(blockPlace(blocks[0]!)).toBe('src/recipes/import.ts:88-92');
  });

  it('reads every one of the nine labels and the three decorations', () => {
    const text = ROUND_LABELS.map((label, at) => `src/a.ts:${at + 1}\n${label}${at < 3 ? ` (${['blocking', 'non-blocking', 'if-minor'][at]})` : ''}: Subject ${at + 1}\n\nWhy.`).join('\n\n');

    expect(read(text).map((block) => [block.label, block.decoration])).toEqual(ROUND_LABELS.map((label, at) => [label, at < 3 ? ['blocking', 'non-blocking', 'if-minor'][at] : null]));
  });

  it('refuses a comment with no place above it, which would read as part of the one before', () => {
    expect(refused(`${ROUND}\nsuggestion: Read the file once\n`)).toContain('has no location line above it');
  });

  it('refuses a comment with no subject, and a place over a label it may not use', () => {
    expect(refused('src/a.ts:3\nissue:\n\nWhy.\n')).toContain('has no subject');
    expect(refused('src/a.ts:3\nfixme: Rewrite it\n')).toContain('the label "fixme"');
    expect(refused('src/a.ts:3\nThe loop is slow.\n')).toContain('carries no label');
  });

  it('says which comments stand in the way of the merge', () => {
    const blocks = read(ROUND_LABELS.map((label) => `src/a.ts:1\n${label}: S\n`).join('\n') + '\nsrc/a.ts:2\nissue (non-blocking): S\n\nsrc/a.ts:3\nsuggestion (blocking): S\n');

    expect(blocks.filter(isBlocking).map((block) => `${block.label} ${block.decoration ?? ''}`.trim())).toEqual(['issue', 'todo', 'suggestion blocking']);
  });
});



describe('findings across every round', () => {
  const blocksOf = (text: string): ReviewBlock[] => {
    const found = parseRound(text);
    if (!found.ok) throw new Error(found.problem);
    return found.blocks;
  };

  const ROUND_ONE = blocksOf(`issue: src/recipes/import.ts:88
A recipe file with no ingredients throws, so one bad file stops the whole import.

suggestion: src/recipes/import.ts:120
The caller reads the same file twice. Read it once and pass the parsed recipe down.

praise: src/recipes/list.ts:14
The list reads in one pass.
`);

  // The author fixed the empty file and moved the code, and the review reworded what is left and
  // found one small new thing.
  const ROUND_TWO = blocksOf(`nitpick: src/recipes/import.ts:30
Call the flag skipEmpty. Its name says nothing today.

suggestion: src/recipes/import.ts:96
Two reads of one file are still two reads. Parse once and hand the recipe down.
`);

  // The nitpick is fixed, the double read is still there, and one question is new.
  const ROUND_THREE = blocksOf(`question: src/db/schema.sql:12
The new index is only in the schema file. Does it need a migration?

suggestion: src/recipes/import.ts:97
The import still reads each file twice.
`);

  const rounds = [
    { number: 1, blocks: ROUND_ONE },
    { number: 2, blocks: ROUND_TWO },
    { number: 3, blocks: ROUND_THREE },
  ];
  const named = (block: ReviewBlock) => `${block.label} ${block.path ?? ''}`;

  it('says of each finding of the newest round the round that raised it, over three rounds', () => {
    const diff = diffRounds(rounds);

    expect(diff.open.map((one) => `${named(one.block)} ${one.since}`)).toEqual(['question src/db/schema.sql 3', 'suggestion src/recipes/import.ts 1']);
  });

  it('names every finding a later round no longer raised, with the round that raised it and the round it went in', () => {
    const diff = diffRounds(rounds);

    expect(diff.fixed.map((one) => `${named(one.block)} ${one.since} ${one.fixedIn}`)).toEqual(['issue src/recipes/import.ts 1 2', 'nitpick src/recipes/import.ts 2 3']);
  });

  it('compares the round asked for with the rounds before it, and with none after it', () => {
    const diff = diffRounds(rounds.slice(0, 2));

    expect(diff.open.map((one) => `${named(one.block)} ${one.since}`)).toEqual(['nitpick src/recipes/import.ts 2', 'suggestion src/recipes/import.ts 1']);
    expect(diff.fixed.map((one) => named(one.block))).toEqual(['issue src/recipes/import.ts']);
  });

  // Praise is no finding to fix, so a round that does not repeat it fixed nothing.
  it('calls no praise fixed', () => {
    expect(diffRounds(rounds).fixed.map((one) => one.block.label)).not.toContain('praise');
  });

  it('calls every finding of a first round new in it, and nothing fixed', () => {
    const diff = diffRounds([{ number: 1, blocks: ROUND_ONE }]);

    expect(diff.open.map((one) => one.since)).toEqual([1, 1, 1]);
    expect(diff.fixed).toEqual([]);
  });

  // The author edits the file between two rounds, so every line below the edit moves, and the second
  // round rewords what it found. Neither makes it another finding.
  it('reads past a line that moved and wording that changed', () => {
    const diff = diffRounds([
      { number: 1, blocks: blocksOf('issue: src/a.ts:10\nThe list is read twice.\n') },
      { number: 2, blocks: blocksOf('issue: src/a.ts:41\nThis still reads the list twice. Read it once.\n') },
    ]);

    expect(diff.open.map((one) => one.since)).toEqual([1]);
    expect(diff.fixed).toEqual([]);
  });

  // Two findings of one label in one file: the nearest line is the same finding, wherever the round
  // wrote it in its list.
  it('pairs two findings of one label in one file by the nearest line, not by their place in the list', () => {
    const before = { number: 1, blocks: blocksOf('issue: src/a.ts:10\nFirst.\n\nissue: src/a.ts:80\nSecond.\n') };

    const dropped = diffRounds([before, { number: 2, blocks: blocksOf('issue: src/a.ts:78\nOnly the second is left.\n') }]);
    expect(dropped.fixed.map((one) => one.block.body)).toEqual(['First.']);

    const swapped = diffRounds([before, { number: 2, blocks: blocksOf('issue: src/a.ts:83\nThe second.\n\nissue: src/a.ts:12\nThe first.\n') }]);
    expect(swapped.open.map((one) => one.since)).toEqual([1, 1]);
    expect(swapped.fixed).toEqual([]);
  });

  // Paired by the label alone, a finding raised in another file reads as the old one still there,
  // and the one the author fixed is never named fixed.
  it('tells two findings of one label in two files apart', () => {
    const diff = diffRounds([
      { number: 1, blocks: blocksOf('issue: src/a.ts:10\nThe list is read twice.\n') },
      { number: 2, blocks: blocksOf('issue: src/b.ts:10\nThe caller swallows the error.\n') },
    ]);

    expect(diff.open.map((one) => one.since)).toEqual([2]);
    expect(diff.fixed.map((one) => one.block.path)).toEqual(['src/a.ts']);
  });

  it('tells two findings of two labels on one line apart', () => {
    const diff = diffRounds([
      { number: 1, blocks: blocksOf('issue: src/a.ts:10\nThe list is read twice.\n') },
      { number: 2, blocks: blocksOf('nitpick: src/a.ts:10\nName the list.\n') },
    ]);

    expect(diff.open.map((one) => one.since)).toEqual([2]);
    expect(diff.fixed.map((one) => one.block.label)).toEqual(['issue']);
  });

  // A block whose label stands alone names no file, and two of those are still one finding.
  it('compares a block that names no file by its label', () => {
    const diff = diffRounds([
      { number: 1, blocks: blocksOf('question:\nDoes the import run twice on a retry?\n') },
      { number: 2, blocks: blocksOf('question:\nIs the retry still running the import twice?\n') },
    ]);

    expect(diff.open.map((one) => one.since)).toEqual([1]);
  });

  it('says beside a finding whether it is new in the round or open since an earlier one', () => {
    const [question, suggestion] = diffRounds(rounds).open;

    expect(ageWord(question!, 3)).toBe('new in round 3');
    expect(ageWord(suggestion!, 3)).toBe('open since round 1');
  });

  it('folds the fixed findings into one line that names the round they came from', () => {
    const fixed = diffRounds(rounds).fixed;

    expect(fixedLine(fixed)).toBe('2 findings from earlier rounds are fixed');
    expect(fixedLine(fixed.slice(0, 1))).toBe('1 finding from round 1 is fixed');
    expect(fixedLine([...fixed.slice(0, 1), { ...fixed[0]!, fixedIn: 3 }, { ...fixed[0]!, fixedIn: 3 }])).toBe('3 findings from round 1 are fixed');
  });
});

// Copy all findings: the text a person pastes into the pull request on GitHub.
// Nolzu posts nothing.
describe('the round as conventional comments', () => {
  const copied = conventionalComments(read(THREE));

  it('starts each finding with its label, its decoration, and its file and line', () => {
    const heads = copied.split('\n\n').map((block) => block.split('\n')[0]);

    expect(heads).toEqual(['issue: src/recipes/import.ts:88', 'suggestion: src/recipes/import.ts:120', 'nitpick (non-blocking): src/recipes/list.ts:14']);
  });

  it('keeps every finding whole, one blank line between two', () => {
    expect(copied).toBe(normaliseRound(THREE).trimEnd());
  });

  it('reads back as the same findings', () => {
    expect(read(copied).map((block) => `${block.label} ${block.path ?? ''}:${block.line ?? ''}`)).toEqual(read(THREE).map((block) => `${block.label} ${block.path ?? ''}:${block.line ?? ''}`));
  });

  it('copies nothing for a round with no finding', () => {
    expect(conventionalComments([])).toBe('');
  });
});

// The decision panel's line on why another round makes sense.
describe('why another round makes sense', () => {
  it('names the new commits and who pushed them', () => {
    expect(rereviewWhy({ author: 'dana', round: 2, pushed: 1, open: 0 })).toBe('dana pushed 1 commit after round 2.');
    expect(rereviewWhy({ author: null, round: 2, pushed: 3, open: 0 })).toBe('The author pushed 3 commits after round 2.');
  });

  it('names the findings the round left open', () => {
    expect(rereviewWhy({ author: 'dana', round: 2, pushed: 1, open: 3 })).toBe('dana pushed 1 commit after round 2. 3 findings from round 2 are still open.');
    expect(rereviewWhy({ author: 'dana', round: 1, pushed: null, open: 1 })).toBe('1 finding from round 1 is still open.');
  });

  it('says when nothing was pushed since the round, so another round reads the same code', () => {
    expect(rereviewWhy({ author: 'dana', round: 2, pushed: 0, open: 0 })).toBe('The last Read pull requests saw no push after round 2. Another round would read the same code.');
  });

  it('says nothing before the first round, or when nothing is known', () => {
    expect(rereviewWhy({ author: 'dana', round: null, pushed: 1, open: 2 })).toBeNull();
    expect(rereviewWhy({ author: 'dana', round: 2, pushed: null, open: 0 })).toBeNull();
  });
});
