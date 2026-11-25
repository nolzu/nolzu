import { Keyboard, scoped } from '@nolzu/ui';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FREE } from '$lib/display.ts';
import { pageKeys } from '$lib/page-keys.svelte.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../test/stubs/app-paths.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { page as state } from '../../../../../../test/stubs/app-state.ts';
import Page from './+page.svelte';

// The idea page mounted for real: the owner menu, the name check while typing, the gh wait, and ⌘↵.
const reload = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('$app/navigation', () => ({ goto: async () => undefined, invalidateAll: reload }));
// use:enhance as far as the page sees it: a submit runs the page's callback, and the answer never
// comes, so the page stays waiting.
const sent = vi.hoisted(() => ({ count: 0 }));
vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, submit: () => unknown) => {
    const on = (event: Event): void => {
      event.preventDefault();
      sent.count += 1;
      void submit();
    };
    form.addEventListener('submit', on);
    return { destroy: () => form.removeEventListener('submit', on) };
  },
}));

const DATA = {
  display: FREE,
  made: null,
  gh: Promise.resolve({ found: true, signedIn: true, account: 'you' }),
  owners: Promise.resolve({ owners: ['you', 'kitchen'] }),
  refine: 'about $0.03',
};

let target: HTMLElement;
let instance: object | null = null;
const said = () => (target.textContent ?? '').replace(/\s+/g, ' ');
const field = <T extends HTMLElement = HTMLInputElement>(selector: string) => target.querySelector<T>(selector)!;
const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};
const settle = async () => {
  for (let round = 0; round < 5; round += 1) await tick();
  flushSync();
};

beforeEach(() => {
  drawnAt('/new/idea');
  reload.mockClear();
  sent.count = 0;
  target = document.body.appendChild(document.createElement('div'));
});

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.url = new URL('http://localhost/');
});

const open = async (data: Record<string, unknown> = {}) => {
  instance = mount(Page, { target, props: { data: { ...DATA, ...data } as never, form: null } });
  await settle();
};

it('posts every field the action reads, with the owner menu on the account first', async () => {
  await open();

  const form = target.querySelector('form')!;
  expect(form.getAttribute('action')).toBe('?/create');
  expect([...form.querySelectorAll<HTMLInputElement>('[name]')].map((one) => one.name)).toEqual(['idea', 'name', 'folder', 'decided', 'owner', 'repo']);
  expect([...field<HTMLSelectElement>('select[name="owner"]').options].map((one) => one.value)).toEqual(['you', 'kitchen']);
  expect(field<HTMLSelectElement>('select[name="owner"]').value).toBe('you');
  expect(said()).toContain('Private');
  expect(said()).toContain('Created on GitHub with your gh login when you press the button. Only you can see it.');
});

// A private repository of an organisation is open to the people it lets in, not to the person alone.
it('says who can see the repository for the owner picked', async () => {
  await open();
  const menu = field<HTMLSelectElement>('select[name="owner"]');

  menu.value = 'kitchen';
  menu.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();

  expect(said()).toContain('Created on GitHub with your gh login when you press the button. Only people kitchen gives access to can see it.');
  expect(said()).not.toContain('Only you can see it.');
});

it('names the repository after the project until it is typed, and says the steps with those names', async () => {
  await open();
  const repo = field('input[name="repo"]');

  type(field('#name'), 'meal-planner');
  expect(repo.value).toBe('meal-planner');
  expect(said()).toContain('Nolzu creates github.com/you/meal-planner with a first commit, and clones it into ~/meal-planner.');
  expect(said()).toContain('It lands as PLAN-1 on the Epics board');

  type(repo, 'meals');
  type(field('#name'), 'dinners');
  expect(repo.value).toBe('meals');
  expect(said()).toContain('github.com/you/meals');
});

// New project's idea link carries the name and a typed folder, and the way back carries them again.
it('starts with the name and folder New project carried, and carries them back', async () => {
  state.url = new URL(`http://localhost/new/idea?name=${encodeURIComponent('Daily Habits')}&folder=${encodeURIComponent('~/nolzu/daily-habits')}`);
  await open();
  const back = () => target.querySelector('a.alt')!.getAttribute('href');

  expect(field('#name').value).toBe('Daily Habits');
  expect(field('#folder').value).toBe('~/nolzu/daily-habits');
  expect(field('#goes').textContent).toBe('Goes in ~/nolzu/daily-habits. Nolzu makes the folder if it is not there.');
  expect(said()).toContain('clones it into ~/nolzu/daily-habits.');
  expect(back()).toBe('../new?name=Daily+Habits&folder=%7E%2Fnolzu%2Fdaily-habits');

  type(field('#name'), 'Habits');
  type(field('#folder'), '~/code/habits');
  expect(back()).toBe('../new?name=Habits&folder=%7E%2Fcode%2Fhabits');
});

