import { readFileSync } from 'node:fs';
import { type CardState, type CardView, type RunActivity } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import BoardCard from './BoardCard.svelte';
import { cardFixture } from './fixture.ts';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const STATES: CardState[] = ['idle', 'queued', 'running', 'ready', 'blocked', 'failed'];
// A fixed clock, so the elapsed line is the same on every machine and in every run.
const NOW = new Date('2026-09-16T10:01:30.000Z');
const STARTED = '2026-09-16T10:00:00.000Z';

// The meta row alone, so an order or a word in it is checked there and not anywhere on the card.
const meta = (body: string): string => /<p class="meta[^>]*>([\s\S]*?)<\/p>/.exec(body)?.[1] ?? '';
// The first row, the key and the state pill.
const head = (body: string): string => /<header[^>]*>([\s\S]*?)<\/header>/.exec(body)?.[1] ?? '';
const source = (): string => readFileSync(new URL('./BoardCard.svelte', import.meta.url), 'utf8');

const draw = (over: Parameters<typeof cardFixture>[0]): string =>
  render(BoardCard, { props: { card: cardFixture(over), now: NOW } }).body;

it('shows the key and the title', () => {
  const body = draw({ key: 'APP-1' });

  expect(body).toContain('data-card="APP-1"');
  expect(text(body)).toContain('APP-1');
  expect(text(body)).toContain('Add a search box to the recipe list');
});

it('shows Idle and no cost on a card that has not run', () => {
  const body = draw({ key: 'APP-1', state: 'idle' });

  expect(text(body)).toContain('Idle');
  expect(body).not.toContain('$');
});

it('shows the queue position while queued', () => {
  const body = draw({ key: 'APP-1', state: 'queued', queuePosition: 2 });

  // The place follows the word: "Queued 1st".
  expect(text(body)).toContain('Queued 2nd');
});

// The run time sits inside the pill, "0m 40s", so the meta row no longer wraps.
it('holds the run time in the pill and leaves it out of the meta row', () => {
  const body = draw({ key: 'APP-1', state: 'running', runStartedAt: STARTED, model: 'sonnet', effort: 'high' });

  // The word stays for a screen reader, out of sight, and the time is what the pill shows.
  expect(text(head(body))).toBe('APP-1 Running 1m 30s');
  expect(head(body)).toContain('data-detail-only="true"');
  expect(text(meta(body))).not.toContain('1m 30s');
  expect(text(meta(body))).toBe('sonnet high effort');
});

it('shows Ready when the run is done', () => {
  expect(text(draw({ key: 'APP-1', state: 'ready' }))).toContain('Ready');
});

it('shows the question and an Answer control while blocked', () => {
  const body = draw({ key: 'APP-1', state: 'blocked', question: 'Which index name should it use?' });

  expect(text(body)).toContain('Which index name should it use?');
  expect(text(body)).toContain('Answer');
});

it('renders a question that holds markup as text and never as markup', () => {
  const body = draw({ key: 'APP-1', state: 'blocked', question: 'Which index? <b>bold</b>' });

  expect(body).not.toContain('<b>');
  expect(text(body)).toContain('Which index?');
});

it('shows the failure reason it was given, word for word', () => {
  const body = draw({ key: 'APP-1', state: 'failed', failureReason: 'The base branch main is not in this repository.' });

  expect(text(body)).toContain('The base branch main is not in this repository.');
});

it('keeps the whole reason in the title, although the line is clamped', () => {
  const reason = 'x'.repeat(400);
  const body = draw({ key: 'APP-1', state: 'failed', failureReason: reason });

  expect(body).toContain(`title="${reason}"`);
});

it.each(STATES)('gives the %s state a word beside the dot', (state) => {
  const body = draw({ key: 'APP-1', state });

  // Status is never colour alone, so every state reads as a word too.
  expect(text(body)).toMatch(/Idle|Queued|Running|Ready|Asks you|Failed/);
  expect(body).toContain(`data-state="${state}"`);
});

it('never says Something went wrong', () => {
  for (const state of STATES) {
    expect(text(draw({ key: 'APP-1', state, failureReason: 'git refused the push.' }))).not.toContain('Something went wrong');
  }
});

it('writes the meta row in order: model, effort, cost', () => {
  const running = draw({ key: 'APP-1', state: 'running', runStartedAt: STARTED, engine: 'claude', model: 'opus', effort: 'high' });
  const ready = draw({ key: 'APP-1', state: 'ready', engine: 'claude', model: 'sonnet', effort: 'medium', totalUsd: 2.1 });

  expect(text(meta(running))).toBe('opus high effort');
  expect(text(meta(ready))).toBe('sonnet medium effort $2.10');
});

it('leaves the engine out of the meta row', () => {
  const body = draw({ key: 'APP-1', state: 'ready', engine: 'claude', model: 'sonnet' });

  expect(text(meta(body))).not.toContain('claude');
});

it('draws a minimized card as one line, with no state detail', () => {
  const body = draw({ key: 'APP-1', minimized: true, state: 'running', runStartedAt: STARTED });

  expect(body).toContain('data-minimized="true"');
  expect(text(body)).toContain('APP-1');
  expect(text(body)).not.toContain('1m 30s');
});

