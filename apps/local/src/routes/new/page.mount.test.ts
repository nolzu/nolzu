import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_INSTALLS, enginesOnPath } from '@nolzu/runner/detect';
import { Keyboard, scoped } from '@nolzu/ui';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FREE } from '$lib/display.ts';
import { pageKeys } from '$lib/page-keys.svelte.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../test/stubs/app-paths.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { page as state } from '../../../../../test/stubs/app-state.ts';
import Page from './+page.svelte';

// New project mounted for real: the parts that wait for git or a tool, the clone rows the stream
// draws, Browse, and ⌘↵. The stream is a stand-in the test feeds by hand.
class Source {
  static opened: Source[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    Source.opened.push(this);
  }
  close(): void {}
}

const tool = (engine: string, binary: string, version: string | null) => ({ engine, binary, found: version !== null, version, install: `https://example.com/${binary}`, error: null });
const DATA = {
  display: FREE,
  made: null,
  first: true,
  machine: Promise.resolve([
    { path: '~/code/web', url: 'https://example.com/team/web.git' },
    { path: '~/code/sketchbook', url: null },
  ]),
  engines: Promise.resolve([tool('claude-code', 'claude', '2.1.296'), tool('cursor', 'cursor-agent', null), tool('codex', 'codex', null)]),
  gh: Promise.resolve({ found: true, signedIn: true, account: 'you' }),
};

let target: HTMLElement;
let instance: object | null = null;
const said = () => (target.textContent ?? '').replace(/\s+/g, ' ');
const button = (name: string) => [...target.querySelectorAll('button')].find((one) => (one.getAttribute('aria-label') ?? one.textContent?.trim()) === name);
const settle = async () => {
  for (let round = 0; round < 5; round += 1) await tick();
  flushSync();
};

beforeEach(() => {
  drawnAt('/new');
  Source.opened = [];
  vi.stubGlobal('EventSource', Source);
  target = document.body.appendChild(document.createElement('div'));
});

