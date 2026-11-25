import { boardFixture } from '@nolzu/ui/fixture';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import QaAskDialog from './QaAskDialog.svelte';
import type { QaSetup } from './qa-setup.ts';

// The question at the first QA. Start QA is the consent: it saves the answer, then
// sends the move the screen held back. Cancel the move saves nothing and sends nothing. The fetch
// stands in for the server.

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

let instance: object | null = null;
let target: HTMLElement | null = null;
let answer = new Response('{"ok":true}');
const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => answer.clone());

beforeEach(() => {
  drawnAt('/b/delivery');
  answer = new Response('{"ok":true}');
  fetched.mockClear();
  vi.stubGlobal('fetch', fetched);
});

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
  vi.unstubAllGlobals();
});

const SETUP: QaSetup = { project: 'recipes', repo: null, dev: { command: 'npm run dev', repo: '.' }, scripts: '', unwalled: null, address: '', test: 'npm test', playwright: false, chrome: false, browser: false };
const QA = boardFixture('pull-request', []).stages.find((stage) => stage.id === 'qa')!;

function draw(setup: QaSetup = SETUP) {
  const go = vi.fn();
  const stay = vi.fn();
  const onclose = vi.fn();
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(QaAskDialog, { target, props: { ask: { key: 'APP-1', stage: QA, setup, go, stay }, onclose } });
  flushSync();
  const dialog = target.querySelector<HTMLDialogElement>('dialog[data-qa-ask]')!;
  const button = (name: string) => [...dialog.querySelectorAll('button')].find((one) => one.textContent?.trim() === name)!;
  return { dialog, button, go, stay, onclose };
}

const settle = () => new Promise((done) => setTimeout(done, 0));
// The saves only. The dialog also reads the card's copy once it opens.
const posts = () => fetched.mock.calls.filter((call) => call[1]?.method === 'POST');

it('asks with what the repository proposes, and the Starts line beside Start QA', () => {
  const { dialog } = draw();

  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('h2')?.textContent).toBe('QA wants to run recipes before it checks APP-1');
  expect(dialog.textContent).toContain('Found in package.json. Pick one, it is saved for the project.');
  expect(dialog.textContent).toContain('Start it with npm run dev and stop it after');
  expect(dialog.textContent).toContain("Runs in APP-1's copy of the repository, on a free port");
  expect(dialog.textContent).toContain('It is already running at');
  expect(dialog.textContent).toContain('QA reads the change and runs npm test');
  expect(dialog.textContent).toContain('/qa · sonnet · medium');
  expect(dialog.querySelector<HTMLInputElement>('[data-choice="dev"]')?.checked).toBe(true);
});

// The start runs the scripts on the card's branch, so those are what the person reads before Start QA.
it("shows the scripts of the card's copy and whether the start is walled", async () => {
  answer = new Response(JSON.stringify({ ...SETUP, scripts: 'dev: node server.mjs --changed' }));
  const { dialog } = draw({ ...SETUP, scripts: 'dev: node server.mjs' });
  expect(dialog.querySelector('[data-scripts]')?.textContent).toBe('dev: node server.mjs');
  expect(dialog.textContent).toContain(', inside the wall');
  await settle();
  flushSync();

  expect(fetched.mock.calls[0]?.[0]).toBe('../api/qa-setup?key=APP-1');
  expect(dialog.querySelector('[data-scripts]')?.textContent).toBe('dev: node server.mjs --changed');
});

it('says where the start runs with no wall', () => {
  const { dialog } = draw({ ...SETUP, unwalled: 'bubblewrap is not installed.' });

  expect(dialog.querySelector('[data-unwalled]')?.textContent).toBe('Runs with no wall on this machine: bubblewrap is not installed.');
  expect(dialog.textContent).not.toContain('inside the wall');
});