it('sets no colour literal, so the card cannot drift from the tokens', () => {
  const source = readFileSync(new URL('./BoardCard.svelte', import.meta.url), 'utf8');

  expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(source).not.toMatch(/oklch\(/);
});

it('shows the cost even when the engine and the model are not known', () => {
  // The cost sat inside the engine and model block, so a card that knew its cost hid it because
  // of two fields that have nothing to do with it.
  const body = draw({ key: 'APP-1', state: 'ready', totalUsd: 0.42 });

  expect(text(body)).toContain('0.42');
});

it('shows no cost on a card that has spent nothing', () => {
  expect(draw({ key: 'APP-1', state: 'idle', totalUsd: null, costUsd: 0.42, model: 'sonnet' })).not.toContain('$');
  expect(draw({ key: 'APP-1', state: 'ready', totalUsd: 0, costUsd: 0 })).not.toContain('$');
});

it('shows the card total and names the last run in the title', () => {
  const body = meta(draw({ key: 'APP-1', state: 'ready', totalUsd: 0.57, costUsd: 0.42 }));

  expect(text(body)).toBe('$0.57');
  expect(body).toContain('title="Total $0.57 · last run $0.42 (estimated)"');
  // A running run has reported nothing yet, so the title gives the total alone.
  expect(meta(draw({ key: 'APP-1', state: 'running', runStartedAt: STARTED, totalUsd: 0.57, costUsd: null }))).toContain('title="Total $0.57 (estimated)"');
  // The cost column has no check on it, so a last run figure that is no number is left out too.
  expect(meta(draw({ key: 'APP-1', state: 'ready', totalUsd: 0.57, costUsd: Number.NaN }))).toContain('title="Total $0.57 (estimated)"');
});

it('gives a minimized card its state word too', () => {
  // One line does not mean no state. A blocked card parked in the strip showed nothing at all.
  const body = draw({ key: 'APP-1', minimized: true, state: 'blocked', question: 'Which index name?' });

  expect(text(body)).toContain('Asks you');
});

it('shows no elapsed time when the run start cannot be read', () => {
  // A start that does not parse rendered as "for 0 s", which reads as a run that just began.
  const body = draw({ key: 'APP-1', state: 'running', runStartedAt: 'yesterday' });

  expect(text(body)).toContain('Running');
  expect(text(body)).not.toMatch(/\dm \d\ds/);
  expect(body).not.toContain('data-detail-only');
});

it.each(['idle', 'queued', 'running', 'ready', 'blocked', 'failed'] as const)('shows the total in %s', (state) => {
  // The total moves only when a run ends, so next to a live timer it does not read as counting up.
  const body = draw({ key: 'APP-1', state, question: 'Which index?', failureReason: 'git refused the push.', totalUsd: 0.42 });

  expect(text(body)).toContain('$0.42');
});

it('never rounds a cost that is not zero down to nothing', () => {
  // A run of a third of a cent is not a free run, and two decimals said it was.
  expect(text(draw({ key: 'APP-1', state: 'ready', totalUsd: 0.004 }))).toContain('under $0.01');
  expect(text(draw({ key: 'APP-1', state: 'ready', totalUsd: 0.42 }))).toContain('$0.42');
});

it('shows no elapsed time when no clock was passed in', () => {
  // A component rendered on its own used to memoise its own default clock and then freeze. No
  // figure is better than one that is wrong and never moves.
  const { body } = render(BoardCard, { props: { card: cardFixture({ key: 'APP-1', state: 'running', runStartedAt: STARTED }) } });

  expect(text(body)).toContain('Running');
  expect(text(meta(body))).toBe('');
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('shows no cost for the figure %p', (costUsd) => {
  // elapsed() already refuses a figure it cannot read. The cost is the money path, so it has to
  // be at least as careful.
  expect(draw({ key: 'APP-1', state: 'ready', totalUsd: costUsd })).not.toContain('$');
});

it('rounds a half cent up and not down', () => {
  // toFixed rounds the binary double, which always understates here, and this is money.
  expect(text(draw({ key: 'APP-1', state: 'ready', totalUsd: 2.675 }))).toContain('$2.68');
  expect(text(draw({ key: 'APP-1', state: 'ready', totalUsd: 1.005 }))).toContain('$1.01');
  expect(text(draw({ key: 'APP-1', state: 'ready', totalUsd: 0.42 }))).toContain('$0.42');
});

it('says the cost is an estimate', () => {
  // Assumption F: the cost appears when the run ends, labelled estimated value. It is not the
  // subscription bill and the card must not read as if it were.
  expect(draw({ key: 'APP-1', state: 'ready', totalUsd: 0.42 })).toMatch(/estimated/i);
});

it.each(['queued', 'running'] as const)('does not let a %s card be dragged, and says why', (state) => {
  const body = draw({ key: 'PROJ-123', state, queuePosition: 2, runStartedAt: STARTED });

  // A card that simply refuses to move with no reason reads as a broken page, so the state is in
  // the title as well as in the flag.
  expect(body).toContain('draggable="false"');
  expect(body).toContain('aria-disabled="true"');
  expect(body).toContain(`title="PROJ-123 is ${state}. It cannot move until its run ends."`);
});

it.each(['idle', 'ready', 'blocked', 'failed'] as const)('lets a %s card be dragged', (state) => {
  const body = draw({ key: 'PROJ-1', state });

  expect(body).toContain('draggable="true"');
  expect(body).not.toContain('aria-disabled="true"');
});

it('locks a minimized card in the strip too', () => {
  // The strip is where a person is most likely to be moving cards, so the lock has to reach it.
  const body = draw({ key: 'PROJ-123', state: 'queued', minimized: true });

  expect(body).toContain('draggable="false"');
  expect(body).toContain('aria-disabled="true"');
  // The reason and the name as well. Asserting only the two flags let the strip card lose both.
  expect(body).toContain('title="PROJ-123 is queued. It cannot move until its run ends."');
  expect(body).toContain('aria-label="PROJ-123"');
  expect(body).toContain('data-locked="true"');
});

it('names the card for assistive technology, because a group with no name is announced as nothing', () => {
  // The role is here because aria-disabled is not allowed on an article, and a role without a name
  // is the mistake the column already had to fix.
  expect(draw({ key: 'PROJ-7' })).toContain('aria-label="PROJ-7"');
});

it.each(['queued', 'running'] as const)('marks a %s card as locked, so the cursor can say it will not move', (state) => {
  expect(draw({ key: 'APP-1', state, queuePosition: 2, runStartedAt: STARTED })).toContain('data-locked="true"');
});

it('does not mark a card that can move as locked', () => {
  expect(draw({ key: 'APP-1', state: 'idle' })).not.toContain('data-locked');
});

it('draws the border in the state colour for the four states that need a look', () => {
  // Running, blocked, ready and failed get a ring. Idle and queued keep the plain line.
  const source = readFileSync(new URL('./BoardCard.svelte', import.meta.url), 'utf8');
  const ring = (state: string) => new RegExp(`\\.card\\[data-state='${state}'\\] \\{\\s*border-color: var\\(--([a-z]+)\\)`).exec(source)?.[1];

  expect([ring('running'), ring('blocked'), ring('ready'), ring('failed')]).toEqual(['amber', 'violet', 'green', 'red']);
  expect(ring('idle')).toBeUndefined();
  expect(ring('queued')).toBeUndefined();
});

// The shadow is the heavy one for parts that float. On every resting card it would weigh down the board.
it('draws no shadow on a card at rest', () => {
  const source = readFileSync(new URL('./BoardCard.svelte', import.meta.url), 'utf8');
  const card = /\n {2}\.card \{([^}]*)\}/.exec(source)?.[1];

  expect(card).toContain('background: var(--card)');
  expect(card).not.toContain('box-shadow');
});

it('shows only the dot on a minimized card and keeps the word for screen readers', () => {
  const body = draw({ key: 'APP-1', minimized: true, state: 'blocked' });

  expect(body).toContain('data-word-hidden="true"');
  expect(text(body)).toContain('Asks you');
  expect(draw({ key: 'APP-1', state: 'blocked' })).not.toContain('data-word-hidden');
});

// One model name can run on two engines, so the card names the engine before the model.
it('names the engine before the model, and the three in the title', () => {
  const body = draw({ key: 'APP-1', state: 'running', runStartedAt: STARTED, engine: 'cursor#work', model: 'sonnet', effort: 'high' });

  expect(text(meta(body))).toBe('Cursor sonnet high effort');
  expect(body).toContain('title="Cursor, sonnet, high effort"');
});

it('hides the words that name the effort and the timer from sight only', () => {
  const source = readFileSync(new URL('./BoardCard.svelte', import.meta.url), 'utf8');
  const rule = /\.hidden \{([^}]*)\}/.exec(source)?.[1] ?? '';
  expect(rule).toContain('position: absolute;');
  expect(rule).toContain('clip-path: inset(50%);');
});

it('links Answer to the composer on the ticket page, with the key encoded', () => {
  const body = draw({ key: 'APP 1', state: 'blocked', question: 'Which index name should it use?' });

  // The composer sits on the overview, so the answer is written there and not on the board.
  expect(body).toMatch(/<a[^>]*href="\/t\/APP%201\/overview#asks"[^>]*>Answer<\/a>/);
});

// A mouse and a screen reader in browse mode open the card by its title. The arrows reach the card
// itself, so the link is no second tab stop, and a drag still picks up the card and not the link.
it.each([false, true])('links the title to the card page, out of the tab order, minimized %s', (minimized) => {
  const body = draw({ key: 'APP 1', state: 'idle', title: 'Sort the list', minimized });
  const link = /<a[^>]*class="title[^"]*"[^>]*>Sort the list<\/a>/.exec(body)?.[0] ?? '';

  expect(link).toContain('href="/t/APP%201"');
  expect(link).toContain('tabindex="-1"');
  expect(link).toContain('draggable="false"');
});

