import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FREE } from '$lib/display.ts';
import { NO_TOASTS } from '$lib/board-page.ts';
import { nowLive } from '$lib/now-live.svelte.ts';
import { toastStack } from '$lib/toast-stack.svelte.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../test/stubs/app-paths.ts';
import Settings from './+page.svelte';

// Start Nolzu when I log in, pressed for real. The route stands in as a fake that keeps the item in
// `disk.item`, and a load run again reads it into the switch's data the way the real load reads the disk.
const disk = vi.hoisted(() => ({ item: false, login: { on: false, canTurnOn: true, path: '~/x' }, refuse: null as string | null }));
vi.mock('$app/navigation', () => ({
  goto: async () => {},
  invalidateAll: async () => {
    disk.login.on = disk.item;
  },
}));

const AGENTS = { slots: 2, timeoutMinutes: 30, quietMinutes: 5, keepAwake: false, waits: [] };

let target: HTMLElement;
let instance: object | null = null;
let posted: unknown[] = [];
let answer: (() => void) | null = null;
const settle = async () => {
  for (let round = 0; round < 5; round += 1) await tick();
  flushSync();
};

beforeEach(() => {
  drawnAt('/settings/runs');
  disk.item = false;
  disk.login.on = false;
  disk.refuse = null;
  posted = [];
  // Each press waits until the test answers it, so the switch can be read while the press goes.
  vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { on: boolean };
    posted.push([url, body]);
    return new Promise<Response>((done) => {
      answer = () => {
        if (disk.refuse === null) disk.item = body.on;
        done(disk.refuse === null ? Response.json({ ok: true }) : Response.json({ message: disk.refuse }, { status: 422 }));
      };
    });
  });
  target = document.body.appendChild(document.createElement('div'));
  const data = { section: 'runs', agents: AGENTS, login: disk.login, knowledge: { review: false }, models: null, engines: null, profiles: null, hub: null, display: FREE };
  instance = mount(Settings, { target, props: { data: data as never, form: null } });
});

afterEach(() => {
  nowLive.state = { snapshot: null, reconnecting: false, activity: {}, limits: {} };
  if (instance !== null) void unmount(instance);
  instance = null;
  target.remove();
  vi.unstubAllGlobals();
});

const box = () => target.querySelector<HTMLInputElement>('#startAtLogin')!;
const press = async () => {
  box().click();
  await settle();
};
const answered = async () => {
  answer?.();
  answer = null;
  await settle();
};

it('posts what the switch now says, keeps the focus while the press goes, and shows what the disk holds after', async () => {
  await settle();
  box().focus();

  await press();
  expect(posted).toEqual([['../api/login-item', { on: true }]]);
  expect(box().checked).toBe(true);
  expect(box().getAttribute('aria-disabled')).toBe('true');
  expect(box().disabled).toBe(false);
  expect(document.activeElement).toBe(box());

  // A second press while the first goes changes nothing and posts nothing.
  await press();
  expect(box().checked).toBe(true);
  expect(posted).toHaveLength(1);

  await answered();
  expect(disk.item).toBe(true);
  expect(box().checked).toBe(true);
  expect(box().getAttribute('aria-disabled')).toBeNull();
  expect(document.activeElement).toBe(box());

  await press();
  await answered();
  expect(posted.at(-1)).toEqual(['../api/login-item', { on: false }]);
  expect(disk.item).toBe(false);
  expect(box().checked).toBe(false);
});

it('springs back and says why when the press is refused', async () => {
  disk.refuse = 'Nolzu could not write the login item. EACCES.';
  await settle();

  await press();
  expect(box().checked).toBe(true);
  await answered();

  expect(box().checked).toBe(false);
  expect(target.querySelector('[role="alert"]')?.textContent).toBe('Nolzu could not write the login item. EACCES.');
});

// Runs: each control posts its own field to its own action.
// The `enhance` stub sends nothing, so each submit is caught here with the form data the browser posts.
it('posts each Runs control as its own setting', async () => {
  const sent: [string | null, Record<string, string>][] = [];
  target.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const fields = new FormData(form, (event as SubmitEvent).submitter);
    sent.push([form.getAttribute('action'), Object.fromEntries([...fields].map(([name, value]) => [name, String(value)]))]);
  });
  await settle();
  const field = (selector: string) => target.querySelector<HTMLInputElement>(selector)!;
  const typed = (selector: string, value: string) => {
    field(selector).value = value;
    field(selector).dispatchEvent(new Event('change', { bubbles: true }));
  };

  field('[aria-label="One slot more"]').click();
  field('[aria-label="One slot fewer"]').click();
  typed('#timeout', '45');
  field('#retry').click();
  typed('#quiet', '8');
  field('#keepAwake').click();
  field('#reviewKnowledge').click();

  expect(sent).toEqual([
    ['?/runs', { field: 'slots', value: '3' }],
    ['?/runs', { field: 'slots', value: '1' }],
    ['?/runs', { field: 'timeout', value: '45' }],
    ['?/runs', { field: 'retry', value: 'default' }],
    ['?/runs', { field: 'quiet', value: '8' }],
    ['?/runs', { field: 'keepAwake', value: 'on' }],
    ['?/knowledge', { field: 'reviewKnowledge', value: 'on' }],
  ]);
  // Start at login is no form: it goes through the login item route, never a settings row.
  expect(posted).toEqual([]);
});

// A switch that is off sends no value, which the server reads as off.
it('posts the retry and keep awake switches with no value when they go off', async () => {
  const sent: Record<string, string>[] = [];
  target.addEventListener('submit', (event) => {
    event.preventDefault();
    sent.push(Object.fromEntries([...new FormData(event.target as HTMLFormElement)].map(([name, value]) => [name, String(value)])));
  });
  await settle();

  target.querySelector<HTMLInputElement>('#retry')!.click();
  target.querySelector<HTMLInputElement>('#retry')!.click();

  expect(sent).toEqual([{ field: 'retry', value: 'default' }, { field: 'retry' }]);
});

// The busy meter beside the stepper reads the Now stream, never a click.
it('shows how many slots are busy off the stream, and nothing before it says', async () => {
  await settle();
  expect(target.textContent).not.toContain('agent slots busy');

  nowLive.state = { snapshot: { boards: [{ slots: { busy: 1, total: 2 } }] } as never, reconnecting: false, activity: {}, limits: {} };
  await settle();

  expect(target.textContent).toContain('1 of 2 agent slots busy');
});

// Only a profile answer prints a profile line: an answer from another section that shares a field
// name says none.
it.each([
  [{ section: 'engines', field: 'add', saved: true, id: 'codex-work' }, 'The profile is added as codex-work.'],
  [{ section: 'knowledge', field: 'remove', saved: true }, null],
])('prints a profile line only for a profile answer: %j', async (form, line) => {
  toastStack.state = NO_TOASTS;
  if (instance !== null) void unmount(instance);
  target.replaceChildren();
  const data = { section: 'engines', agents: null, login: disk.login, knowledge: null, models: null, engines: null, profiles: { rows: [], vendors: [] }, hub: null, display: FREE };
  instance = mount(Settings, { target, props: { data: data as never, form: form as never } });
  await settle();

  expect(toastStack.state.toasts).toEqual([]);
  if (line !== null) expect(target.textContent).toContain(line);
  else expect(target.textContent).not.toContain('The profile is');
});