afterEach(() => {
  state.url = new URL('http://localhost/');
  if (instance !== null) void unmount(instance);
  instance = null;
  target.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = async (data: Record<string, unknown> = {}) => {
  instance = mount(Page, { target, props: { data: { ...DATA, ...data } as never, form: null } });
  await settle();
};

it('names the tools found with their versions, the ones not found as links, and the gh login', async () => {
  await open();

  expect(said()).toContain('Claude Code 2.1.296');
  expect(said()).toContain('Cursor and Codex not found.');
  expect([...target.querySelectorAll('.x a')].map((link) => [link.getAttribute('aria-label'), link.getAttribute('href')])).toEqual([
    ['How to add Cursor', 'https://example.com/cursor-agent'],
    ['How to add Codex', 'https://example.com/codex'],
  ]);
  expect(said()).toContain('gh signed in as you');
  expect(said()).toContain('Used to open pull requests, which need a GitHub remote.');
});

it('offers Add for a repository on this machine with a remote, and none for one without', async () => {
  await open({ made: { path: '~/code/recipes', name: 'recipes', location: '~/code', repos: [] }, machine: Promise.resolve([...(await DATA.machine), { path: '~/code/recipes', url: null }]) });

  expect(button('Add ~/code/web')).toBeDefined();
  expect(target.querySelector('input[name="url"][value="https://example.com/team/web.git"]')).not.toBeNull();
  expect(said()).toContain('~/code/sketchbook no remote yet');
  expect(button('Add ~/code/sketchbook')).toBeUndefined();
  // The workspace being made is no repository to add.
  expect(said()).not.toContain('~/code/recipes no remote yet');
});

// A remote that is a row already, or a clone on its way, says so in place of a second Add.
it('shows a repository found on this machine as added once it is a row or a clone', async () => {
  await open({ made: { path: '~/dev/recipes', name: 'recipes', location: '~/dev', repos: [{ name: 'web', base: 'main', url: 'https://example.com/team/web.git', branches: [] }] } });
  expect(button('Add ~/code/web')).toBeUndefined();
  expect(target.querySelector('.machine .sg')?.textContent).toContain('added');
});

// The base picked in a row and not saved goes with Make the project, so pressing it first loses nothing.
it('sends a base picked and not saved with Make the project, and one per row only when it differs', async () => {
  const repos = [
    { name: 'web', base: 'main', url: 'https://example.com/team/web.git', branches: ['develop', 'main', 'release/1.2'] },
    { name: 'api', base: 'main', url: 'https://example.com/team/api.git', branches: ['develop', 'main'] },
  ];
  await open({ made: { path: '~/dev/recipes', name: 'recipes', location: '~/dev', repos } });
  const make = () => [...target.querySelectorAll<HTMLInputElement>('form.go input[type="hidden"]')].map((one) => [one.name, one.value]);
  expect(make()).toEqual([]);

  const select = target.querySelector<HTMLSelectElement>('select[aria-label="Base branch of web"]')!;
  select.value = 'release/1.2';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
  expect(make()).toEqual([['base:web', 'release/1.2']]);
});

// The box shows only when the look found a repository, with grey rows while it looks.
it('draws On this machine as grey rows while it looks, and not at all when it finds nothing', async () => {
  await open({ machine: new Promise(() => {}) });
  expect(said()).toContain('On this machine');
  expect(target.querySelector('.machine [data-skeleton]')?.textContent?.trim()).toBe('Looking for repositories.');
  unmount(instance!);
  instance = null;
  target.replaceChildren();

  await open({ machine: Promise.resolve([]) });
  expect(target.querySelector('.machine')).toBeNull();
  expect(said()).not.toContain('On this machine');
  unmount(instance!);
  instance = null;
  target.replaceChildren();

  // The workspace being made is the only one found, so there is nothing to add.
  await open({ made: { path: '~/code/recipes', name: 'recipes', location: '~/code', repos: [] }, machine: Promise.resolve([{ path: '~/code/recipes', url: null }]) });
  expect(target.querySelector('.machine')).toBeNull();
});

// A long name stays on one line, cut with an ellipsis, and says itself in full on hover.
it('keeps a repository name on one line with its full name in a title', async () => {
  const long = '~/code/a-very-long-hyphenated-repository-name-service';
  await open({ machine: Promise.resolve([{ path: long, url: 'https://example.com/team/a-very-long-hyphenated-repository-name-service.git' }]) });
  const name = [...target.querySelectorAll('.machine .rn')].find((one) => one.textContent === long)!;
  expect(name.getAttribute('title')).toBe(long);
  expect(target.querySelector('.machine .u')?.getAttribute('title')).toBe('https://example.com/team/a-very-long-hyphenated-repository-name-service.git');
});

// The push goes from a copy, and the row says before the click what stays behind.
it('offers Put on GitHub for a repository with no remote, and says which branches stay in the folder', async () => {
  await open();

  const put = button('Put ~/code/sketchbook on GitHub')!;
  expect(put.textContent?.trim()).toBe('Put on GitHub');
  expect(put.closest('form')?.getAttribute('action')).toBe('?/github');
  expect(put.closest('form')?.querySelector<HTMLInputElement>('input[name="path"]')?.value).toBe('~/code/sketchbook');
  expect(target.querySelector(`#${put.getAttribute('aria-describedby')}`)?.textContent).toBe('Pushes the branch you are on. Branches never pushed stay only in your folder.');
  expect(button('Put ~/code/web on GitHub')).toBeUndefined();
  expect(said()).toContain('A repository with no remote first goes to a new private GitHub repository. Your own folder stays as it is.');
});

it('shows gh auth login with Copy while gh is signed out, and moves on by itself once it is signed in', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const answers = [
    { found: true, signedIn: false, account: null },
    { found: true, signedIn: true, account: 'you' },
  ];
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (address: string) => {
    asked.push(address);
    return { json: async () => answers.shift() };
  });
  const copied: string[] = [];
  const was = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void copied.push(text) }, configurable: true });
  try {
    await open({ gh: Promise.resolve({ found: true, signedIn: false, account: null }) });

    expect(said()).toContain('gh is not signed in. Sign in with this command in a terminal. gh auth login Copy');
    expect(said()).toContain('This page moves on by itself once gh is signed in.');
    button('Copy gh auth login')!.click();
    await settle();
    expect(copied).toEqual(['gh auth login']);
    expect(target.querySelector('[role="status"]')?.textContent).toBe('Copied.');

    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(said()).toContain('gh is not signed in.');
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(said()).toContain('gh signed in as you');
    expect(said()).not.toContain('gh auth login');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toEqual(['./api/gh', './api/gh']);
  } finally {
    vi.useRealTimers();
    if (was === undefined) Reflect.deleteProperty(navigator, 'clipboard');
    else Object.defineProperty(navigator, 'clipboard', was);
  }
});