it('fills the folder from the name until it is typed in, and leaves it out of the way back meanwhile', async () => {
  await open();
  const back = () => target.querySelector('a.alt')!.getAttribute('href');
  expect(back()).toBe('../new');

  type(field('#name'), 'meal planner');
  expect(field('#folder').value).toBe('~/meal planner');
  expect(back()).toBe('../new?name=meal+planner');
});

it('shows Available once GitHub has no repository by the name, the sentence for one it has, and drops an old answer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (address: string) => {
    asked.push(address);
    const taken = address.endsWith('name=meal-planner');
    return { json: async () => ({ problem: taken ? 'github.com/you/meal-planner exists already. Pick another name, or add that repository by its URL.' : null }) };
  });
  await open();

  type(field('#name'), 'meal-planner');
  await vi.advanceTimersByTimeAsync(400);
  await settle();
  expect(said()).toContain('github.com/you/meal-planner exists already.');
  expect(said()).not.toContain('Available');

  type(field('input[name="repo"]'), 'meals');
  // Typing on before the pause ends asks once, for the name as it ends up.
  type(field('input[name="repo"]'), 'meals-app');
  await vi.advanceTimersByTimeAsync(400);
  await settle();
  expect(said()).toContain('Available');
  expect(said()).not.toContain('exists already');
  expect(asked).toEqual(['../api/gh/name?owner=you&name=meal-planner', '../api/gh/name?owner=you&name=meals-app']);

  // An answer is for one name: another name drops it until its own answer comes.
  type(field('input[name="repo"]'), 'meals-web');
  expect(said()).not.toContain('Available');
});

it('waits for gh auth login with Copy while gh is signed out, and reads the owners again once it is signed in', async () => {
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
  await open({ gh: Promise.resolve({ found: false, signedIn: false, account: null }), owners: Promise.resolve(null) });

  expect(said()).toContain('gh is not on this machine. Get it from cli.github.com, then sign in with this command in a terminal.');
  expect(said()).toContain('gh auth login Copy');
  expect(said()).toContain('This page moves on by itself once gh is signed in.');
  expect(target.querySelector('select')).toBeNull();

  await vi.advanceTimersByTimeAsync(2000);
  await settle();
  expect(reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  await settle();
  expect(reload).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(asked).toEqual(['../api/gh', '../api/gh']);
});

// Through the one key handler, as the root layout mounts it: the screen binds the global key.
it('presses the button on ⌘↵, from the idea box too', async () => {
  const sent: string[] = [];
  vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(function (this: HTMLFormElement) {
    sent.push(this.getAttribute('action') ?? '');
  });
  await open();
  const keys = document.body.appendChild(document.createElement('div'));
  const handler = mount(Keyboard, { target: keys, props: { keys: scoped('global'), get actions() { return pageKeys.now?.actions ?? {}; } } });
  try {
    const idea = field<HTMLTextAreaElement>('#idea');
    idea.focus();
    idea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));

    expect(sent).toEqual(['?/create']);
  } finally {
    void unmount(handler);
    keys.remove();
  }
});

// The answer waits for the push and the clone. requestSubmit sends a form past its disabled button,
// so a second ⌘↵ meanwhile would make a second request.
it('sends the form once while it waits, however often ⌘↵ is pressed', async () => {
  await open();
  const keys = document.body.appendChild(document.createElement('div'));
  const handler = mount(Keyboard, { target: keys, props: { keys: scoped('global'), get actions() { return pageKeys.now?.actions ?? {}; } } });
  try {
    const idea = field<HTMLTextAreaElement>('#idea');
    idea.focus();
    for (let press = 0; press < 3; press += 1) {
      idea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
      flushSync();
    }

    expect(sent.count).toBe(1);
    expect(said()).toContain('Creating the repository and the project');
  } finally {
    void unmount(handler);
    keys.remove();
  }
});
