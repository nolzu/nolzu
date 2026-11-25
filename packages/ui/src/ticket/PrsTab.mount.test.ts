import { flushSync } from 'svelte';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import PrsTab from './PrsTab.svelte';

// jsdom has no modal half of the dialog: showModal only opens, and close fires the close event.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const settle = async () => {
  for (let at = 0; at < 4; at += 1) await Promise.resolve();
  flushSync();
};

const PULL = { id: 1, repo: 'cook/recipes', number: 12, url: null, title: 'Add a search box', state: 'open', foundBy: 'branch', readAt: null };
const say = (id: number, author: string, body: string) => ({ id, author, body, createdAt: '2026-10-29T10:00:00Z', url: null, mine: author === 'pat', unread: id === 1 });
const ROWS = [
  { ref: 'T1', pull: 1, kind: 'thread', path: 'src/list.ts', line: 4, resolved: false, outdated: false, status: 'new', verdict: null, summary: null, reason: null, reply: null, needsAction: null, messages: [say(1, 'dana', 'Rename the list.'), say(2, 'pat', 'Will do.')] },
  { ref: 'T2', pull: 1, kind: 'comment', path: null, line: null, resolved: false, outdated: false, status: 'done', verdict: null, summary: null, reason: null, reply: null, needsAction: null, messages: [say(3, 'sam', 'Nice.')] },
];

function draw(props: Record<string, unknown> = {}) {
  const calls = { onread: vi.fn(async () => ({ said: 'Read the comments of 1 pull request: 3 new messages.', failed: false })), onmark: vi.fn(async () => null), onopen: vi.fn() };
  page = mounted(PrsTab as never, { pulls: [PULL], discussions: ROWS, now: '2026-10-29T12:00:00Z', onattach: async () => null, ondetach: async () => null, ...calls, ...props });
  return { target: page.target, ...calls };
}

const button = (target: HTMLElement, words: string) => [...target.querySelectorAll('button')].find((one) => one.textContent?.trim() === words)!;

it('marks the messages seen once as the tab opens', () => {
  const ui = draw();
  expect(ui.onopen).toHaveBeenCalledTimes(1);
});