// The card's chips hold the QA verdict, with a one-line reason. A FAIL
// draws the failed card instead, tested below.
it.each(['PASS', 'BLOCKED'] as const)('shows the %s verdict of the newest run on the card', (verdict) => {
  const body = draw({ key: 'APP-1', state: 'ready', verdict, verdictReason: 'An empty search shows no recipes.' });

  expect(body).toContain(`data-verdict="${verdict}"`);
  // The word, not the colour: a reader who cannot tell the chips apart still reads the verdict.
  expect(text(body)).toContain(verdict);
  expect(text(body)).toContain('An empty search shows no recipes.');
});

it('shows no verdict chip on a card whose newest run is not a QA run', () => {
  expect(draw({ key: 'APP-1', state: 'ready' })).not.toContain('data-verdict');
});

it('shows the verdict word alone when the run gave no reason', () => {
  const body = draw({ key: 'APP-1', state: 'ready', verdict: 'PASS' });

  expect(text(body)).toContain('PASS');
  // A prefix match, because Svelte adds its scope class beside the name: the exact string
  // `class="why"` is absent whether the span is drawn or not.
  expect(body).not.toMatch(/class="why[^"]*"/);
});

// The whole reason stays in the title, so a clamped box never hides what QA found.
it('keeps the whole QA reason in the title of the reason box', () => {
  const reason = 'The search box loses focus after the first keystroke on the recipe list page.';
  expect(draw({ key: 'APP-1', state: 'ready', verdict: 'FAIL', verdictReason: reason })).toMatch(new RegExp(`<p class="reason[^"]*" title="${reason}"`));
});

