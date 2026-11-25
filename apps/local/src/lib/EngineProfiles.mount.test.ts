import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import EngineProfiles from './EngineProfiles.svelte';
import { limitBlock } from './engine-limits.ts';
import { type LoginCheck, type ProfileRow, type ProfilesSection, vendorChoice } from './engine-profiles.ts';

// The page's script, cut down: a submit hands the form data to the press's own callback, and the
// test answers each press when it wants to. Only the Check login form uses it.
type After = (input: { result: unknown }) => Promise<void>;
const pressed = vi.hoisted(() => [] as { id: string; answer: (result: unknown) => Promise<void> }[]);
vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, submit: (input: { formData: FormData }) => After) => {
    const on = (event: Event): void => {
      event.preventDefault();
      const formData = new FormData(form);
      const after = submit({ formData });
      pressed.push({ id: String(formData.get('id')), answer: (result) => after({ result }) });
    };
    form.addEventListener('submit', on);
    return { destroy: () => form.removeEventListener('submit', on) };
  },
}));

// Two vendors as the section hands them over, one that reads a config folder and one that reads
// none. Built by the real producer, so the fixture cannot drift away from what the screen gets.
const section: ProfilesSection = {
  rows: [],
  vendors: [vendorChoice('codex', []), vendorChoice('cursor', [])],
};

// One Codex profile on a folder of its own, as `profilesFor` hands it over.
const WORK: ProfileRow = {
  id: 'codex#work',
  label: 'Work',
  vendor: 'codex',
  configDir: '/home/you/.codex-work',
  vendorLabel: 'Codex',
  where: 'Nolzu sets CODEX_HOME to /home/you/.codex-work on every run of this profile.',
  limit: limitBlock('codex', undefined),
  plan: null,
  folder: '~/.codex-work',
  variable: 'CODEX_HOME',
  status: 'codex login status',
  signIn: 'CODEX_HOME=/home/you/.codex-work codex login',
};

let instance: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;

afterEach(() => {
  pressed.length = 0;
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
});

const open = (profiles: ProfilesSection = section, checked: LoginCheck | null = null, refusedAdd = false): HTMLElement => {
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(EngineProfiles, { target, props: { profiles, checked, refusedAdd } }) as Record<string, unknown>;
  flushSync();
  return target;
};

const pick = (root: HTMLElement, vendor: string) => {
  const select = root.querySelector<HTMLSelectElement>('#add-vendor')!;
  select.value = vendor;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
};

// A server render draws the form on the first vendor only, so the change is the one thing only a
// mounted component shows.
it('words the folder field for the vendor picked', () => {
  const root = open();
  expect(root.textContent).toContain('CODEX_HOME');

  pick(root, 'cursor');

  expect(root.querySelector('#add-dir')).not.toBeNull();
  expect(root.textContent).toContain('CURSOR_CONFIG_DIR');
});

it('says in the help beside Add profile that a second login needs its own folder', () => {
  const root = open();
  const help = root.querySelector<HTMLButtonElement>('button[aria-label="What a profile is"]')!;
  const text = document.getElementById(help.getAttribute('aria-describedby')!)?.textContent ?? '';

  expect(text).toContain('A second login of the same tool needs a config folder of its own');
});

// The page's script turns the press into a fetch. Here the submit itself is caught, which is the one
// way a check can start: no load, no effect and no timer submits the form.
it('runs no check until Check login is pressed, and then asks for that profile', () => {
  vi.useFakeTimers();
  const fetched = vi.spyOn(globalThis, 'fetch');
  const posted: { action: string; id: string }[] = [];
  const catchSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    posted.push({ action: form.getAttribute('action') ?? '', id: String(new FormData(form).get('id')) });
  };
  document.addEventListener('submit', catchSubmit);
  try {
    const root = open({ ...section, rows: [WORK] });
    vi.advanceTimersByTime(30 * 60_000);
    flushSync();

    expect(posted).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();

    root.querySelector<HTMLButtonElement>('button[aria-label="Check login of codex#work"]')!.click();

    expect(posted).toEqual([{ action: '?/login', id: 'codex#work' }]);
  } finally {
    document.removeEventListener('submit', catchSubmit);
    fetched.mockRestore();
    vi.useRealTimers();
  }
});

it('says which command a press runs before any check', () => {
  expect(open({ ...section, rows: [WORK] }).textContent).toContain('Runs codex login status for this folder.');
});

it('shows a signed out answer with the time and the sign-in line for that folder', () => {
  const root = open({ ...section, rows: [WORK] }, { id: 'codex#work', state: 'out', said: 'Not logged in', at: Date.UTC(2026, 9, 15, 14, 2) });
  const login = root.querySelector('[data-login]')!;

  expect(login.getAttribute('data-login')).toBe('out');
  expect(login.textContent).toContain('Signed out, checked');
  expect(login.textContent).toContain('Not logged in');
  expect(login.querySelector('code')?.textContent).toBe('CODEX_HOME=/home/you/.codex-work codex login');
});

it('shows no sign-in line under a signed in answer', () => {
  const root = open({ ...section, rows: [WORK] }, { id: 'codex#work', state: 'in', said: 'Logged in using ChatGPT', at: 0 });

  expect(root.querySelector('[data-login]')?.textContent).toContain('Signed in');
  expect(root.querySelector('[data-login] code')).toBeNull();
});

// Nolzu never signs in for the person: it shows the line to type, built from the folder as typed.
it('opens Add profile on the button, and shows the sign-in command for the folder typed', () => {
  const root = open();
  const form = root.querySelector<HTMLFormElement>('#add-profile')!;
  expect(form.hidden).toBe(true);

  root.querySelector<HTMLButtonElement>('button[aria-controls="add-profile"]')!.click();
  flushSync();
  expect(form.hidden).toBe(false);

  const folder = root.querySelector<HTMLInputElement>('#add-dir')!;
  folder.value = '/home/you/.codex-work';
  folder.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();

  expect(form.querySelector('code')?.textContent).toBe('CODEX_HOME=/home/you/.codex-work codex login');
});

// Two rows checked at once. Each press waits on its own answer, so the first answer must not end the
// second row's wait and let a second press start the same command again.
it('keeps a second row waiting when the first row answers', async () => {
  const root = open({ ...section, rows: [WORK, { ...WORK, id: 'codex#home', label: 'Home' }] });
  const button = (id: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="Check login of ${id}"]`)!;
  button('codex#work').click();
  button('codex#home').click();
  flushSync();
  expect(pressed.map((one) => one.id)).toEqual(['codex#work', 'codex#home']);

  await pressed[0]!.answer({ type: 'success', status: 200, data: { check: { id: 'codex#work', state: 'in', said: 'Logged in using ChatGPT', at: 0 } } });
  flushSync();

  expect(root.querySelector('[data-profile="codex#work"] [data-login]')?.getAttribute('data-login')).toBe('in');
  expect(button('codex#work').disabled).toBe(false);
  expect(button('codex#home').disabled).toBe(true);
  expect(root.querySelector('[data-profile="codex#home"]')?.textContent).toContain('Running codex login status');
});

// A refused add reloads the page, and the refusal is about the form, so the form is open to fix it.
it('opens Add profile again after a refused add', () => {
  expect(open(section, null, true).querySelector<HTMLFormElement>('#add-profile')!.hidden).toBe(false);
});