it('offers no start command where no package.json names one', () => {
  const { dialog } = draw({ ...SETUP, dev: null });

  expect(dialog.querySelector('[data-choice="dev"]')).toBeNull();
  expect(dialog.querySelector<HTMLInputElement>('[data-choice="code"]')?.checked).toBe(true);
  expect(dialog.textContent).not.toContain('Found in package.json');
  expect(dialog.querySelector('[data-no-start]')?.textContent).toBe('No package.json here or one folder down names a start script.');
});

// A start command found one folder down says where it runs, and only a missing one says why.
it('names the folder of a start command one folder down', () => {
  const { dialog } = draw({ ...SETUP, dev: { command: 'npm run dev', repo: '.', folder: 'frontend' } });

  expect(dialog.textContent).toContain("Runs in APP-1's copy of the repository, in frontend, on a free port");
  expect(dialog.querySelector('[data-no-start]')).toBeNull();
});

// A card can be the one that makes the app, so the project folder has no package.json yet. The dialog
// then asks for the card's own copy, and offers the start command found there.
it("offers the start command from the card's own copy when the project folder has none", async () => {
  answer = new Response(JSON.stringify({ ...SETUP, address: 'localhost:5175' }));
  const { dialog } = draw({ ...SETUP, dev: null });
  await settle();
  flushSync();

  expect(fetched.mock.calls[0]?.[0]).toBe('../api/qa-setup?key=APP-1');
  expect(dialog.textContent).toContain('Start it with npm run dev and stop it after');
  expect(dialog.querySelector<HTMLInputElement>('[data-choice="dev"]')?.checked).toBe(true);
  expect(dialog.querySelector<HTMLInputElement>('[data-address]')?.value).toBe('localhost:5175');
});

// In a workspace the stream asks about the project's first repository with no answer, and the card can
// have changed another one. The dialog then asks about the card's repository.
it("asks about the card's own repository in a workspace", async () => {
  answer = new Response(JSON.stringify({ ...SETUP, project: 'web', repo: 'web', dev: null }));
  const { dialog } = draw({ ...SETUP, project: 'api', repo: 'api', dev: { command: 'npm run dev', repo: 'api' } });
  expect(dialog.textContent).toContain('Pick one, it is saved for api.');
  await settle();
  flushSync();

  expect(dialog.querySelector('h2')?.textContent).toBe('QA wants to run web before it checks APP-1');
  expect(dialog.textContent).toContain('Pick one, it is saved for web.');
  expect(dialog.querySelector('[data-choice="dev"]')).toBeNull();
  expect(dialog.querySelector<HTMLInputElement>('[data-choice="code"]')?.checked).toBe(true);
});

it("keeps a choice made before the card's copy answers", async () => {
  let found: (answer: Response) => void = () => undefined;
  fetched.mockImplementationOnce(() => new Promise((resolve) => (found = resolve)));
  const { dialog } = draw({ ...SETUP, dev: null });
  dialog.querySelector<HTMLInputElement>('[data-choice="running"]')!.click();
  flushSync();

  found(new Response(JSON.stringify(SETUP)));
  await settle();
  flushSync();

  expect(dialog.querySelector('[data-choice="dev"]')).not.toBeNull();
  expect(dialog.querySelector<HTMLInputElement>('[data-choice="running"]')?.checked).toBe(true);
});

it("draws the browser switch on when the card's copy has Playwright, even after a pick", async () => {
  let found: (answer: Response) => void = () => undefined;
  fetched.mockImplementationOnce(() => new Promise((resolve) => (found = resolve)));
  const { dialog } = draw({ ...SETUP, dev: null });
  dialog.querySelector<HTMLInputElement>('[data-choice="running"]')!.click();
  flushSync();

  found(new Response(JSON.stringify({ ...SETUP, playwright: true })));
  await settle();
  flushSync();

  expect(dialog.querySelector('[data-browser] [role="switch"]')?.getAttribute('aria-checked')).toBe('true');
});