describe('a pull request card', () => {
  // A fixed clock, so the head commit age is the same on every machine. Two days and one hour
  // before NOW.
  const HEAD = new Date(Date.parse(NOW.toISOString()) - (49 * 60 + 30) * 60_000).toISOString();
  const pull = (over: Partial<NonNullable<CardView['pull']>> = {}) => ({
    author: 'dana',
    decision: 'APPROVED' as const,
    headCommittedAt: HEAD,
    draft: false,
    round: null,
    ...over,
  });
  // Selected on the attribute the card writes, the way the card itself is selected on data-card. Both
  // rows, the author's and the decision's, read as one line.
  const line = (body: string): string => text(/<div[^>]*data-pull="[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(body)?.[1] ?? '');

  // The card of a pull request that closed stays on the board and says so in words, first.
  it.each([
    ['closed' as const, 'Closed'],
    ['merged' as const, 'Merged'],
  ])('says a pull request that %s is %s', (ended, word) => {
    const body = draw({ key: 'recipes#42', pull: pull({ ended }) });

    expect(line(body).startsWith(word)).toBe(true);
    expect(body).toContain(`data-ended="${ended}"`);
  });

  it('says nothing of an open pull request having ended', () => {
    expect(draw({ key: 'recipes#42', pull: pull() })).not.toContain('data-ended');
  });

  it('shows the author, the head commit age and the decision', () => {
    const body = draw({ key: 'recipes#42', pull: pull() });

    expect(body).toContain('data-pull="recipes#42"');
    expect(line(body)).toBe('By dana head 2d old Approved No review round yet');
  });

  // The one thing that must never happen: a pull request nobody has decided on reading as approved.
  // GitHub answers no decision for a review left as a comment as well, so the word cannot claim
  // that nobody has reviewed.
  it.each([
    ['REVIEW_REQUIRED' as const, 'Waiting on review'],
    ['CHANGES_REQUESTED' as const, 'Changes requested'],
    ['APPROVED' as const, 'Approved'],
  ])('says %s in words, not in colour alone', (decision, word) => {
    const body = draw({ key: 'recipes#42', pull: pull({ decision }) });

    expect(line(body)).toContain(word);
  });

  // The chip carries the decision for the stylesheet as well, and the two decided dots take two
  // different colours. Read off the source, the way the state ring is.
  it('marks the chip with the decision, and colours the two decided dots apart', () => {
    const source = readFileSync(new URL('./BoardCard.svelte', import.meta.url), 'utf8');
    const colour = (decision: string) => new RegExp(`\\[data-decision='${decision}'\\] i \\{\\s*background: var\\(--([a-z]+)\\)`).exec(source)?.[1];

    expect(draw({ key: 'recipes#42', pull: pull() })).toContain('data-decision="APPROVED"');
    // Red. Amber is for an agent at work.
    expect([colour('APPROVED'), colour('CHANGES_REQUESTED')]).toEqual(['green', 'red']);
  });

  // Nothing fills a card's round number yet, so the branch that says one would go untested until
  // something does.
  it.each<[number | null, string]>([
    [null, 'No review round yet'],
    [2, 'Round 2'],
  ])('says round %s in words', (round, word) => {
    expect(line(draw({ key: 'recipes#42', pull: pull({ round }) }))).toContain(word);
  });

  it('says a field the answer did not carry is not known, and never guesses', () => {
    const body = draw({ key: 'recipes#42', pull: pull({ author: null, headCommittedAt: null, draft: true }) });

    expect(line(body)).toBe('Draft Author unknown head time unknown Approved No review round yet');
  });

  // Geist Mono is for figures. The words that say a figure is missing are words.
  it('sets the head age and the round in mono, and the words for a missing one in Geist', () => {
    const known = draw({ key: 'recipes#42', pull: pull({ round: 2 }) });
    const unknown = draw({ key: 'recipes#42', pull: pull({ headCommittedAt: null }) });

    expect(known).toMatch(/<span class="r[^"]*\bmono\b[^"]*">head 2d old<\/span>/);
    expect(known).toMatch(/<span class="r[^"]*\bmono\b[^"]*">Round 2<\/span>/);
    expect(unknown).toMatch(/<span class="r(?![^"]*\bmono\b)[^"]*">head time unknown<\/span>/);
    expect(unknown).toMatch(/<span class="r(?![^"]*\bmono\b)[^"]*">No review round yet<\/span>/);
  });

  it('draws nothing of a pull request on a card that is not one', () => {
    expect(draw({ key: 'APP-1' })).not.toContain('data-pull=');
  });

  // The Awaiting author card: the pill says the author pushed since round 2,
  // and the two rows still say who, how old, the decision and the round.
  it('says 1 new commit in the pill of an idle card the author pushed to, beside the round', () => {
    const body = draw({ key: 'api#57', state: 'idle', pull: pull({ decision: 'CHANGES_REQUESTED', round: 2, newCommits: 1 }) });

    expect(text(head(body))).toBe('api#57 1 new commit');
    expect(head(body)).toContain('data-state="new"');
    expect(line(body)).toBe('By dana head 2d old Changes requested Round 2');
  });

  it('counts more than one new commit', () => {
    expect(text(head(draw({ key: 'api#57', state: 'idle', pull: pull({ round: 1, newCommits: 3 }) })))).toBe('api#57 3 new commits');
  });
});

// An epic says how many of its tasks are done. The number arrives as data, because
// packages/ui cannot ask core which Delivery stage closes a card.
it('says how many tasks an epic has done', () => {
  const body = draw({ key: 'RECI-1', delivered: { done: 1, total: 3 } });

  expect(body).toContain('data-tasks="RECI-1"');
  expect(text(body)).toContain('1 of 3 tasks done');
});

it('draws no task line on a card that has no tasks', () => {
  expect(text(draw({ key: 'APP-1' }))).not.toContain('tasks done');
});

it('keeps the task count out of the meta row', () => {
  // The meta row is read word for word above, so the count has a line of its own.
  const body = draw({ key: 'RECI-1', state: 'ready', engine: 'claude', model: 'sonnet', effort: 'medium', totalUsd: 2.1, delivered: { done: 3, total: 3 } });

  expect(text(meta(body))).toBe('sonnet medium effort $2.10');
  expect(text(body)).toContain('3 of 3 done');
});

