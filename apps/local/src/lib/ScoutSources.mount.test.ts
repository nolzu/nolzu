import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { goto, invalidateAll } from '$app/navigation';
// The stub vitest aliases `$app/paths` to, by path, as the route tests import it.
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import ScoutSources from './ScoutSources.svelte';
import { type ScoutSourceRow, SOURCE_FORMS } from './scout-sources.ts';

// Where the dialog sends the page after a press, read off these two.
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}), invalidateAll: vi.fn(async () => {}) }));

// The Add a source dialog, with the real list of forms so the fixture cannot
// drift away from what the screen gets. The fetch stands in for the Scout page's form actions.

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

let instance: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;
let answer: unknown = { type: 'success', status: 200, data: {} };
const fetched = vi.fn<(url: string, init: { body: FormData }) => Promise<Response>>(async () => new Response(JSON.stringify(answer)));

beforeEach(() => {
  answer = { type: 'success', status: 200, data: {} };
  fetched.mockClear();
  vi.mocked(goto).mockClear();
  vi.mocked(invalidateAll).mockClear();
  vi.stubGlobal('fetch', fetched);
});

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
  vi.unstubAllGlobals();
});

// `page` stands in for the page that keeps the draft between two opens.
const open = (kind = '', row: ScoutSourceRow | null = null, page: { draft: unknown } | null = null) => {
  const onclose = vi.fn();
  target = document.body.appendChild(document.createElement('div'));
  const props = { forms: SOURCE_FORMS, kind, row, onclose };
  if (page !== null)
    Object.defineProperty(props, 'draft', {
      enumerable: true,
      get: () => page.draft,
      set: (next: unknown) => (page.draft = next),
    });
  instance = mount(ScoutSources as never, { target, props }) as Record<string, unknown>;
  flushSync();
  const root = target;
  const field = (name: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  const button = (name: string) => [...root.querySelectorAll('button')].find((one) => one.textContent?.replace(/\s+/g, ' ').trim().startsWith(name))!;
  return { root, field, button, onclose, dialog: root.querySelector('dialog')! };
};

const pick = (root: HTMLElement, form: string) => {
  const radio = root.querySelector<HTMLInputElement>(`input[type="radio"][value="${form}"]`)!;
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
};

const type = (input: HTMLInputElement | null, value: string) => {
  input!.value = value;
  input!.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

const settle = () => new Promise((done) => setTimeout(done, 0));

// A server render draws the form of one kind only, so the change is the one thing only a mounted
// dialog shows.
it('asks a Jira source for a token and a GitHub one for none', () => {
  const { root, field } = open();
  expect(field('secret')).toBeNull();

  pick(root, 'tickets-jira');
  expect(field('secret')).not.toBeNull();
  expect(field('site')).not.toBeNull();

  pick(root, 'tickets-github');
  expect(field('secret')).toBeNull();
  expect(field('repo')).not.toBeNull();
  expect(root.textContent).toContain('Nolzu runs gh');
});

// Two kinds that both ask for a token. Without the key on the fields the box keeps what was typed for
// the first one, and Add would store that token as the second source's.
it('empties the token box when the kind changes', () => {
  const { root, field } = open();

  pick(root, 'tickets-jira');
  field('secret')!.value = 'abc123notatoken';

  pick(root, 'sentry');

  expect(field('secret')?.value).toBe('');
});

it('names the keychain entry by kind and project while the project is typed', () => {
  const { root, field } = open('sentry');
  const entry = () => root.querySelector('[data-entry] code')?.textContent;
  expect(entry()).toBe('nolzu/sentry');

  type(field('project'), 'Recipes Web');

  expect(entry()).toBe('nolzu/sentry/recipes-web');
  expect(root.querySelector('[data-entry]')?.textContent).toContain('Sent only to Sentry, never to Nolzu cloud.');
});

// The read takes the form as it is, and the dialog stays open on it, so nothing typed is lost and
// nothing is stored.
it('tests the connection with the unsaved form, and keeps the dialog open on the answer', async () => {
  const { root, field, button, onclose, dialog } = open('sentry');
  type(field('org'), 'recipes-app');
  type(field('project'), 'recipes-web');
  type(field('secret'), 'abc123notatoken');
  answer = { type: 'success', status: 200, data: { field: 'test', readable: '12 issues readable', where: 'recipes-app/recipes-web', took: '0.8s' } };

  button('Test the connection').click();
  await settle();
  flushSync();

  expect(fetched).toHaveBeenCalledOnce();
  expect(fetched.mock.calls[0]?.[0]).toBe('?/test');
  const sent = fetched.mock.calls[0]![1].body;
  expect(Object.fromEntries(['form', 'org', 'project', 'secret'].map((name) => [name, sent.get(name)]))).toEqual({
    form: 'sentry',
    org: 'recipes-app',
    project: 'recipes-web',
    secret: 'abc123notatoken',
  });
  expect(root.querySelector('.said')?.textContent).toBe('12 issues readable');
  expect(root.querySelector('.took')?.textContent).toBe('recipes-app/recipes-web · 0.8s');
  expect(dialog.open).toBe(true);
  expect(onclose).not.toHaveBeenCalled();
});

it('keeps a refused add in the dialog, beside what was typed', async () => {
  const { root, field, button, onclose, dialog } = open('sentry');
  type(field('label'), 'The recipe app');
  answer = { type: 'failure', status: 400, data: { field: 'add', message: 'A Sentry source needs the organization.' } };

  button('Add and check now').click();
  await settle();
  flushSync();

  expect(fetched.mock.calls[0]?.[0]).toBe('?/scout');
  expect(root.querySelector('[role="alert"]')?.textContent).toBe('A Sentry source needs the organization.');
  expect(field('label')?.value).toBe('The recipe app');
  expect(dialog.open).toBe(true);
  expect(onclose).not.toHaveBeenCalled();
});

// "Add and check now" saves the source and checks it on the server, then the dialog closes and the
// page prints the answer under the strip.
it('adds and checks a new source with one press, and closes', async () => {
  const { field, button, onclose } = open('sentry');
  type(field('label'), 'The recipe app');

  button('Add and check now').click();
  await settle();

  const sent = fetched.mock.calls[0]![1].body;
  expect([sent.get('do'), sent.get('check'), sent.get('form')]).toEqual(['add', 'now', 'sentry']);
  expect(onclose).toHaveBeenCalledOnce();
});

// The dialog once claimed a source is checked on a timer and that its two opt-ins act. Neither is true.
it('says a check waits for Check now, and marks the two opt-ins not active yet', () => {
  const { root } = open();
  const said = root.textContent ?? '';

  expect(said).toContain('Scout checks it when you press Check now.');
  // Each switch says it is not active yet, so no help line repeats it under them.
  expect(said).not.toContain('A check never makes a card or starts a run');
  expect([...root.querySelectorAll('.swr')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
    'Create cards without asking not active yet',
    'Run a read-only assessment without asking not active yet',
  ]);
  // Pasted text has nothing to connect to, so it has no test and is only added.
  expect(root.querySelector('[data-test]')).toBeNull();
  expect(root.querySelector('[data-save]')?.textContent).toContain('Add');
  expect(root.querySelector('[data-save]')?.textContent).not.toContain('check now');
});

// A Sentry source on the strip, as the page hands it to the dialog.
const SENTRY_ROW: ScoutSourceRow = {
  id: 5,
  label: 'Sentry · recipes-web',
  form: SOURCE_FORMS.find((one) => one.id === 'sentry')!,
  values: { org: 'recipes-app', project: 'recipes-web' },
  enabled: true,
  createCards: false,
  autoAssess: false,
  schedule: { minutes: 0, notify: false, pick: '0', custom: '' },
  secretName: 'sentry-recipes-web-5-0123456789ab',
  checked: 'Not checked yet.',
  checkedAt: null,
  error: null,
};

// A remove takes the source's findings with it. On the page of one of them, reading that page again
// would answer 404, so the page goes to Scout's own address and prints the answer there.
it('goes to Scout after a remove, and reads the page again after a save', async () => {
  drawnAt('/scout/f/9');
  const { button, onclose } = open('', SENTRY_ROW);

  button('Remove').click();
  await settle();

  expect(fetched.mock.calls[0]![1].body.get('do')).toBe('remove');
  expect(onclose).toHaveBeenCalledOnce();
  expect(goto).toHaveBeenCalledWith('../../scout', { invalidateAll: true });
  expect(invalidateAll).not.toHaveBeenCalled();

  if (instance !== null) void unmount(instance);
  target?.remove();
  const again = open('', SENTRY_ROW);
  again.button('Save').click();
  await settle();

  expect(invalidateAll).toHaveBeenCalledOnce();
  expect(goto).toHaveBeenCalledOnce();
});

// The answer belongs to the form as it was pressed. A typed change takes it away, and a switch, which
// the read does not use, leaves it.
it('drops a test answer once a field it read is changed', async () => {
  const { root, field, button } = open('sentry');
  type(field('secret'), 'abc123notatoken');
  answer = { type: 'success', status: 200, data: { field: 'test', readable: '12 issues readable', where: 'recipes-app/recipes-web', took: '0.8s' } };
  button('Test the connection').click();
  await settle();
  flushSync();
  expect(root.querySelector('.said')?.textContent).toBe('12 issues readable');

  const toggle = field('createCards')!;
  toggle.checked = true;
  toggle.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(root.querySelector('.said')?.textContent).toBe('12 issues readable');

  type(field('project'), 'recipes-api');

  expect(root.querySelector('.said')).toBeNull();
});

// A press on the backdrop: jsdom lays nothing out, so the box is given a place first.
const backdrop = (dialog: HTMLDialogElement) => {
  dialog.getBoundingClientRect = () => ({ left: 100, top: 100, right: 300, bottom: 300, width: 200, height: 200, x: 100, y: 100, toJSON: () => ({}) });
  dialog.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }));
  dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 20, clientY: 20 }));
  flushSync();
};