it("ignores the card's copy once Start QA was pressed", async () => {
  let found: (answer: Response) => void = () => undefined;
  fetched.mockImplementationOnce(() => new Promise((resolve) => (found = resolve)));
  let saved: (answer: Response) => void = () => undefined;
  fetched.mockImplementationOnce(() => new Promise((resolve) => (saved = resolve)));
  const { dialog, button } = draw({ ...SETUP, dev: null });

  button('Start QA').click();
  await settle();
  found(new Response(JSON.stringify(SETUP)));
  await settle();
  flushSync();

  expect(dialog.querySelector('[data-choice="dev"]')).toBeNull();
  expect(JSON.parse(fetched.mock.calls[1]?.[1]?.body as string)).toEqual({ key: 'APP-1', choice: 'code', address: '' });
  saved(new Response('{"ok":true}'));
  await settle();
});

// The server comes from npx, so Chrome on the machine is enough. The switch starts on only where the
// project has Playwright or QA has a browser already.
it('shows the browser switch only when Chrome or Playwright is found', () => {
  expect(draw().dialog.querySelector('[data-browser]')).toBeNull();
  void unmount(instance!);
  target?.remove();

  const chrome = draw({ ...SETUP, chrome: true }).dialog.querySelector('[data-browser]');
  expect(chrome?.textContent).toContain('Let QA use a browser and take screenshots');
  expect(chrome?.textContent).toContain('Opens pages in Google Chrome');
  expect(chrome?.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  void unmount(instance!);
  target?.remove();

  const { dialog } = draw({ ...SETUP, playwright: true });
  expect(dialog.querySelector('[data-browser] [role="switch"]')?.getAttribute('aria-checked')).toBe('true');
});

it('sends the switch with Chrome alone', async () => {
  const { dialog, button } = draw({ ...SETUP, chrome: true });
  dialog.querySelector<HTMLElement>('[data-browser] [role="switch"]')!.click();
  flushSync();

  button('Start QA').click();
  await settle();

  expect(JSON.parse(posts()[0]?.[1]?.body as string)).toEqual({ key: 'APP-1', choice: 'dev', address: '', scripts: '', browser: true });
});

// Tab out of the choices lands in the address box. Reaching it on the keys must not swap the choice, or
// Start QA would save "already running" for the project when the person picked the start command.
it('keeps the choice when the address box only gets the focus, and picks it on typing', () => {
  const { dialog } = draw({ ...SETUP, address: 'localhost:5174' });
  const box = dialog.querySelector<HTMLInputElement>('[data-address]')!;

  box.focus();
  flushSync();
  expect(dialog.querySelector<HTMLInputElement>('[data-choice="dev"]')?.checked).toBe(true);

  box.value = 'localhost:5175';
  // A browser's input event bubbles, and Svelte hears it at the root.
  box.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(dialog.querySelector<HTMLInputElement>('[data-choice="running"]')?.checked).toBe(true);
});

it('saves the answer and then sends the held move on Start QA', async () => {
  // The save is held, so the test sees that the move waits for it. The read of the card's copy comes first.
  let saved: (answer: Response) => void = () => undefined;
  fetched.mockImplementationOnce(async () => new Response('null'));
  fetched.mockImplementationOnce(() => new Promise((resolve) => (saved = resolve)));
  const { dialog, button, go, stay, onclose } = draw({ ...SETUP, playwright: true });
  dialog.querySelector<HTMLInputElement>('[data-address]')!.value = 'localhost:5173';
  dialog.querySelector<HTMLInputElement>('[data-address]')!.dispatchEvent(new Event('input'));
  dialog.querySelector<HTMLInputElement>('[data-choice="running"]')!.click();
  flushSync();

  button('Start QA').click();
  await settle();
  expect(go).not.toHaveBeenCalled();
  saved(new Response('{"ok":true}'));
  await settle();
  flushSync();

  expect(posts()).toHaveLength(1);
  expect(posts()[0]?.[0]).toBe('../api/qa-setup');
  expect(JSON.parse(posts()[0]?.[1]?.body as string)).toEqual({ key: 'APP-1', choice: 'running', address: 'localhost:5173', browser: true });
  expect(go).toHaveBeenCalledOnce();
  expect(stay).not.toHaveBeenCalled();
  expect(onclose).toHaveBeenCalledOnce();
});

// The fourth way: your own commands, which run with no wall so Docker works. Start is the one box needed.
it('offers your own commands with three boxes, and sends them on Start QA', async () => {
  fetched.mockImplementationOnce(async () => new Response('null'));
  const { dialog, button, go } = draw();
  expect(dialog.textContent).toContain('Start it with my own commands');
  expect(dialog.querySelector('[data-own]')).toBeNull();

  dialog.querySelector<HTMLInputElement>('[data-choice="own"]')!.click();
  flushSync();
  expect(dialog.textContent).toContain("They run in APP-1's copy of the repository with no wall, so Docker works. {key} becomes the card key.");
  expect([...dialog.querySelectorAll<HTMLInputElement>('[data-own]')].map((box) => box.labels?.[0]?.textContent)).toEqual(['Start', 'Stop, if it needs one', 'Status, if it has one']);
  const type = (box: string, value: string) => {
    const input = dialog.querySelector<HTMLInputElement>(`[data-own="${box}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  type('start', 'docker compose up -d');
  type('stop', 'docker compose down');
  flushSync();

  button('Start QA').click();
  await settle();
  flushSync();

  expect(JSON.parse(posts()[0]?.[1]?.body as string)).toEqual({ key: 'APP-1', choice: 'own', address: '', start: 'docker compose up -d', stop: 'docker compose down', status: '' });
  expect(go).toHaveBeenCalledOnce();
});

it('keeps the question open with the sentence when the answer is refused, and sends no move', async () => {
  answer = new Response(JSON.stringify({ message: 'Type the address the app runs at, such as localhost:5173.' }), { status: 422 });
  const { dialog, button, go } = draw();
  dialog.querySelector<HTMLInputElement>('[data-choice="running"]')!.click();
  flushSync();

  button('Start QA').click();
  await settle();
  flushSync();

  // No Playwright found, so the answer carries no browser choice.
  expect(JSON.parse(posts()[0]?.[1]?.body as string)).toEqual({ key: 'APP-1', choice: 'running', address: '' });
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Type the address the app runs at, such as localhost:5173.');
  expect(go).not.toHaveBeenCalled();
});

// Start QA is the yes to the scripts on screen. When the server says they changed, the dialog reads the
// card's copy again so the person sees the new ones before a second Start QA.
it('sends the scripts it shows, and reads them again when the answer is refused', async () => {
  fetched.mockImplementationOnce(async () => new Response('null'));
  const { dialog, button, go } = draw({ ...SETUP, scripts: 'dev: node server.mjs' });
  await settle();
  answer = new Response(JSON.stringify({ message: 'The package.json scripts changed since this question opened. Read the new ones and pick again.' }), { status: 409 });
  fetched.mockImplementationOnce(async () => answer.clone()).mockImplementationOnce(async () => new Response(JSON.stringify({ ...SETUP, scripts: 'dev: node evil.mjs' })));

  button('Start QA').click();
  await settle();
  await settle();
  flushSync();

  expect(JSON.parse(posts()[0]?.[1]?.body as string)).toEqual({ key: 'APP-1', choice: 'dev', address: '', scripts: 'dev: node server.mjs' });
  expect(go).not.toHaveBeenCalled();
  expect(dialog.querySelector('[data-scripts]')?.textContent).toBe('dev: node evil.mjs');
});

it('saves nothing and moves nothing on Cancel the move', () => {
  const { dialog, button, go, stay, onclose } = draw();

  button('Cancel the move').click();
  flushSync();

  expect(dialog.open).toBe(false);
  expect(posts()).toEqual([]);
  expect(go).not.toHaveBeenCalled();
  expect(stay).toHaveBeenCalledOnce();
  expect(onclose).toHaveBeenCalledOnce();
});