// The In delivery card of an epic: a progress bar, "N of M tasks done" and each task key as a chip
// that opens that Delivery card. The keys and their states come in the snapshot, from the links.
describe('the tasks of an epic', () => {
  const task = (key: string, done: boolean, state: CardState = 'idle') => ({ key, title: `${key} title`, state, done });
  const chips = (body: string) => [...body.matchAll(/<a [^>]*data-task="([^"]+)"[^>]*>/g)].map((found) => found[0]);
  const hrefOf = (chip: string) => /href="([^"]+)"/.exec(chip)?.[1];

  it('draws the count, the share done and a bar that says the same', () => {
    const body = draw({ key: 'APP-1', delivered: { done: 3, total: 7 }, tasks: [task('APP-21', true), task('APP-22', true), task('APP-23', true), task('APP-24', false)] });

    expect(text(body)).toContain('3 of 7 tasks done 43%');
    expect(body).toMatch(/role="progressbar"[^>]*aria-valuenow="3"/);
    expect(body).toMatch(/role="progressbar"[^>]*aria-valuemax="7"/);
    expect(body).toContain('width: 43%');
  });

  it('gives each task a chip that opens its own Delivery card', () => {
    const body = draw({ key: 'APP-1', delivered: { done: 1, total: 2 }, tasks: [task('APP-2', true), task('PROJ-123', false)] });

    expect(chips(body).map(hrefOf)).toEqual(['/t/APP-2', '/t/PROJ-123']);
    expect(chips(body).map((chip) => /data-task="([^"]+)"/.exec(chip)?.[1])).toEqual(['APP-2', 'PROJ-123']);
    // Done in words as well as in green, so the state never rests on a colour.
    expect(text(body)).toContain('APP-2 , done');
    expect(chips(body)[0]).toContain('data-done="true"');
    expect(chips(body)[1]).not.toContain('data-done');
  });

  // A step of the plan not added to Delivery yet counts in M, and has no card to open.
  it('counts a task not added yet with no link', () => {
    const body = draw({ key: 'APP-1', delivered: { done: 1, total: 4 }, tasks: [task('APP-2', true), task('APP-3', false)] });

    expect(text(body)).toContain('1 of 4 tasks done');
    expect(chips(body)).toHaveLength(2);
    expect(text(body)).toContain('2 not added yet');
    expect(body).not.toMatch(/<a [^>]*data-not-added/);
  });

  it('says how many are open on Delivery and how many need the person', () => {
    const body = draw({ key: 'APP-1', delivered: { done: 1, total: 4 }, tasks: [task('APP-2', true), task('APP-3', false, 'blocked'), task('APP-4', false, 'running'), task('APP-5', false)] });

    expect(text(body)).toContain('3 open on Delivery, 1 needs you');
    expect(text(draw({ key: 'APP-1', delivered: { done: 0, total: 1 }, tasks: [task('APP-3', false)] }))).toContain('1 open on Delivery, none needs you');
  });

  // The epic stays in its column, turns green with "M of M done" and waits on the person.
  it('turns green with M of M done once every task is done', () => {
    const body = draw({ key: 'APP-1', state: 'idle', delivered: { done: 2, total: 2 }, tasks: [task('APP-2', true), task('APP-3', true)], finished: true });

    expect(body).toContain('data-finished="true"');
    expect(text(body)).toContain('2 of 2 done 100%');
    expect(text(body)).not.toContain('tasks done');
    expect(text(head(body))).toBe('APP-1 Tasks done');
    expect(text(body)).not.toContain('open on Delivery');
  });

  it('keeps the ring of an epic that is not finished', () => {
    expect(draw({ key: 'APP-1', delivered: { done: 2, total: 2 }, tasks: [task('APP-2', true), task('APP-3', true)] })).not.toContain('data-finished');
  });
});

// The running card: the run's last tool action on one line, and Quiet in
// place of Running once the run has printed nothing for the set time.
describe('the activity of a running card', () => {
  const QUIET_AFTER = 5 * 60_000;
  const activity = (over: Partial<RunActivity> = {}): RunActivity => ({
    runId: 7,
    cardKey: 'APP-1',
    line: 'Reading services/api/src/recipes/list.ts',
    outputAt: NOW.getTime() - 2000,
    ...over,
  });
  const running = { key: 'APP-1', state: 'running' as const, runId: 7, runState: 'running' as const, runStartedAt: STARTED };
  const drawLive = (over: Partial<CardView>, live: RunActivity | null) =>
    render(BoardCard, { props: { card: cardFixture({ ...running, ...over }), now: NOW, activity: live, quietAfterMs: QUIET_AFTER } }).body;
  const act = (body: string) => /<p class="act[^>]*>([\s\S]*?)<\/p>/.exec(body)?.[1] ?? null;

  it('shows the last tool action between the title and the meta row', () => {
    const body = drawLive({}, activity());

    expect(text(act(body) ?? '')).toBe('Reading services/api/src/recipes/list.ts');
    expect(body.indexOf('class="title')).toBeLessThan(body.indexOf('class="act'));
    expect(body.indexOf('class="act')).toBeLessThan(body.indexOf('class="meta'));
    // The whole line in the title, because the card cuts it at its width.
    expect(body).toContain('title="Reading services/api/src/recipes/list.ts"');
  });

  it('shows no line for another run, for a card that is not running, or before the first tool', () => {
    expect(act(drawLive({ runId: 8 }, activity()))).toBeNull();
    expect(act(drawLive({ state: 'ready' }, activity()))).toBeNull();
    expect(act(drawLive({}, activity({ line: null })))).toBeNull();
    expect(act(drawLive({}, null))).toBeNull();
  });

  it('says Running while the run prints, and Quiet with the minutes once it stops', () => {
    const busy = drawLive({}, activity());
    const quiet = drawLive({}, activity({ outputAt: NOW.getTime() - 6 * 60_000 - 5000 }));

    expect(text(busy)).toContain('Running');
    expect(busy).not.toContain('data-quiet');
    expect(text(quiet)).toContain('Quiet 6m');
    expect(text(quiet)).not.toContain('Running');
    expect(quiet).toContain('data-state="quiet"');
    expect(quiet).toContain('data-quiet="true"');
    // The card is still running: it stays locked, and the line stays.
    expect(quiet).toContain('data-state="running"');
    expect(quiet).toContain('data-locked="true"');
    expect(text(act(quiet) ?? '')).toBe('Reading services/api/src/recipes/list.ts');
  });

  // A person can fold a running card to one line. A stuck run must not look busy there either.
  it('says Quiet on a card folded to one line', () => {
    const busy = drawLive({ minimized: true }, activity());
    const quiet = drawLive({ minimized: true }, activity({ outputAt: NOW.getTime() - 6 * 60_000 - 5000 }));

    expect(busy).toContain('data-minimized="true"');
    expect(busy).not.toContain('data-state="quiet"');
    expect(quiet).toContain('data-state="quiet"');
    expect(text(quiet)).toContain('Quiet');
    expect(text(quiet)).not.toContain('Running');
  });

  // "2s ago" opens the meta row and goes once the pill says Quiet, so the card says it once.
  it('says how long ago the run printed, until it reads Quiet', () => {
    const busy = meta(drawLive({}, activity()));
    const quiet = meta(drawLive({}, activity({ outputAt: NOW.getTime() - 6 * 60_000 - 5000 })));

    expect(text(busy)).toBe('last output 2s ago');
    // The space is in the markup, or a screen reader hears "last output2s ago". text() above adds one
    // at every tag, so it cannot tell.
    expect(busy).toMatch(/>last output<\/span> 2s ago</);
    expect(busy).toContain('data-since="APP-1"');
    expect(quiet).not.toContain('data-since');
    expect(meta(drawLive({ runId: 8 }, activity()))).not.toContain('data-since');
    expect(meta(drawLive({}, activity({ line: null })))).not.toContain('data-since');
  });

  // Amber is where an agent works. A quiet run has no claim to it, so its ring and its mark go neutral.
  it('draws the mark amber and the line in ink-2, and takes the amber away when the run is quiet', () => {
    const source = readFileSync(new URL('./BoardCard.svelte', import.meta.url), 'utf8');
    const rule = (selector: string) => new RegExp(`\\n {2}${selector.replace(/[.[\]'()]/g, '\\$&')} \\{([^}]*)\\}`).exec(source)?.[1] ?? '';

    expect(rule('.act')).toContain('color: var(--ink-2);');
    expect(rule('.act')).toContain('font-family: var(--font-mono);');
    expect(rule('.bolt')).toContain('stroke: var(--amber);');
    expect(rule("[data-quiet='true'] .bolt")).toContain('stroke: var(--muted);');
    expect(rule(".card[data-quiet='true']")).toContain('border-color: var(--line-2);');
  });
});