const shut = () => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
};

// A stray click on the backdrop closes the dialog. What was typed waits in the page for the next open of
// the same source, without the token, and goes once the source is saved.
it('keeps what was typed for the next open when the backdrop closes it', async () => {
  const page = { draft: null as unknown };
  let ui = open('sentry', null, page);
  type(ui.field('label'), 'Prod errors');
  type(ui.field('org'), 'my-org');
  type(ui.field('secret'), 'abc123notatoken');
  const toggle = ui.field('createCards')!;
  toggle.checked = true;
  backdrop(ui.dialog);
  expect(ui.onclose).toHaveBeenCalledOnce();
  shut();

  ui = open('sentry', null, page);
  expect([ui.field('label')?.value, ui.field('org')?.value, ui.field('secret')?.value]).toEqual(['Prod errors', 'my-org', '']);
  expect(ui.field('createCards')?.checked).toBe(true);
  expect(ui.root.querySelector('[data-entry]')?.textContent).toContain('nolzu/sentry');
  shut();

  // Another kind opens as it always did, and the draft is that opening's from then on.
  ui = open('tickets-github', null, page);
  expect(ui.field('label')?.value).toBe('');
  backdrop(ui.dialog);
  shut();
  ui = open('sentry', null, page);
  expect(ui.field('label')?.value).toBe('');
  type(ui.field('label'), 'Prod errors');
  ui.button('Add and check now').click();
  await settle();
  expect(page.draft).toBeNull();
});

