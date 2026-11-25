import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import { boardFixture, cardFixture } from '../board/fixture.ts';
import TicketActions from './TicketActions.svelte';

const stages = boardFixture('pull-request').stages;
const stage = (id: string) => stages.find((found) => found.id === id) ?? null;
const taken = async (): Promise<string | null> => null;

const draw = (over: Parameters<typeof cardFixture>[0], next: string | null, starts?: string) =>
  render(TicketActions, {
    props: { card: cardFixture(over), next: next === null ? null : stage(next), starts, onmove: taken, onminimize: taken },
  }).body;

const moveButton = (body: string) => body.match(/<button[^>]*data-move[^>]*>/)?.[0] ?? '';
const minimizeButton = (body: string) => body.match(/<button[^>]*data-minimize[^>]*>/)?.[0] ?? '';
// The move button's accessible name, worked out the way a screen reader does: hidden parts left out and
// tags joined with no space, so words that run together in the name run together here too.
const moveText = (body: string) =>
  (/<button[^>]*data-move[^>]*>([\s\S]*?)<\/button>/.exec(body)?.[1] ?? '')
    .replace(/<span aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

it('draws Move forward with the words the drop target uses', () => {
  const body = draw({ key: 'APP-1', stage: 'inbox' }, 'refine', 'Starts: /refine · haiku · low');

  // Inside the button, so the button says what the press starts.
  expect(moveText(body)).toBe('Move forward Starts: /refine · haiku · low');
  expect(moveButton(body)).toContain('data-move="refine"');
  expect(moveButton(body)).not.toContain('aria-disabled');
});

it('names the stage and shows no label when the move starts nothing', () => {
  const body = draw({ key: 'APP-1', stage: 'review' }, 'pr-watch');

  expect(body).toContain('Move to Pull request');
  expect(body).not.toContain('Starts:');
});

// A reference to an id that is not on the page is read as nothing by some readers and as an error
// by others, so the one id the button points at has to be there.
it('points only at what is on the page when the move starts nothing', () => {
  const body = draw({ key: 'APP-1', stage: 'review' }, 'pr-watch');
  const ids = (moveButton(body).match(/aria-describedby="([^"]+)"/)?.[1] ?? '').split(' ');

  expect(ids).toHaveLength(1);
  for (const id of ids) expect(body).toContain(`id="${id}"`);
});

// A real button and not a styled span, so the keyboard reaches it. Until this, dragging was the
// only way to move a card.
it('is a real button', () => {
  expect(moveButton(draw({ key: 'APP-1', stage: 'inbox' }, 'refine', 'Starts: /refine · haiku · low'))).toMatch(/^<button[^>]*type="button"/);
});

it.each(['queued', 'running'] as const)('holds the move while the card is %s, and says why in words', (state) => {
  const body = draw({ key: 'APP-1', stage: 'refine', state }, 'plan', 'Starts: /plan · sonnet · medium');

  expect(moveButton(body)).toContain('aria-disabled="true"');
  expect(moveButton(body)).toContain('aria-busy="true"');
  expect(body).toContain(`APP-1 is ${state}. It cannot move until its run ends.`);
});

// A disabled button cannot hold the focus. The browser takes the focus away the moment it is set,
// so a person who pressed Enter would lose their place on the page. aria-disabled keeps the button
// in the tab order, and the click handler is what refuses the press.
it('never uses the disabled attribute, so the keyboard focus stays on the button', () => {
  const held = moveButton(draw({ key: 'APP-1', stage: 'refine', state: 'running' }, 'plan', 'Starts: /plan · sonnet · medium'));

  expect(held).not.toMatch(/\sdisabled(=|\s|>)/);
});

// The label is part of the button's name now, so the button points only at the reason, which sits
// outside it. Pointing at the label too would read it twice.
it('reads the label as part of the button and points at the reason', () => {
  const body = draw({ key: 'APP-1', stage: 'refine', state: 'queued' }, 'plan', 'Starts: /plan · sonnet · medium');
  const ids = (moveButton(body).match(/aria-describedby="([^"]+)"/)?.[1] ?? '').split(' ');

  expect(moveText(body)).toContain('Starts: /plan');
  expect(ids).toHaveLength(1);
  expect(body).toMatch(new RegExp(`id="${ids[0]}"[^>]*>APP-1 is queued`));
});

it('announces the reason when it changes, and keeps the place for it when there is none', () => {
  const free = draw({ key: 'APP-1', stage: 'inbox' }, 'refine', 'Starts: /refine · haiku · low');

  expect(free).toMatch(/<p[^>]*role="status"[^>]*><\/p>/);
});

it('says what is wrong with a gone model on the button itself', () => {
  const plan = stage('plan');
  const gone = plan === null || plan.starts === null ? null : { ...plan, starts: { ...plan.starts, engine: 'claude-code', modelState: 'gone' as const } };
  const body = render(TicketActions, {
    props: { card: cardFixture({ key: 'APP-1', stage: 'refine' }), next: gone, starts: 'sonnet is gone. Pick another model in the card settings, or in Settings, Models.', onmove: taken, onminimize: taken },
  }).body;
  expect(moveButton(body)).toContain('aria-disabled="true"');
  expect(moveText(body)).toContain('sonnet is gone');
});

it('is not marked busy on a card that can move', () => {
  expect(moveButton(draw({ key: 'APP-1', stage: 'inbox' }, 'refine', 'Starts: /refine · haiku · low'))).not.toContain('aria-busy');
});

it('draws no move button in the last stage, and still offers Minimize', () => {
  const body = draw({ key: 'APP-1', stage: 'closed' }, null);

  expect(moveButton(body)).toBe('');
  expect(minimizeButton(body)).not.toBe('');
});

// Parking a card is not a move, so a run does not hold this one.
it.each(['queued', 'running'] as const)('leaves Minimize free while the card is %s', (state) => {
  expect(minimizeButton(draw({ key: 'APP-1', stage: 'refine', state }, 'plan'))).not.toContain('disabled');
  expect(minimizeButton(draw({ key: 'APP-1', stage: 'refine', state }, 'plan'))).not.toContain('aria-busy');
});

it('takes the pressed state of Minimize from the card the snapshot carries', () => {
  expect(minimizeButton(draw({ key: 'APP-1', minimized: true }, 'refine'))).toContain('aria-pressed="true"');
  expect(minimizeButton(draw({ key: 'APP-1', minimized: false }, 'refine'))).toContain('aria-pressed="false"');
});

// Button passes the hook through with the key of this card, not of the first card a test draws.
it('marks Minimize with the key of the card it folds', () => {
  expect(minimizeButton(draw({ key: 'APP-7' }, 'refine'))).toContain('data-minimize="APP-7"');
});

it('escapes a key that holds markup', () => {
  expect(draw({ key: 'APP<b>1', stage: 'refine', state: 'running' }, 'plan')).not.toContain('<b>');
});

const classes = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? [];
const runButton = (body: string) => body.match(/<button[^>]*data-run=[^>]*>/)?.[0] ?? '';

// Amber is the colour of a run starting (`docs/design-system.md`), so the move that starts one is
// the go button and the move that starts nothing is primary. Minimize only folds the card.
it('draws Move forward as go when it starts a run, as primary when not, and Minimize as ghost', () => {
  const starts = classes(moveButton(draw({ key: 'APP-1', stage: 'inbox' }, 'refine', 'Starts: /refine · haiku · low')));
  const startsNothing = classes(moveButton(draw({ key: 'APP-1', stage: 'review' }, 'pr-watch')));

  expect(starts).toContain('go');
  expect(starts).not.toContain('primary');
  expect(startsNothing).toContain('primary');
  expect(startsNothing).not.toContain('go');
  expect(classes(minimizeButton(draw({ key: 'APP-1' }, 'refine')))).toContain('ghost');
});

it('draws Retry as go, because it starts a run, and Stop as ghost', () => {
  expect(classes(runButton(draw({ key: 'APP-1', stage: 'implement', state: 'failed' }, 'qa')))).toContain('go');
  const stop = classes(runButton(draw({ key: 'APP-1', stage: 'implement', state: 'running', runId: 7 }, 'qa')));
  expect(stop).toContain('ghost');
  expect(stop).not.toContain('go');
});

const drawFailed = (runOn: { profiles: { id: string; label: string }[]; note: string | null } | null) =>
  render(TicketActions, {
    props: { card: cardFixture({ key: 'APP-1', stage: 'implement', state: 'failed', failureReason: '5-hour limit, resets 19:00' }), next: stage('qa'), starts: undefined, runOn, onmove: taken, onminimize: taken },
  }).body;

const runOnButton = (body: string, id: string) => body.match(new RegExp(`<button[^>]*data-run-on="${id}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? '';

// The person's own label for the login, not the id Nolzu made from it.
it('draws a Run on button per profile the page offered', () => {
  const body = drawFailed({ profiles: [{ id: 'codex#work', label: 'Codex work' }], note: null });

  expect(runOnButton(body, 'codex#work')).toContain('Run on Codex work');
  expect(runOnButton(body, 'codex#work')).toMatch(/^<button[^>]*type="button"/);
});

// A failed card offers Retry and a Run on per login, and a move label grows with the model's name.
// So the row wraps, and a lone button wraps its words, or a phone scrolls sideways.
it('lets the row and a lone button wrap, so the actions fit a phone', () => {
  const style = /<style>([\s\S]*)<\/style>/.exec(readFileSync(new URL('./TicketActions.svelte', import.meta.url), 'utf8'))?.[1] ?? '';
  const rule = (selector: string) => style.split(`${selector} {`)[1]?.split('}')[0] ?? '';

  expect(rule('.actions')).toContain('flex-wrap: wrap;');
  expect(rule('.actions > :global(.btn.sm)')).toContain('max-width: 100%;');
  expect(rule('.actions > :global(.btn.sm)')).toContain('white-space: normal;');
});

// A fresh run on another login is a run starting, so it is go like Retry beside it.
it('draws Run on as go', () => {
  expect(classes(runOnButton(drawFailed({ profiles: [{ id: 'codex#work', label: 'Codex work' }], note: null }), 'codex#work'))).toContain('go');
});

// Before the click, and pointed at by the button, so a screen reader hears it as part of the
// button's description rather than finding it somewhere further down the page.
it('says the run is fresh, and points the button at that line', () => {
  const body = drawFailed({ profiles: [{ id: 'codex#work', label: 'Codex work' }], note: null });
  const id = /aria-describedby="([^"]+)"/.exec(runOnButton(body, 'codex#work'))?.[1] ?? '';
  // The line the button points at, and not any line on the page: a button pointed at the failure
  // reason would read as described while the sentence about the fresh run is never announced.
  const described = new RegExp(`<p[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</p>`).exec(body)?.[1] ?? '';

  expect(described).toContain('A fresh run, because a session belongs to one profile.');
  expect(described).toContain('it goes on from the plan, the progress file and the changes already there');
});

it('draws the reason instead of the buttons when no profile can run the phase', () => {
  const body = drawFailed({ profiles: [], note: 'Nolzu found no Cursor command on this machine, so no row can be set to cursor.' });

  expect(body).toContain('Nolzu found no Cursor command');
  expect(body).not.toContain('data-run-on=');
});

it('offers no Run on while the card is running', () => {
  const body = render(TicketActions, {
    props: { card: cardFixture({ key: 'APP-1', stage: 'implement', state: 'running' }), next: stage('qa'), starts: undefined, runOn: { profiles: [{ id: 'codex#work', label: 'Codex work' }], note: null }, onmove: taken, onminimize: taken },
  }).body;

  expect(body).not.toContain('data-run-on=');
  expect(body).not.toContain('A fresh run');
});