it('reads the comments on a press and shows the counts, or the gh sentence in red', async () => {
  const ui = draw();
  button(ui.target, 'Read comments').click();
  await settle();
  expect(ui.onread).toHaveBeenCalledTimes(1);
  const status = ui.target.querySelector('[role="status"].said')!;
  expect(status.textContent).toBe('Read the comments of 1 pull request: 3 new messages.');
  expect(status.classList.contains('failed')).toBe(false);

  page?.remove();
  const failing = draw({ onread: vi.fn(async () => ({ said: 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.', failed: true })) });
  button(failing.target, 'Read comments').click();
  await settle();
  const said = failing.target.querySelector('[role="status"].said')!;
  expect(said.textContent).toContain('gh is not logged in');
  expect(said.classList.contains('failed')).toBe(true);
});

it('opens a row to show every message in order with its author, and marks it done', async () => {
  const ui = draw();
  const toggle = ui.target.querySelector<HTMLButtonElement>('[data-ref="T1"] .toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');

  toggle.click();
  flushSync();

  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const messages = [...ui.target.querySelectorAll('[data-ref="T1"] .messages > li')].map((one) => one.textContent);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toContain('dana');
  expect(messages[0]).toContain('Unread');
  expect(messages[1]).toContain('pat (you)');
  ui.target.querySelector<HTMLButtonElement>('[data-done="T1"]')!.click();
  await settle();
  expect(ui.onmark).toHaveBeenCalledWith('T1', 'done');
});

it('gives each footer row one way back: Reopen when done, Needs action when triage said none', async () => {
  const ui = draw({ discussions: [...ROWS, { ...ROWS[0], ref: 'T3', status: 'new', verdict: 'none' }] });
  expect(ui.target.querySelector('[data-needs="T2"]')).toBeNull();
  ui.target.querySelector<HTMLButtonElement>('[data-reopen="T2"]')!.click();
  await settle();
  expect(ui.onmark).toHaveBeenCalledWith('T2', 'reopen');

  ui.target.querySelector<HTMLButtonElement>('[data-ref="T2"] .toggle')!.click();
  flushSync();
  expect(ui.target.querySelectorAll('[data-reopen="T2"]')).toHaveLength(1);
  expect(ui.target.querySelector('[data-done="T2"]')).toBeNull();

  ui.target.querySelector<HTMLButtonElement>('[data-needs="T3"]')!.click();
  await settle();
  expect(ui.onmark).toHaveBeenLastCalledWith('T3', 'reopen');
});

// The pressed button goes with the row, so focus follows the row instead of dropping to the page.
it('keeps focus on a row that moves to the footer or back', async () => {
  const onmark = vi.fn(async (ref: string, action: string) => {
    page?.set({ discussions: ROWS.map((one) => (one.ref === ref ? { ...one, status: action === 'done' ? 'done' : 'new' } : one)) });
    return null;
  });
  const ui = draw({ onmark });
  ui.target.querySelector<HTMLButtonElement>('[data-ref="T1"] .toggle')!.click();
  flushSync();
  ui.target.querySelector<HTMLButtonElement>('[data-done="T1"]')!.click();
  await settle();
  expect(document.activeElement?.textContent).toContain('Nothing to action');

  ui.target.querySelector<HTMLDetailsElement>('details')!.open = true;
  ui.target.querySelector<HTMLButtonElement>('[data-reopen="T1"]')!.click();
  await settle();
  expect(document.activeElement).toBe(ui.target.querySelector('[data-ref="T1"] .toggle'));
  expect(document.activeElement?.closest('details')).toBeNull();
});

it('shows a refused mark in red', async () => {
  const ui = draw({ onmark: vi.fn(async () => 'A fix is running on T1. Change it once the fix is done.') });
  ui.target.querySelector<HTMLButtonElement>('[data-reopen="T2"]')!.click();
  await settle();
  const said = ui.target.querySelector('[role="status"].said')!;
  expect(said.textContent).toContain('A fix is running on T1.');
  expect(said.classList.contains('failed')).toBe(true);
});

// "No pull request was found" would contradict the list once one is attached, so it goes; a refused
// attach leaves it, since nothing changed.
it('clears the sentence of the last read once a pull request is attached', async () => {
  const ui = draw({ pulls: [], onread: vi.fn(async () => ({ said: 'No pull request was found for APP-2, so there are no comments to read.', failed: false })), onattach: vi.fn(async (link: string) => (link === 'bad' ? 'Type the owner as well.' : null)) });
  const status = () => ui.target.querySelector('.comments [role="status"].said')!.textContent;
  const attach = async (link: string) => {
    const input = ui.target.querySelector<HTMLInputElement>('input')!;
    input.value = link;
    input.dispatchEvent(new Event('input'));
    flushSync();
    ui.target.querySelector<HTMLFormElement>('form')!.requestSubmit();
    await settle();
  };
  button(ui.target, 'Read comments').click();
  await settle();
  expect(status()).toContain('No pull request was found');

  await attach('bad');
  expect(status()).toContain('No pull request was found');
  await attach('example/recipe-workspace#7');
  expect(status()).toBe('');
});

const CARD = { key: 'APP-1', stage: 'pr', state: 'ready' };
const OFFER = { starts: { engine: 'claude-code', model: 'haiku', effort: 'low' }, estimate: undefined, refusal: null, problem: null };

// Only the discussions of the pull request that goes are counted, not every one on the card.
it('asks before a detach with the count of that pull request\'s discussions', () => {
  const attached = { ...PULL, id: 2, repo: 'cook/api', number: 7, foundBy: 'attached' };
  const ui = draw({ pulls: [PULL, attached], discussions: [...ROWS, { ...ROWS[0], ref: 'T3', pull: 2 }] });

  ui.target.querySelector<HTMLButtonElement>('[data-detach="cook/api#7"]')!.click();
  flushSync();

  expect(ui.target.querySelector('dialog')!.textContent).toContain('The card loses cook/api#7 and its 1 discussion with its messages.');
});

it('copies a drafted reply and says where to post it', async () => {
  const oncopy = vi.fn(async () => null);
  const rows = [{ ...ROWS[0], verdict: 'fix', summary: 'Rename it.', reason: 'Right.', reply: 'Will rename it to recipes.' }];
  const ui = draw({ discussions: rows, card: CARD, triage: OFFER, oncopy });
  ui.target.querySelector<HTMLButtonElement>('[data-copy="T1"]')!.click();
  await settle();
  expect(oncopy).toHaveBeenCalledWith('Will rename it to recipes.');
  expect(ui.target.querySelector('[role="status"].said')!.textContent).toBe('The reply to T1 is on the clipboard. Post it on GitHub yourself.');
});

it('starts triage once and holds the button until the board shows the card moved, or shows the refusal', async () => {
  const ontriage = vi.fn(async () => null);
  const ui = draw({ card: CARD, triage: OFFER, ontriage });
  const run = () => ui.target.querySelector<HTMLButtonElement>('[data-run="triage"]')!;
  run().click();
  await settle();
  expect(ontriage).toHaveBeenCalledTimes(1);
  expect(run().disabled).toBe(true);
  expect(ui.target.textContent).toContain('Sent. Waiting for the board to show the run.');

  page?.remove();
  const refusing = draw({ card: CARD, triage: OFFER, ontriage: vi.fn(async () => 'APP-1 is blocked. Run triage once nothing else holds the card.') });
  refusing.target.querySelector<HTMLButtonElement>('[data-run="triage"]')!.click();
  await settle();
  const said = refusing.target.querySelector('[role="status"].said')!;
  expect(said.textContent).toContain('APP-1 is blocked.');
  expect(said.classList.contains('failed')).toBe(true);
  expect(refusing.target.querySelector<HTMLButtonElement>('[data-run="triage"]')!.disabled).toBe(false);
});

it('starts one Fix and holds every Fix until the board shows the card moved, or shows the refusal', async () => {
  const onfix = vi.fn(async () => null);
  const ui = draw({ card: { ...CARD, state: 'idle' }, onfix });
  const fix = () => ui.target.querySelector<HTMLButtonElement>('[data-fix="T1"]')!;
  fix().click();
  fix().click();
  await settle();
  expect(onfix).toHaveBeenCalledTimes(1);
  expect(onfix).toHaveBeenCalledWith('T1');
  expect(fix().disabled).toBe(true);
  expect(ui.target.textContent).toContain('Sent. Waiting for the board to show the run.');

  page?.remove();
  const refusing = draw({ card: { ...CARD, state: 'idle' }, onfix: vi.fn(async () => 'APP-1 is done, so its checkout is not there to fix. Move it back first.') });
  refusing.target.querySelector<HTMLButtonElement>('[data-fix="T1"]')!.click();
  await settle();
  const said = refusing.target.querySelector('[role="status"].said')!;
  expect(said.textContent).toContain('APP-1 is done');
  expect(said.classList.contains('failed')).toBe(true);
  expect(refusing.target.querySelector<HTMLButtonElement>('[data-fix="T1"]')!.disabled).toBe(false);
});

it('asks to discuss a row by its ref, and shows a refusal', async () => {
  const ondiscuss = vi.fn(async () => 'APP-1 has no comment T2. Read the comments again.');
  const ui = draw({ card: CARD, onfix: async () => null, ondiscuss });
  ui.target.querySelector<HTMLButtonElement>('[data-discuss="T1"]')!.click();
  await settle();
  expect(ondiscuss).toHaveBeenCalledWith('T1');
  expect(ui.target.querySelector('[role="status"].said')!.textContent).toBe('APP-1 has no comment T2. Read the comments again.');
});

// Discuss writes the thread and opens the Discussion tab, so the press is busy and a second one waits.
it('discusses once while the first press is on its way, and says it is busy', async () => {
  let answer: (said: string | null) => void = () => undefined;
  const ondiscuss = vi.fn(() => new Promise<string | null>((done) => (answer = done)));
  const ui = draw({ card: CARD, onfix: async () => null, ondiscuss });
  const press = () => ui.target.querySelector<HTMLButtonElement>('[data-discuss="T1"]')!;

  press().click();
  flushSync();
  press().click();
  flushSync();

  expect(ondiscuss).toHaveBeenCalledTimes(1);
  expect(press().getAttribute('aria-busy')).toBe('true');
  answer(null);
  await settle();
  expect(press().hasAttribute('aria-busy')).toBe(false);
});

it('draws Fix all and QA the fixes only when the page offers them, and says why each is held', async () => {
  const fixRow = { ...ROWS[0]!, verdict: 'fix' };
  const none = draw({ card: CARD, discussions: [fixRow] });
  expect(none.target.querySelector('[data-run="fix-all"]')).toBeNull();
  expect(none.target.querySelector('[data-run="qa-fixes"]')).toBeNull();

  page?.remove();
  const onfixall = vi.fn(async () => null);
  const onqa = vi.fn(async () => null);
  const ui = draw({ card: { ...CARD, state: 'idle' }, discussions: [fixRow], onfixall, qaFixes: [], onqa });
  const all = () => ui.target.querySelector<HTMLButtonElement>('[data-run="fix-all"]')!;
  const qa = () => ui.target.querySelector<HTMLButtonElement>('[data-run="qa-fixes"]')!;
  expect(all().textContent?.trim()).toBe('Fix all');
  expect(all().disabled).toBe(false);
  expect(qa().disabled).toBe(true);
  expect(ui.target.querySelector(`#${qa().getAttribute('aria-describedby')}`)?.textContent).toContain('QA the fixes: Nothing was fixed since the last QA.');

  all().click();
  all().click();
  await settle();
  expect(onfixall).toHaveBeenCalledTimes(1);
  expect(all().disabled).toBe(true);
  expect(ui.target.textContent).toContain('Fix all: Sent. Waiting for the board to show the run.');
});

it('starts QA the fixes once something was fixed, and shows a refusal in red', async () => {
  const fixed = { ...ROWS[0]!, verdict: 'fix', status: 'fixed' };
  const onqa = vi.fn(async () => 'Nothing was fixed on APP-1 since its last QA, so QA has nothing new to check. Fix a comment first.');
  const ui = draw({ card: { ...CARD, state: 'idle' }, discussions: [fixed], onfixall: async () => null, qaFixes: ['T1'], onqa });
  const qa = () => ui.target.querySelector<HTMLButtonElement>('[data-run="qa-fixes"]')!;
  expect(qa().disabled).toBe(false);
  qa().click();
  await settle();
  expect(onqa).toHaveBeenCalledTimes(1);
  const said = ui.target.querySelector('[role="status"].said')!;
  expect(said.textContent).toContain('since its last QA');
  expect(said.classList.contains('failed')).toBe(true);
  expect(qa().disabled).toBe(false);
});