// The paste of a pasted source is typed text too.
it('keeps the paste of a pasted source when the backdrop closes it', () => {
  const page = { draft: null as unknown };
  const row: ScoutSourceRow = { ...SENTRY_ROW, id: 7, label: 'Pasted', form: SOURCE_FORMS.find((one) => one.kind === 'paste')!, values: {} };
  let ui = open('', row, page);
  const box = ui.root.querySelector<HTMLTextAreaElement>('textarea[name="text"]')!;
  box.value = 'TypeError: x is undefined';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  backdrop(ui.dialog);
  shut();

  ui = open('', row, page);
  expect(ui.root.querySelector<HTMLTextAreaElement>('textarea[name="text"]')?.value).toBe('TypeError: x is undefined');
  // Another source does not get it.
  shut();
  ui = open('', SENTRY_ROW, page);
  expect(ui.field('label')?.value).toBe(SENTRY_ROW.label);
});

// Check now holds from the press, and a page the browser brings back from its cache lets it go.
it('holds Check now after a press, and lets go when the page comes back from the cache', () => {
  const { root, button } = open('', SENTRY_ROW);
  const check = () => button('Check now');
  const form = check().closest('form')!;
  form.addEventListener('submit', (event) => event.preventDefault());

  check().click();
  flushSync();
  expect(check().getAttribute('aria-busy')).toBe('true');

  const back = new Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(back, 'persisted', { value: true });
  window.dispatchEvent(back);
  flushSync();
  expect(check().hasAttribute('aria-busy')).toBe(false);
  expect(root.contains(check())).toBe(true);
});