it('asks for the gh login again only while gh is not signed in', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (address: string) => {
    asked.push(address);
    return { json: async () => ({ found: false, signedIn: false, account: null }) };
  });
  try {
    await open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it('draws each clone from the stream, with its progress and Stop, and the reason of one that failed', async () => {
  await open();
  expect(Source.opened.map((source) => source.url)).toEqual(['./api/clones']);

  Source.opened[0]!.onmessage?.({
    data: JSON.stringify([
      { id: '1', name: 'web', url: 'https://example.com/team/web.git', state: 'cloning', progress: { step: 'Receiving objects', percent: 64 }, said: null },
      { id: '2', name: 'api', url: 'https://example.com/team/api.git', state: 'failed', progress: null, said: 'Could not read from the remote.' },
    ]),
  });
  flushSync();

  expect(said()).toContain('web https://example.com/team/web.git cloning 64%');
  expect(target.querySelector<HTMLElement>('.bar i')?.style.width).toBe('64%');
  expect(button('Stop cloning web')).toBeDefined();
  expect(said()).toContain('Could not read from the remote.');
  expect(button('Stop cloning api')).toBeUndefined();
  // A failed clone counts for nothing.
  expect(target.querySelector('h2 .n')?.textContent).toBe('1');

  // An added clone is a row of the list once the page reads it again, and its job stays in memory, so
  // a repository removed later does not come back as a job.
  Source.opened[0]!.onmessage?.({ data: JSON.stringify([{ id: '1', name: 'web', url: 'https://example.com/team/web.git', state: 'added', progress: null, said: 'Added web, starting from main.' }]) });
  flushSync();
  expect(target.querySelectorAll('.rp[data-state]')).toHaveLength(0);
  expect(target.querySelector('h2 .n')?.textContent).toBe('0');
});

it('picks the folder from the folders Browse lists, with the name inside it once one is typed', async () => {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (address: string) => {
    asked.push(address);
    const body = address.includes('?path=') ? { path: '/home/you/code', parent: '/home/you', folders: [] } : { path: '/home/you', parent: null, folders: ['code', 'notes'] };
    return { json: async () => body };
  });
  await open();

  button('Browse')!.click();
  await settle();
  expect([...target.querySelectorAll('.browser li button')].map((one) => one.textContent)).toEqual(['code', 'notes']);
  button('code')!.click();
  await settle();
  button('Use this folder')!.click();
  flushSync();

  expect(asked).toEqual(['./api/folders', `./api/folders?path=${encodeURIComponent('/home/you/code')}`]);
  expect(target.querySelector<HTMLInputElement>('#folder')?.value).toBe('/home/you/code');
  expect(target.querySelector('.browser')).toBeNull();

  type(target.querySelector<HTMLInputElement>('#name')!, 'recipes');
  button('Browse')!.click();
  await settle();
  button('code')!.click();
  await settle();
  button('Use this folder')!.click();
  flushSync();
  expect(target.querySelector<HTMLInputElement>('#folder')?.value).toBe('/home/you/code/recipes');
});

const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const idea = () => target.querySelector('a.alt')!.getAttribute('href');

