import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import SetupGateDialog from './SetupGateDialog.svelte';

// The Learn dialog of Set up the project. Learn and then start sends the held move to the server,
// which starts it after the Learn runs. "I will write it myself" saves the mark, then sends the move the
// screen held back. A close sends nothing. The fetch stands in for the server.

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

const OFFER = { repos: [{ path: 'api', stub: true }, { path: 'web', stub: true }], starts: { engine: 'claude-code', model: 'haiku', effort: 'low', severalProfiles: false }, refusal: null };

let instance: object | null = null;
let target: HTMLElement | null = null;
const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { ok: true } : OFFER)));

beforeEach(() => {
  drawnAt('/b/delivery');
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

async function draw() {
  const go = vi.fn();
  const stay = vi.fn();
  const onclose = vi.fn();
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(SetupGateDialog, { target, props: { gate: { key: 'APP-1', to: 'refine', go, stay }, onclose } });
  await vi.waitFor(() => expect(target!.textContent).toContain('Learns 2 repositories'));
  flushSync();
  const dialog = target.querySelector<HTMLDialogElement>('dialog[data-setup-gate]')!;
  return { dialog, go, stay, onclose };
}

const posts = () => fetched.mock.calls.filter((call) => call[1]?.method === 'POST').map((call) => JSON.parse(String(call[1]?.body)));

it('shows the estimate line and what runs lack, before any press', async () => {
  const { dialog } = await draw();
  expect(dialog.textContent).toContain('then starts APP-1');
  expect(dialog.querySelector('.starts')?.textContent).toContain('haiku');
  expect(dialog.textContent).toContain('No estimate yet');
  expect(dialog.querySelector('[data-lacks]')?.textContent).toContain('Runs will not know what each repository is for');
  expect(posts()).toEqual([]);
});

it('"I will write it myself" saves the mark, then sends the held move', async () => {
  const { dialog, go, stay } = await draw();
  dialog.querySelector<HTMLButtonElement>('[data-write-myself]')!.click();
  await vi.waitFor(() => expect(go).toHaveBeenCalledOnce());
  expect(posts()).toEqual([{ step: 'learn', mark: 'self' }]);
  expect(stay).not.toHaveBeenCalled();
});

it('Learn and then start hands the move to the server, sends nothing itself and lets the screen go', async () => {
  const { dialog, go, stay } = await draw();
  dialog.querySelector<HTMLButtonElement>('[data-learn-then-start]')!.click();
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  expect(posts()).toEqual([{ then: { key: 'APP-1', to: 'refine' } }]);
  expect(go).not.toHaveBeenCalled();
  expect(stay).toHaveBeenCalledOnce();
});

it('lets the screen go on a close with no press', async () => {
  const { dialog, go, stay, onclose } = await draw();
  dialog.close();
  expect(stay).toHaveBeenCalledOnce();
  expect(onclose).toHaveBeenCalledOnce();
  expect(go).not.toHaveBeenCalled();
  expect(posts()).toEqual([]);
});