// The column already says which phase the card is in, so the board card draws no phase pips. The card
// page keeps the whole trail.
describe('the phase strip', () => {
  it('draws no pips, and the meta row starts with what is left', () => {
    const body = draw({ key: 'APP-1', state: 'running', runStartedAt: STARTED, model: 'sonnet' });

    expect(body).not.toContain('data-pip');
    expect(body).not.toContain('class="pips');
    expect(meta(body).replace(/<!--[\s\S]*?-->/g, '')).toMatch(/^\s*<span class="run/);
    expect(text(meta(body))).toBe('sonnet');
  });

  // The strip alone used to fill the row. Without it, a card with nothing else to say draws no row.
  it('draws no meta row on a card with nothing else to say', () => {
    expect(draw({ key: 'APP-1' })).not.toContain('class="meta');
  });
});

// Each state, with the words the data can back and nothing more.
describe('the card states', () => {
  const pill = (body: string) => /<span class="pill[^"]*" data-state="([a-z]+)"/.exec(body)?.[1];

  it('draws an idle card with the Idle pill', () => {
    const body = draw({ key: 'APP-1', state: 'idle' });

    expect(pill(body)).toBe('idle');
    expect(text(head(body))).toBe('APP-1 Idle');
  });

  it('says Running in the pill when there is no time to show', () => {
    const { body } = render(BoardCard, { props: { card: cardFixture({ key: 'APP-1', state: 'running', runStartedAt: STARTED }) } });

    expect(text(head(body))).toBe('APP-1 Running');
    expect(body).not.toContain('data-detail-only');
  });

  it('draws a queued card with its place and what it waits for', () => {
    expect(text(head(draw({ key: 'APP-1', state: 'queued', queuePosition: 1, runState: 'queued' })))).toBe('APP-1 Queued 1st');
    expect(text(meta(draw({ key: 'APP-1', state: 'queued', queuePosition: 1, runState: 'queued' })))).toBe('waits for a slot');
    // A job a lane holds waits for that lane, not for a slot, and the words must not say otherwise.
    // They are the lane chips' words, and the longest lane fits in 212px.
    expect(text(meta(draw({ key: 'APP-1', state: 'queued', queuePosition: 1, runState: 'waiting_lane', lane: 'stack' })))).toBe('Stack lane busy');
    expect(text(meta(draw({ key: 'APP-1', state: 'queued', queuePosition: 1, runState: 'waiting_lane', lane: 'knowledge' })))).toBe('Knowledge lane busy');
    // Learn and then start holds it, and the line names the repository a Learn run reads now.
    const held = draw({ key: 'APP-1', state: 'idle', afterLearn: { column: 'Refine', repo: 'api', since: '2026-10-12T11:58:55.000Z' }, model: 'sonnet' });
    expect(text(head(held))).toContain('Starts Refine after Learn');
    expect(text(meta(held))).toBe('learning api');
    // A wrap-up held by knowledge changes waits for the person, not for a slot, so it says so and links there.
    const review = draw({ key: 'APP-1', state: 'queued', queuePosition: null, runState: 'waiting_review', lane: 'knowledge', model: 'sonnet' });
    expect(text(head(review))).toBe('APP-1 Waits for your review');
    expect(text(meta(review))).toBe('Review on Knowledge');
    expect(meta(review)).toMatch(/<a class="answer[^"]*" href="\/knowledge" data-review="APP-1">Review on Knowledge<\/a>/);
    // A snapshot with no run state means the card claims no reason.
    expect(meta(draw({ key: 'APP-1', state: 'queued', queuePosition: 1 }))).toBe('');
    // The reason takes the room the model would need, which would be cut to a letter or two beside it.
    // With no reason to give, the model and effort have the room.
    expect(text(meta(draw({ key: 'APP-1', state: 'queued', queuePosition: 1, runState: 'queued', model: 'sonnet', effort: 'high' })))).toBe('waits for a slot');
    expect(text(meta(draw({ key: 'APP-1', state: 'queued', queuePosition: 1, model: 'sonnet', effort: 'high' })))).toBe('sonnet high effort');
  });

  it('draws a blocked card as Asks you, with the question in its box and Answer at the end of the meta row', () => {
    const body = draw({ key: 'APP-1', state: 'blocked', question: '1 to 5 stars, or thumbs up and down?', model: 'sonnet', effort: 'high', totalUsd: 0.12 });

    expect(pill(body)).toBe('blocked');
    expect(text(head(body))).toBe('APP-1 Asks you');
    expect(text(/<blockquote class="question[^"]*">([\s\S]*?)<\/blockquote>/.exec(body)?.[1] ?? '')).toBe('1 to 5 stars, or thumbs up and down?');
    // The question comes before the meta row.
    expect(body.indexOf('class="question')).toBeLessThan(body.indexOf('class="meta'));
    // Answer takes the room the model and effort would need, and the cost the run reported stays.
    expect(text(meta(body))).toBe('$0.12 Answer');
    // A tab stop, as a button is. A board with no A key reaches Answer with Tab.
    expect(meta(body).replace(/<!--[\s\S]*?-->/g, '').trim()).toMatch(/<a class="answer[^"]*" href="\/t\/APP-1\/overview#asks" data-answer="APP-1">Answer<\/a>$/);
  });

  it('draws a ready card as Ready for you', () => {
    const body = draw({ key: 'APP-1', state: 'ready', totalUsd: 0.15 });

    expect(text(head(body))).toBe('APP-1 Ready for you');
    expect(text(meta(body))).toBe('$0.15');
  });

  it('draws a failed run with its reason in a box before the meta row, and no button that promises a fix', () => {
    const body = draw({ key: 'APP-1', state: 'failed', failureReason: 'git refused the push.', model: 'sonnet' });

    expect(text(head(body))).toBe('APP-1 Failed');
    expect(text(/<p class="reason[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(body)?.[1] ?? '')).toBe('git refused the push.');
    expect(body.indexOf('class="reason')).toBeLessThan(body.indexOf('class="meta'));
    // R retries a failed run. Fix it is for a QA FAIL, and only where the page hands the card onFix.
    expect(text(body)).not.toContain('Fix it');
    expect(body).not.toContain('<button');
  });

  // QA's FAIL ends its run as complete, so the card reads ready, and it drew as a green card with a red chip.
  it('draws a QA FAIL as the failed card, with the QA reason in the box and no chip', () => {
    const body = draw({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'Empty list, not the message.', totalUsd: 0.08 });

    expect(body).toContain('data-state="ready"');
    expect(body).toContain('data-qa-failed="true"');
    expect(pill(body)).toBe('failed');
    expect(text(head(body))).toBe('APP-1 QA failed');
    expect(body).toMatch(/<p class="reason[^"]*" title="Empty list, not the message\." data-verdict="FAIL"><span[^>]*>Empty list, not the message\.<\/span><\/p>/);
    expect(body).not.toMatch(/<p class="verdict/);
    expect(text(body)).not.toContain('Fix it');
    // The run reported its cost, so the card shows it.
    expect(text(meta(body))).toBe('$0.08');
  });

  it('rings a QA FAIL in red, after the green of ready', () => {
    const css = source();

    expect(/\.card\[data-qa-failed='true'\] \{\s*border-color: var\(--red\)/.test(css)).toBe(true);
    expect(css.indexOf(".card[data-qa-failed='true']")).toBeGreaterThan(css.indexOf(".card[data-state='ready']"));
    // The box carries data-verdict too. A verdict colour that is not held to the chip turned its
    // words red, where the box is ink on the red tint.
    expect(css).not.toMatch(/\n {2}\[data-verdict=/);
    expect(css).toContain(".verdict[data-verdict='FAIL'] {");
  });

  // QA's BLOCKED is a question with the verdict's reason, so the chip said the same sentence again.
  it('says a QA question once, in the question box', () => {
    const reason = 'Is an empty search allowed to show every recipe?';
    const body = draw({ key: 'APP-1', state: 'blocked', question: reason, verdict: 'BLOCKED', verdictReason: reason });

    expect(body.split(reason).length - 1).toBe(1);
    expect(body).not.toContain('data-verdict');
  });

  it('keeps every run time, model and cost in Geist Mono, and the row on one line', () => {
    const css = source();
    const rule = (selector: string) => new RegExp(`\\n {2}${selector.replace(/[.[\]'()]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

    expect(rule('.meta')).toContain('white-space: nowrap;');
    expect(rule('.meta')).not.toContain('flex-wrap: wrap');
    expect(rule('.mono')).toContain('font-family: var(--font-mono);');
    const body = draw({ key: 'APP-1', state: 'ready', model: 'sonnet', effort: 'high', totalUsd: 0.15 });
    expect(meta(body)).toMatch(/<span class="mono[^"]*">sonnet<\/span>/);
    expect(meta(body)).toMatch(/<span class="r mono[^"]*" title="Total \$0\.15 \(estimated\)">\$0\.15<\/span>/);
    // The effort is its own item in a group one line high that wraps, so a narrow card drops the
    // effort whole and reads "sonnet", not "sonnet me…".
    expect(meta(body).replace(/<!--[\s\S]*?-->/g, '')).toMatch(/<span class="run[^"]*" title="sonnet, high effort"><span class="mono[^"]*">sonnet<\/span><span[^>]*>high <span class="hidden[^"]*">effort<\/span><\/span><\/span>/);
    expect(rule('.meta > .run')).toContain('flex-wrap: wrap;');
    expect(rule('.meta > .run')).toContain('height: 1lh;');
    expect(rule('.meta > .run')).toContain('overflow: hidden;');
  });
});

// Amber means an agent starts or works. On a card that is the running ring and the
// bolt of the live line. A queued, blocked, failed or quiet card, and every control, gets none.
it('puts amber on the running ring and the bolt only', () => {
  const css = (source().split('<style>')[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const amber = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((rule) => /var\(--amber/.test(rule[2]!)).map((rule) => rule[1]!.trim());

  expect(amber).toEqual([".card[data-state='running']", '.bolt']);
});

// Every colour the card sets is a token, so the card follows both themes and the contrast tests. The
// whole style block is read and not a list of properties, which a literal in outline-color would pass.
it('writes no colour literal anywhere in its styles', () => {
  const css = (source().split('<style>')[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/var\(--[a-z0-9-]+\)/g, '');

  expect(css).toContain('border-color:');
  expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(css).not.toMatch(/\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|color-mix)\(/);
  // Not inside a name such as white-space.
  expect(css).not.toMatch(/(?<![\w-])(?:white|black|red|green|blue|gray|grey|orange|purple|yellow|violet|pink|brown|silver|navy)(?![\w-])/);
});

// The looks a render cannot see, read off the source as the rings are.
describe('the looks', () => {
  const rules = (): [string[], string][] =>
    [...(source().split('<style>')[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => [
      match[1]!.split(',').map((part) => part.trim()),
      match[2]!,
    ]);
  const body = (selector: string): string =>
    rules()
      .filter(([selectors]) => selectors.includes(selector))
      .map(([, declarations]) => declarations)
      .join('');
  const at = (selector: string): number => rules().findIndex(([selectors]) => selectors.includes(selector));

  // The clamp on the box let a fourth line show in its padding, so it sits on the words.
  it('clamps the reason on its words to three lines, and not on the box', () => {
    expect(body('.reason span')).toContain('-webkit-line-clamp: 3;');
    expect(body('.reason span')).toContain('line-clamp: 3;');
    expect(body('.reason')).not.toContain('line-clamp');
  });

  it('draws the ghost with a dashed faint edge, after every state ring so it wins', () => {
    expect(body(".card[data-ghost='true']")).toContain('border-style: dashed;');
    expect(body(".card[data-ghost='true']")).toContain('border-color: var(--faint);');
    expect(body(".one-line[data-ghost='true']")).toContain('border-style: dashed;');
    for (const ring of ["running", "blocked", "ready", "failed"].map((state) => `.card[data-state='${state}']`).concat(".card[data-qa-failed='true']", ".card[data-quiet='true']")) {
      expect(at(".card[data-ghost='true']")).toBeGreaterThan(at(ring));
    }
  });

  // A plain click on the title peeks, as a click anywhere on the card does, so a hover underline would
  // promise a page that does not open. The link stays for Cmd or Ctrl click.
  it('draws no underline on the title on hover', () => {
    expect(source()).not.toContain('.title:hover');
  });

  it('sets the question on the violet tint and the reason on the red one', () => {
    expect(body('.question')).toContain('background: var(--violet-bg);');
    expect(body('.reason')).toContain('background: var(--red-bg);');
  });

  // A queued card's reason and the cost beside Answer are the words that give way in their rows, so
  // neither runs past the card edge. The lane and the cost are each in the title whole.
  it('cuts why a queued card waits and the cost beside Answer, with the whole text in the title', () => {
    expect(body('.meta > .cut')).toContain('flex: 0 1 auto;');
    expect(body('.meta > .cut')).toContain('min-width: 0;');
    expect(body('.meta > .cut')).toContain('text-overflow: ellipsis;');
    expect(at('.meta > .cut')).toBeGreaterThan(at('.meta > *'));
    const queued = meta(draw({ key: 'APP-1', state: 'queued', queuePosition: 1, runState: 'waiting_lane', lane: 'knowledge' }));
    expect(queued).toMatch(/<span class="cut[^"]*" title="Knowledge lane busy">Knowledge lane busy<\/span>/);
    const blocked = meta(draw({ key: 'APP-1', state: 'blocked', question: 'Which index?', totalUsd: 0.004 }));
    expect(blocked).toMatch(/<span class="r mono[^"]*\bcut\b[^"]*" title="Total under \$0\.01 \(estimated\)">under \$0\.01<\/span>/);
    // The model gives way first on a card that has no Answer, so its cost is never cut.
    expect(meta(draw({ key: 'APP-1', state: 'ready', model: 'sonnet', totalUsd: 0.004 }))).not.toMatch(/\bcut\b/);
  });
});

// Other boards find Answer by data-answer. A key other than APP-1 proves it is the card's own.
it('marks Answer with the key of its own card', () => {
  expect(meta(draw({ key: 'PROJ-7', state: 'blocked', question: 'Which index name?' }))).toContain('data-answer="PROJ-7"');
});

// Only the run time stands alone in the pill. "Queued 1st" and "Quiet 6m" keep their word in sight.
it('keeps the word in sight beside the place of a queued card and the minutes of a quiet one', () => {
  const quiet = render(BoardCard, {
    props: {
      card: cardFixture({ key: 'APP-1', state: 'running', runId: 7, runState: 'running', runStartedAt: STARTED }),
      now: NOW,
      activity: { runId: 7, cardKey: 'APP-1', line: null, outputAt: NOW.getTime() - 6 * 60_000 - 5000 },
      quietAfterMs: 5 * 60_000,
    },
  }).body;

  expect(head(draw({ key: 'APP-1', state: 'queued', queuePosition: 1 }))).not.toContain('data-detail-only');
  expect(text(head(quiet))).toBe('APP-1 Quiet 6m');
  expect(head(quiet)).not.toContain('data-detail-only');
});

// Mutation round: Fix it is for a QA FAIL alone, even where the page hands the card onFix.
it('draws no Fix it on a failed run or a passed QA, with onFix handed', () => {
  const fix = (over: Parameters<typeof cardFixture>[0]) => render(BoardCard, { props: { card: cardFixture(over), now: NOW, onFix: () => {} } }).body.includes('data-fix=');

  expect(fix({ key: 'APP-1', state: 'failed', failureReason: 'git refused the push.' })).toBe(false);
  expect(fix({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'PASS' })).toBe(false);
  expect(fix({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'No.' })).toBe(true);
});

// The output check is a warning: a neutral badge that says what is wrong, and links the list on the
// card page.
it('shows the output check badge in words, links the list, and none at no problem', () => {
  const missing = { file: 'implement/summary.md', problem: 'The file is missing.' };
  const one = draw({ key: 'APP-1', state: 'ready', outputProblems: [missing] });

  expect(one).toMatch(/aria-hidden="true">summary missing<\/span><span class="hidden[^"]*">implement\/summary\.md: The file is missing\.<\/span>/);
  expect(one).toContain('title="implement/summary.md: The file is missing."');
  expect(one).toContain('href="/t/APP-1/overview#output-check"');
  expect(text(draw({ key: 'APP-1', state: 'ready', outputProblems: [missing, { ...missing, file: 'share/TESTING.md' }] }))).toContain('Check 2 files missing');
  expect(draw({ key: 'APP-1', state: 'ready' })).not.toContain('data-output-check');
});

// The review comments line on a Delivery card: words only, with a label that reads the dot as a comma.
it('shows the review comments line with its counts, and none without them', () => {
  const body = draw({ key: 'APP-1', state: 'idle', feedback: { toFix: 3, unread: 1 } });
  expect(body).toContain('data-feedback="APP-1"');
  expect(body).toContain('3 to fix · 1 new');
  expect(body).toContain('Review comments: 3 to fix, 1 new');
  expect(text(draw({ key: 'APP-1', state: 'idle', feedback: { toFix: 0, unread: 2 } }))).toContain('2 new');
  expect(draw({ key: 'APP-1', state: 'idle' })).not.toContain('data-feedback');
});