// The folder is the project's own. It follows the name until the person types in it.
it('fills the folder from the name until it is typed in, and says where it goes', async () => {
  await open();
  const folder = target.querySelector<HTMLInputElement>('#folder')!;
  expect(target.querySelector('label[for="folder"]')?.textContent).toBe('Folder');
  expect(target.querySelector('#goes')).toBeNull();

  type(target.querySelector<HTMLInputElement>('#name')!, 'Daily Habits');
  expect(folder.value).toBe('~/Daily Habits');
  expect(target.querySelector('#goes')?.textContent).toBe('Goes in ~/Daily Habits. Nolzu makes the folder if it is not there.');
  expect(folder.getAttribute('aria-describedby')).toBe('goes');
  expect([...target.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="folder"]')].map((one) => one.value)).toContain('~/Daily Habits');
  // Still following the name, so only the name goes along.
  expect(idea()).toBe('./new/idea?name=Daily+Habits');

  type(folder, 'nolzu/./daily-habits/');
  type(target.querySelector<HTMLInputElement>('#name')!, 'Habits');
  expect(folder.value).toBe('nolzu/./daily-habits/');
  expect(target.querySelector('#goes')?.textContent).toBe('Goes in ~/nolzu/daily-habits. Nolzu makes the folder if it is not there.');
  expect(idea()).toBe(`./new/idea?name=Habits&folder=${encodeURIComponent('nolzu/./daily-habits/')}`);
});

// The idea page's way back carries what was typed there.
it('starts with the name and folder the idea page carried back', async () => {
  state.url = new URL(`http://localhost/new?name=${encodeURIComponent('Daily Habits')}&folder=${encodeURIComponent('~/nolzu/daily-habits')}`);
  await open();

  expect(target.querySelector<HTMLInputElement>('#name')?.value).toBe('Daily Habits');
  expect(target.querySelector<HTMLInputElement>('#folder')?.value).toBe('~/nolzu/daily-habits');
  expect(idea()).toBe('./new/idea?name=Daily+Habits&folder=%7E%2Fnolzu%2Fdaily-habits');
});

// Through the one key handler, as the root layout mounts it: the screen binds the global key.
it('presses Make the project on ⌘↵ and on Ctrl+↵, from a field too', async () => {
  const sent: string[] = [];
  vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(function (this: HTMLFormElement) {
    sent.push(this.getAttribute('action') ?? '');
  });
  await open();
  const keys = document.body.appendChild(document.createElement('div'));
  const handler = mount(Keyboard, { target: keys, props: { keys: scoped('global'), get actions() { return pageKeys.now?.actions ?? {}; } } });
  try {
    const name = target.querySelector<HTMLInputElement>('#name')!;
    name.focus();
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(sent).toEqual(['?/make', '?/make']);
  } finally {
    void unmount(handler);
    keys.remove();
  }
});

// No agent tool yet. `/api/tools` stands in as the scan it runs, over a fake PATH of one temp folder,
// so no real claude, codex or cursor-agent is found or started.
const fakePath = () => {
  const bin = mkdtempSync(join(tmpdir(), 'nolzu-new-path-'));
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (address: string) => {
    asked.push(address);
    return { json: async () => (address === './api/tools' ? enginesOnPath(bin) : { found: true, signedIn: true, account: 'you' }) };
  });
  return { bin, asked, done: () => rmSync(bin, { recursive: true, force: true }) };
};

it('asks for an agent tool first, and moves on by itself once claude lands on the PATH', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const path = fakePath();
  const ran = join(path.bin, 'ran');
  try {
    await open({ tools: ENGINE_INSTALLS });

    expect(said()).toContain('Nolzu needs one agent tool to run cards');
    expect(said()).toContain('Install one and log in with your own account. This page moves on by itself.');
    expect([...target.querySelectorAll('.inst')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Claude Code npm install -g @anthropic-ai/claude-code',
      'Codex CLI npm install -g @openai/codex',
      'Cursor CLI Install page',
    ]);
    expect(target.querySelector('.inst a')?.getAttribute('href')).toBe('https://cursor.com/cli');
    expect(said()).toContain('Watching Looking on your PATH every 2 seconds. Last look 0s ago.');
    expect(target.querySelector('#name')).toBeNull();
    expect(said()).not.toContain('Make the project');

    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(path.asked).toEqual(['./api/tools']);
    expect(said()).toContain('Last look 1s ago.');
    expect(target.querySelector('#name')).toBeNull();

    writeFileSync(join(path.bin, 'claude'), `#!/bin/sh\ntouch '${ran}'\n`);
    chmodSync(join(path.bin, 'claude'), 0o755);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();

    expect(said()).not.toContain('Nolzu needs one agent tool');
    expect(target.querySelector('#name')).not.toBeNull();
    expect(said()).toContain('Make the project');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(path.asked).toEqual(['./api/tools', './api/tools']);
    expect(existsSync(ran)).toBe(false);
  } finally {
    vi.useRealTimers();
    path.done();
  }
});

// Where the wall cannot start, Cursor runs Implement only, so it does not move the page on; Codex does.
it('holds for Claude Code or Codex where the wall cannot start, and says why', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const path = fakePath();
  const bwrap = 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.';
  try {
    writeFileSync(join(path.bin, 'cursor-agent'), '#!/bin/sh\n', { mode: 0o755 });
    await open({ tools: ENGINE_INSTALLS, everyPhase: { engines: ['claude-code', 'codex'], wallProblem: bwrap }, found: ['cursor'] });

    expect([...target.querySelectorAll('.inst')].map((row) => row.querySelector('.chip')?.textContent ?? null)).toEqual(['runs every phase here', 'runs every phase here', null]);
    expect(target.querySelector('.why')?.textContent).toBe(`Cursor cannot run every phase on this machine. Install Claude Code or Codex to go on, or make Nolzu's wall start so any engine can: ${bwrap}`);

    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(path.asked).toEqual(['./api/tools']);
    expect(said()).toContain('Nolzu needs one agent tool to run cards');

    writeFileSync(join(path.bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(said()).not.toContain('Nolzu needs one agent tool');
    expect(target.querySelector('#name')).not.toBeNull();
  } finally {
    vi.useRealTimers();
    path.done();
  }
});

it('copies the install command a row shows', async () => {
  const path = fakePath();
  const copied: string[] = [];
  const was = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void copied.push(text) }, configurable: true });
  try {
    await open({ tools: ENGINE_INSTALLS });

    for (const name of ['Claude Code', 'Codex CLI']) {
      const copy = button(`Copy the ${name} install command`)!;
      copy.click();
      await settle();
      expect(copied.at(-1)).toBe(copy.closest('.inst')?.querySelector('code')?.textContent);
    }
    expect(copied).toEqual(['npm install -g @anthropic-ai/claude-code', 'npm install -g @openai/codex']);
    expect(target.querySelector('[role="status"]')?.textContent).toBe('Copied.');
  } finally {
    if (was === undefined) Reflect.deleteProperty(navigator, 'clipboard');
    else Object.defineProperty(navigator, 'clipboard', was);
    path.done();
  }
});

it('stops looking on the PATH when the page closes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const path = fakePath();
  try {
    await open({ tools: ENGINE_INSTALLS });
    await vi.advanceTimersByTimeAsync(2000);
    expect(path.asked).toEqual(['./api/tools']);

    void unmount(instance!);
    instance = null;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(path.asked).toEqual(['./api/tools']);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    path.done();
  }
});

// The head says "no account" only while no account is signed in, which is no verified display
// document. The name field has no hint under it: the lede says a project is one folder.
it('ends the plan line with no account while none is signed in, and draws no hint under the name', async () => {
  await open();
  expect(target.querySelector('.top .plan')?.textContent).toBe('Free · runs on this machine only · no account');
  expect(said()).not.toContain('Nolzu makes');
  expect(said()).toContain('A project needs at least one repository.');
  // Free holds every project, so no line names a limit.
  expect(said()).not.toContain('Free keeps one project');
  unmount(instance!);
  instance = null;
  target.replaceChildren();

  await open({ display: { ...FREE, id: 'acct-1' } });
  expect(target.querySelector('.top .plan')?.textContent).toBe('Free · runs on this machine only');
  unmount(instance!);
  instance = null;
  target.replaceChildren();

  // A paid plan is no Free, so the line goes.
  await open({ display: { ...FREE, id: 'acct-1', plan: 'solo', features: ['cloud-board'] } });
  expect(target.querySelector('.top .plan')).toBeNull();
});

// A later project before its first Add: no rail, so the logo leads back. The first run has nowhere to go back to.
it('links the logo back to Now on a later project before its first Add, and not on the first run', async () => {
  await open({ first: false });
  expect(target.querySelector('a.home')?.getAttribute('aria-label')).toBe('Back to Now');
  unmount(instance!);
  instance = null;
  target.replaceChildren();

  await open();
  expect(target.querySelector('a.home')).toBeNull();
});
