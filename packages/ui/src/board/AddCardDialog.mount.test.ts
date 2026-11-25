import type { BoardKind } from '@nolzu/protocol';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import AddCardDialog from './AddCardDialog.svelte';

type Made = { ok: true; key: string; note: string | null } | { ok: false; reason: string };

// jsdom has the element but not the modal half of it. This does what the browser does for the parts
// the dialog relies on: open, focus the autofocus field, and close with a close event.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
    this.querySelector<HTMLElement>('[autofocus]')?.focus();
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
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};

// No `off` given passes none, so the cases that leave it out read the dialog's own default.
function draw(onsubmit: (payload: unknown) => Promise<Made>, board: BoardKind = 'delivery', off?: BoardKind[]) {
  const onclose = vi.fn();
  page = mounted(AddCardDialog as never, { prefix: 'APP', board, off, onsubmit, onclose });
  const target = page.target;
  const field = target.querySelector<HTMLInputElement>('#card-input')!;
  const add = target.querySelector<HTMLButtonElement>('[data-add-card]')!;
  const type = (value: string) => {
    field.value = value;
    field.dispatchEvent(new Event('input'));
    flushSync();
  };
  const submit = () => {
    target.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    flushSync();
  };
  return { target, field, add, type, submit, onclose };
}

it('opens as a modal dialog with the field focused', () => {
  const ui = draw(async () => ({ ok: true, key: 'APP-4', note: null }));

  expect(ui.target.querySelector('dialog')?.open).toBe(true);
  expect(document.activeElement).toBe(ui.field);
});

// Each board's Add opens that board's form, titled as its button and asking for what it takes.
it.each([
  ['delivery', 'Add card', 'Title, or a link to a ticket or pull request', 'A GitHub issue or pull request link'],
  ['epics', 'Add epic', 'Epic title, or a link to a ticket', 'A GitHub issue or pull request link'],
  ['prreview', 'Add pull request', 'Pull request, as owner/repo#number or a link from GitHub', 'Type owner/repo#number, or paste the pull request link'],
] as const)('words the %s form as its board', (board, title, label, hint) => {
  const ui = draw(async () => ({ ok: true, key: 'APP-4', note: null }), board);

  expect(ui.target.querySelector('dialog h2')?.textContent).toBe(title);
  expect(ui.target.querySelector('label[for="card-input"]')?.textContent).toBe(label);
  expect(ui.target.querySelector('#card-reading')?.textContent?.replace(/\s+/g, ' ')).toContain(hint);
  expect(ui.add.textContent).toContain(title);
});

it('holds Add card on an empty field and sends nothing', () => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'APP-4', note: null }));
  const ui = draw(onsubmit);
  ui.type('   ');

  expect(ui.add.getAttribute('aria-disabled')).toBe('true');
  ui.submit();
  expect(onsubmit).not.toHaveBeenCalled();
});

it('says what the input becomes, in words, and asks for a description only for free text', () => {
  const ui = draw(async () => ({ ok: true, key: 'APP-4', note: null }));

  ui.type('Sort the list by time');
  expect(ui.target.textContent).toContain('A new local ticket with this title.');
  expect(ui.target.querySelector('#card-description')).not.toBeNull();

  ui.type('PROJ-123');
  expect(ui.target.textContent).toContain('cannot read that ticket system');
  expect(ui.target.querySelector('#card-description')).toBeNull();
});

it('sends the payload once and closes when the card is made', async () => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'APP-4', note: null }));
  const ui = draw(onsubmit);
  ui.type('Sort the list by time');

  ui.submit();
  ui.submit();
  await settle();

  expect(onsubmit).toHaveBeenCalledTimes(1);
  expect(onsubmit).toHaveBeenCalledWith({ input: 'Sort the list by time', title: 'Sort the list by time', description: '', board: 'delivery' });
  expect(ui.onclose).toHaveBeenCalled();
});

// The button sits in the dialog footer, outside the form, and reaches it through its form attribute.
it('sends the card from the Add card button in the footer', async () => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'APP-4', note: null }));
  const ui = draw(onsubmit);
  ui.type('Sort the list by time');

  expect(ui.add.form).toBe(ui.target.querySelector('form'));
  ui.add.click();
  await settle();

  expect(onsubmit).toHaveBeenCalledOnce();
  expect(ui.onclose).toHaveBeenCalled();
});

// A stray click on the backdrop closes the dialog, so what was typed waits in the page for the next
// open, and goes once the card is made.
it('keeps what was typed for the next open when it closes without a card', async () => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'APP-4', note: null }));
  let draft: unknown = null;
  const open = () => {
    const target = document.body.appendChild(document.createElement('div'));
    const instance = mount(AddCardDialog as never, {
      target,
      props: {
        prefix: 'APP',
        onsubmit,
        onclose: vi.fn(),
        get draft() {
          return draft;
        },
        set draft(next: unknown) {
          draft = next;
        },
      },
    });
    flushSync();
    const set = (selector: string, value: string) => {
      const field = target.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
      field.value = value;
      field.dispatchEvent(new Event('input'));
      flushSync();
    };
    const remove = () => {
      void unmount(instance);
      target.remove();
    };
    return { target, set, remove };
  };

  let ui = open();
  ui.set('#card-input', 'Sort the list by time');
  ui.set('#card-description', 'Newest first');
  ui.set('#card-extra', 'Ties keep their order.');
  ui.target.querySelector<HTMLButtonElement>('[data-closer]')!.click();
  ui.remove();

  ui = open();
  expect(ui.target.querySelector<HTMLInputElement>('#card-input')!.value).toBe('Sort the list by time');
  expect(ui.target.querySelector<HTMLTextAreaElement>('#card-description')!.value).toBe('Newest first');
  // The fold opens on kept extra context, so the person sees it is there.
  expect(ui.target.querySelector<HTMLDetailsElement>('details.fold')!.open).toBe(true);
  expect(ui.target.querySelector<HTMLTextAreaElement>('#card-extra')!.value).toBe('Ties keep their order.');
  ui.target.querySelector<HTMLButtonElement>('[data-add-card]')!.click();
  await settle();
  ui.remove();
  expect(onsubmit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Sort the list by time', extra: 'Ties keep their order.' }));

  ui = open();
  expect(ui.target.querySelector<HTMLInputElement>('#card-input')!.value).toBe('');
  ui.remove();
});

it('keeps the dialog open with the reason when the server refuses', async () => {
  const ui = draw(async () => ({ ok: false, reason: 'PROJ-123 is already on the board. Open that card, or use another key.' }));
  ui.type('PROJ-123');

  ui.submit();
  await settle();

  expect(ui.target.querySelector('[role="alert"]')?.textContent).toContain('already on the board');
  expect(ui.target.querySelector('dialog')?.open).toBe(true);
  expect(ui.add.getAttribute('aria-disabled')).not.toBe('true');
});

const ISSUE = 'Nolzu reads issue cook/recipes#42 from GitHub when you add the card.';

// The server reads every one of these through gh, and keys the card repo#42, which a run can use.
it.each(['cook/recipes#42', 'recipes#42', 'https://github.com/cook/recipes/pull/42'])('sends the pull request %j on the PR reviews board as typed, with no description to fill', async (reference) => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'recipes#42', note: null }));
  const board = 'prreview';
  const ui = draw(onsubmit, board);
  ui.type(reference);

  expect(ui.target.textContent).toContain('from GitHub when you add the card.');
  expect(ui.target.querySelector('#card-description')).toBeNull();
  expect(ui.add.getAttribute('aria-disabled')).toBeNull();
  ui.submit();
  await settle();

  expect(onsubmit).toHaveBeenCalledWith({ input: reference, board });
  expect(ui.onclose).toHaveBeenCalled();
});

// The server keys an issue card repo#12, like a pull request card, so it gets a checkout and runs.
it.each(['cook/recipes#12', 'recipes#12', 'https://github.com/cook/recipes/issues/12'])('sends the GitHub issue %j on Delivery as typed, with no description to fill', async (reference) => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'recipes#12', note: null }));
  const ui = draw(onsubmit);
  ui.type(reference);

  expect(ui.target.querySelector('#card-reading')?.textContent).toMatch(/^Nolzu reads issue (cook\/)?recipes#12 from GitHub when you add the card\./);
  expect(ui.target.querySelector('#card-description')).toBeNull();
  expect(ui.add.getAttribute('aria-disabled')).toBeNull();
  ui.submit();
  await settle();

  expect(onsubmit).toHaveBeenCalledWith({ input: reference, board: 'delivery' });
  expect(ui.onclose).toHaveBeenCalled();
});

// The server reads the number as an issue on Delivery, so a pull request link there is always refused.
it('holds a pull request link on Delivery and says where it goes', () => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'recipes#42', note: null }));
  const ui = draw(onsubmit);
  ui.type('https://github.com/cook/recipes/pull/42');

  expect(ui.target.querySelector('#card-reading')?.textContent).toBe('This link is a pull request. Add it on the PR reviews board.');
  expect(ui.add.getAttribute('aria-disabled')).toBe('true');
  ui.submit();
  expect(onsubmit).not.toHaveBeenCalled();
});

it('holds a pull request link while the PR reviews board is off and says where to turn it on', () => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'recipes#42', note: null }));
  const ui = draw(onsubmit, 'delivery', ['prreview']);
  ui.type('https://github.com/cook/recipes/pull/42');

  expect(ui.target.querySelector('#card-reading')?.textContent).toBe(
    'This link is a pull request, and the PR reviews board is off. Turn it on under Boards in Settings, Project at /settings/project, then add the link on the PR reviews board.',
  );
  expect(ui.add.getAttribute('aria-disabled')).toBe('true');
  ui.submit();
  expect(onsubmit).not.toHaveBeenCalled();
});

it('takes a GitHub number as a pull request on the PR reviews board and as an issue elsewhere', () => {
  let ui = draw(async () => ({ ok: true, key: 'recipes#42', note: null }));
  ui.type('cook/recipes#42');
  expect(ui.target.querySelector('#card-reading')?.textContent).toBe(ISSUE);
  expect(ui.add.getAttribute('aria-disabled')).toBeNull();
  page?.remove();

  ui = draw(async () => ({ ok: true, key: 'recipes#42', note: null }), 'prreview');
  ui.type('cook/recipes#42');
  expect(ui.target.querySelector('#card-reading')?.textContent).toBe('Nolzu reads pull request cook/recipes#42 from GitHub when you add the card.');
  expect(ui.add.getAttribute('aria-disabled')).toBeNull();
});

// What the server says when this machine has no gh, word for word, so the dialog adds nothing to it.
it('shows the server refusal when gh is missing, and stays open', async () => {
  const missing = 'gh is not on the PATH, so Nolzu cannot read GitHub. Install the GitHub CLI from https://cli.github.com, then start Nolzu again.';
  const ui = draw(async () => ({ ok: false, reason: missing }), 'prreview');
  ui.type('cook/recipes#42');

  ui.submit();
  await settle();

  expect(ui.target.querySelector('[role="alert"]')?.textContent).toBe(missing);
  expect(ui.target.querySelector('dialog')?.open).toBe(true);
});

// The board comes from the page the dialog opened on, so the dialog draws no Board or Kind control,
// and no Size control either: the chain is a tick on the card's Settings tab now.
it('sends the board it was given and draws no board, kind or size control', async () => {
  let sent: unknown = null;
  const ui = draw(async (payload) => {
    sent = payload;
    return { ok: true, key: 'APP-4', note: null };
  }, 'epics');
  ui.type('Sort the list');

  ui.submit();
  await settle();

  for (const control of ['#card-board', '#card-kind', '#card-size']) expect(ui.target.querySelector(control), control).toBeNull();
  expect(sent).toEqual({ input: 'Sort the list', title: 'Sort the list', description: '', board: 'epics' });
});

// Closing while the card is on its way would drop a refusal on a dialog that is gone.
it('stays open on Esc while the card is being sent', async () => {
  let answer: (made: Made) => void = () => undefined;
  const ui = draw(() => new Promise<Made>((resolve) => (answer = resolve)));
  ui.type('PROJ-123');
  ui.submit();

  const esc = new Event('cancel', { cancelable: true });
  ui.target.querySelector('dialog')!.dispatchEvent(esc);
  expect(esc.defaultPrevented).toBe(true);
  expect(ui.target.querySelector<HTMLButtonElement>('button.ghost')!.disabled).toBe(true);

  answer({ ok: false, reason: 'PROJ-123 is already on the board.' });
  await settle();
  const later = new Event('cancel', { cancelable: true });
  ui.target.querySelector('dialog')!.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});

const SOURCES = [{ key: 'APP-1', title: 'Add a search box', extra: 'Ties keep their order.' }];

function drawFull(onsubmit: (payload: unknown) => Promise<Made>) {
  const onclose = vi.fn();
  page = mounted(AddCardDialog as never, { prefix: 'APP', onsubmit, onclose, sources: async () => SOURCES });
  const target = page.target;
  const set = (selector: string, value: string, event = 'input') => {
    const field = target.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!;
    field.value = value;
    // Bubbling, because Svelte listens for change at the root.
    field.dispatchEvent(new Event(event, { bubbles: true }));
    flushSync();
  };
  const submit = () => {
    target.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    flushSync();
  };
  return { target, set, submit, onclose };
}

it('copies another card context into an empty field', async () => {
  const ui = drawFull(async () => ({ ok: true, key: 'APP-4', note: null }));
  await settle();

  ui.set('#card-copy', 'APP-1', 'change');

  expect(ui.target.querySelector<HTMLTextAreaElement>('#card-extra')!.value).toBe('Ties keep their order.');
});

it('asks before the copy replaces what the person typed, and keeps it on no', async () => {
  const ui = drawFull(async () => ({ ok: true, key: 'APP-4', note: null }));
  await settle();
  ui.set('#card-extra', 'My own note.');

  ui.set('#card-copy', 'APP-1', 'change');
  expect(ui.target.textContent).toContain('Replace your text with the context of APP-1?');
  ui.target.querySelector<HTMLButtonElement>('[data-keep-mine]')!.click();
  flushSync();

  expect(ui.target.querySelector<HTMLTextAreaElement>('#card-extra')!.value).toBe('My own note.');
});

it('replaces what the person typed once they say yes', async () => {
  const ui = drawFull(async () => ({ ok: true, key: 'APP-4', note: null }));
  await settle();
  ui.set('#card-extra', 'My own note.');
  ui.set('#card-copy', 'APP-1', 'change');

  ui.target.querySelector<HTMLButtonElement>('[data-replace]')!.click();
  flushSync();

  expect(ui.target.querySelector<HTMLTextAreaElement>('#card-extra')!.value).toBe('Ties keep their order.');
});

it('sends the context it was given', async () => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'APP-4', note: null }));
  const ui = drawFull(onsubmit);
  await settle();
  ui.set('#card-input', 'Sort the list');
  ui.set('#card-extra', 'Ties keep their order.');

  ui.submit();
  await settle();

  expect(onsubmit).toHaveBeenCalledWith(expect.objectContaining({ extra: 'Ties keep their order.' }));
  expect(onsubmit).toHaveBeenCalledWith(expect.not.objectContaining({ links: expect.anything() }));
});

// Nothing is written until the card is made, so a cancelled dialog leaves no card and no link.
it('sends nothing when the dialog is cancelled', async () => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'APP-4', note: null }));
  const ui = drawFull(onsubmit);
  await settle();
  ui.set('#card-input', 'Sort the list');

  ui.target.querySelector<HTMLButtonElement>('button.ghost')!.click();
  flushSync();

  expect(onsubmit).not.toHaveBeenCalled();
  expect(ui.onclose).toHaveBeenCalled();
});

it('sets the picker back after a copy, so the same card can be picked again', async () => {
  const ui = drawFull(async () => ({ ok: true, key: 'APP-4', note: null }));
  await settle();

  ui.set('#card-copy', 'APP-1', 'change');

  expect(ui.target.querySelector<HTMLSelectElement>('#card-copy')!.value).toBe('');
});

it('drops the question once the person types in the field again', async () => {
  const ui = drawFull(async () => ({ ok: true, key: 'APP-4', note: null }));
  await settle();
  ui.set('#card-extra', 'My own note.');
  ui.set('#card-copy', 'APP-1', 'change');

  ui.set('#card-extra', '');

  expect(ui.target.querySelector('.ask')).toBeNull();
});

// Focus goes to the question, so a screen reader reads it, and back to the field once it is answered.
it('moves focus to the question and back to the field', async () => {
  const ui = drawFull(async () => ({ ok: true, key: 'APP-4', note: null }));
  await settle();
  ui.set('#card-extra', 'My own note.');

  ui.set('#card-copy', 'APP-1', 'change');
  await settle();
  expect(document.activeElement).toBe(ui.target.querySelector('[data-replace]'));

  ui.target.querySelector<HTMLButtonElement>('[data-keep-mine]')!.click();
  await settle();
  expect(document.activeElement).toBe(ui.target.querySelector('#card-extra'));
});

// Add to Inbox with Cmd Enter, and Add and start with Shift Cmd Enter.
const starts = (phase: 'refine' | 'pr-review', more: Record<string, unknown> = {}) => ({ phase, model: 'haiku', effort: 'low', engine: 'claude-code', modelState: 'ok', refusal: null, ...more });
const stagesOf = (first: [string, string], next: [string, string, ReturnType<typeof starts>]) => [
  { id: first[0], label: first[1], role: 'you', count: 0, cadence: null, starts: null },
  { id: next[0], label: next[1], role: 'agent', count: 0, cadence: null, starts: next[2] },
];
const ESTIMATE = { costUsd: 0.048, lowMs: 60_000, highMs: 120_000, from: 'preset', runs: 0 };
const DELIVERY = { kind: 'delivery', stages: stagesOf(['inbox', 'Inbox'], ['refine', 'Refine', starts('refine', { estimate: ESTIMATE })]) };
const REVIEWS = { kind: 'prreview', stages: stagesOf(['incoming', 'Incoming'], ['pre-review', 'Agent pre-review', starts('pr-review')]) };

function drawStart(onsubmit: (payload: unknown) => Promise<Made>, more: Record<string, unknown> = {}) {
  const onclose = vi.fn();
  page = mounted(AddCardDialog as never, { prefix: 'APP', onsubmit, onclose, snapshots: [DELIVERY, REVIEWS], ...more });
  const target = page.target;
  const field = target.querySelector<HTMLInputElement>('#card-input')!;
  field.value = 'Sort recipes by rating';
  field.dispatchEvent(new Event('input'));
  flushSync();
  const press = (mods: KeyboardEventInit) => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mods }));
    flushSync();
  };
  return { target, field, press, onclose, go: () => target.querySelector<HTMLButtonElement>('[data-add-start]') };
}

it('names the column and the start, with the engine, model and measured estimate under the go button', () => {
  const ui = drawStart(async () => ({ ok: true, key: 'APP-21', note: null }));

  expect(ui.target.querySelector('[data-add-card]')?.textContent).toContain('Add to Inbox');
  expect(ui.target.textContent).toContain('Lands in Inbox. Nothing runs.');
  expect(ui.go()?.textContent).toContain('Add and start Refine');
  expect(ui.go()?.classList.contains('go')).toBe(true);
  expect(ui.target.querySelector('[data-start-line]')?.textContent).toBe('Claude Code · haiku · low · about $0.05');
  // Amber only where an agent starts.
  expect(ui.target.querySelectorAll('.go')).toHaveLength(1);
});

it('names the stage on a board whose first auto stage is not Refine, with no estimate where none was measured', () => {
  const ui = drawStart(async () => ({ ok: true, key: 'APP-21', note: null }), { board: 'prreview' });

  expect(ui.target.querySelector('[data-add-card]')?.textContent).toContain('Add to Incoming');
  expect(ui.go()?.textContent).toContain('Add and start Agent pre-review');
  expect(ui.target.querySelector('[data-start-line]')?.textContent).toBe('Claude Code · haiku · low');
});

it('offers no start before the board has a snapshot', () => {
  const ui = drawStart(async () => ({ ok: true, key: 'APP-21', note: null }), { snapshots: [] });

  expect(ui.go()).toBeNull();
  expect(ui.target.querySelector('[data-add-card]')?.textContent).toContain('Add card');
});

// Cmd Enter stays on Add to Inbox, so fast typing never starts a run.
it.each([{ metaKey: true }, { ctrlKey: true }])('adds the card on Cmd Enter and starts nothing: %j', async (mods) => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'APP-21', note: null }));
  const ui = drawStart(onsubmit);

  ui.press(mods);
  await settle();

  expect(onsubmit).toHaveBeenCalledOnce();
  expect(onsubmit.mock.calls[0]).toEqual([expect.not.objectContaining({ start: expect.anything() })]);
  expect(ui.onclose).toHaveBeenCalled();
});

it.each([{ metaKey: true }, { ctrlKey: true }])('adds and starts on Shift Cmd Enter: %j', async (mods) => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'APP-21', note: null }));
  const ui = drawStart(onsubmit);

  ui.press({ ...mods, shiftKey: true });
  await settle();

  expect(onsubmit).toHaveBeenCalledWith({ input: 'Sort recipes by rating', title: 'Sort recipes by rating', description: '', board: 'delivery', start: true });
});

// The press is held while the card is on its way, so a second one makes no second card and no second run.
it('sends one card for a double press of the go button and its keys', async () => {
  let answer: (made: Made) => void = () => undefined;
  const onsubmit = vi.fn(() => new Promise<Made>((resolve) => (answer = resolve)));
  const ui = drawStart(onsubmit);

  ui.go()!.click();
  ui.press({ metaKey: true, shiftKey: true });
  ui.go()!.click();
  ui.press({ metaKey: true });

  expect(onsubmit).toHaveBeenCalledOnce();
  expect(ui.go()?.getAttribute('aria-disabled')).toBe('true');
  expect(ui.target.querySelector<HTMLButtonElement>('[data-closer]')?.disabled).toBe(true);
  answer({ ok: true, key: 'APP-21', note: null });
  await settle();
  expect(ui.onclose).toHaveBeenCalledOnce();
});

it('holds the go button where the input makes no card', () => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'APP-21', note: null }));
  const ui = drawStart(onsubmit);
  ui.field.value = 'APP-3';
  ui.field.dispatchEvent(new Event('input'));
  flushSync();

  expect(ui.go()?.getAttribute('aria-disabled')).toBe('true');
  ui.go()!.click();
  ui.press({ metaKey: true, shiftKey: true });
  expect(onsubmit).not.toHaveBeenCalled();
});

// A refused start still adds the card. The page leaves the start out and raises the refusal.
it('says why the start would be refused, and still sends the press', async () => {
  const onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'APP-21', note: null }));
  const retired = { kind: 'delivery', stages: stagesOf(['inbox', 'Inbox'], ['refine', 'Refine', starts('refine', { model: 'claude-retired-1', modelState: 'gone' })]) };
  const ui = drawStart(onsubmit, { snapshots: [retired] });

  expect(ui.target.querySelector('[data-start-line]')?.textContent).toBe('Refine uses claude-retired-1, which Claude Code no longer offers. Pick another in Settings, Models.');
  expect(ui.target.querySelector('[data-start-line] code')?.textContent).toBe('claude-retired-1');
  // No agent starts from here, so no amber.
  expect(ui.go()?.classList.contains('go')).toBe(false);
  ui.go()!.click();
  await settle();
  expect(onsubmit).toHaveBeenCalledWith(expect.objectContaining({ start: true }));
});

// The key is asked for the board the dialog opened on, once, since there is no other board to pick.
it('shows the key the card will get beside the title', async () => {
  const next = vi.fn(async () => 'APP-21');
  const ui = drawStart(async () => ({ ok: true, key: 'APP-21', note: null }), { board: 'epics', next });
  await settle();

  expect(next).toHaveBeenCalledExactlyOnceWith('epics');

  expect(ui.target.querySelector('#card-key')?.textContent).toBe('becomes APP-21');
  ui.field.value = 'PROJ-123';
  ui.field.dispatchEvent(new Event('input'));
  flushSync();
  expect(ui.target.querySelector('#card-key')?.textContent).toBe('becomes PROJ-123');
  ui.field.value = 'APP-3';
  ui.field.dispatchEvent(new Event('input'));
  flushSync();
  expect(ui.target.querySelector('#card-key')?.textContent).toBe('');
});

it('offers the start of the board it opened on', () => {
  const ui = drawStart(async () => ({ ok: true, key: 'APP-21', note: null }), { board: 'prreview' });

  expect(ui.go()?.textContent).toContain('Add and start Agent pre-review');
});

it('folds the extra context, and opens it when a copy fills it', async () => {
  const ui = drawFull(async () => ({ ok: true, key: 'APP-4', note: null }));
  await settle();
  const fold = ui.target.querySelector<HTMLDetailsElement>('details.fold')!;

  expect(fold.open).toBe(false);
  expect(fold.querySelector('summary')?.textContent).toContain('Extra context');
  ui.set('#card-copy', 'APP-1', 'change');
  expect(fold.open).toBe(true);
});

// A Jira link pasted on a local project.
describe('a Jira link on a local project', () => {
  const LINK = 'https://you.atlassian.net/browse/PROJ-123';

  function drawJira(onconnect: ((form: unknown) => Promise<{ ok: true } | { ok: false; reason: string }>) | undefined, onsubmit = vi.fn(async (): Promise<Made> => ({ ok: true, key: 'APP-4', note: null }))) {
    page = mounted(AddCardDialog as never, { prefix: 'APP', onsubmit, onclose: vi.fn(), ...(onconnect === undefined ? {} : { onconnect }) });
    const target = page.target;
    const set = (selector: string, value: string) => {
      const field = target.querySelector<HTMLInputElement>(selector)!;
      field.value = value;
      field.dispatchEvent(new Event('input'));
      flushSync();
    };
    const press = (selector: string) => {
      target.querySelector<HTMLButtonElement>(selector)!.click();
      flushSync();
    };
    set('#card-input', LINK);
    return { target, set, press, onsubmit, offer: () => target.querySelector('[data-connect-jira]') };
  }

  it('offers Connect Jira and Keep it as a local card, with no amber', () => {
    const ui = drawJira(async () => ({ ok: true }));

    expect(ui.offer()?.textContent).toContain('That is a Jira ticket. Connect Jira to read its title and text into the card.');
    expect(ui.offer()?.textContent).toContain('Nothing is sent anywhere else.');
    expect([...ui.offer()!.querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(['Connect Jira', 'Keep it as a local card']);
    expect(ui.offer()?.querySelector('.go')).toBeNull();
    expect(ui.target.querySelector('#card-key')?.textContent).toBe('');
  });

  it('asks for the site, the email and the token, sends them, and reads the key from Jira after', async () => {
    const onconnect = vi.fn(async () => ({ ok: true as const }));
    const ui = drawJira(onconnect);

    ui.press('[data-connect]');
    await settle();
    const site = ui.target.querySelector<HTMLInputElement>('input[id$="-jira-site"]')!;
    expect(site.value).toBe('https://you.atlassian.net');
    expect(document.activeElement).toBe(site);
    const token = ui.target.querySelector<HTMLInputElement>('input[id$="-jira-token"]')!;
    // new-password, so a browser never fills in a saved login password as the token.
    expect([token.type, token.autocomplete]).toEqual(['password', 'new-password']);
    ui.set('input[id$="-jira-email"]', 'dana@example.com');
    ui.set('input[id$="-jira-token"]', 'ATATT3xFfGF0-recipe-token');

    ui.press('[data-connect]');
    await settle();

    expect(onconnect).toHaveBeenCalledWith({ site: 'https://you.atlassian.net', email: 'dana@example.com', token: 'ATATT3xFfGF0-recipe-token' });
    expect(ui.offer()).toBeNull();
    expect(document.activeElement).toBe(ui.target.querySelector('#card-input'));
    expect(ui.target.textContent).toContain('Nolzu reads PROJ-123 from Jira when you add the card.');
    expect(ui.target.querySelector('#card-key')?.textContent).toBe('becomes PROJ-123');
  });

  // A pasted link can come from anyone, and the token goes to the site in the box.
  it('fills in the site only for an Atlassian Cloud host', async () => {
    const ui = drawJira(async () => ({ ok: true }));
    ui.set('#card-input', 'https://you.atlassian.net.example.org/browse/PROJ-123');

    ui.press('[data-connect]');
    await settle();

    expect(ui.target.querySelector<HTMLInputElement>('input[id$="-jira-site"]')?.value).toBe('');
  });

  it('shows the refusal and keeps the fields when the connection is refused', async () => {
    const ui = drawJira(async () => ({ ok: false, reason: 'A Jira site address starts with https, so the API token is never sent in the clear.' }));

    ui.press('[data-connect]');
    await settle();
    ui.press('[data-connect]');
    await settle();

    expect(ui.offer()?.querySelector('[role="alert"]')?.textContent).toBe('A Jira site address starts with https, so the API token is never sent in the clear.');
    expect(ui.target.querySelector('input[id$="-jira-token"]')).not.toBeNull();
  });

  it('keeps it as a local card, and Add card sends the link for the server to read', async () => {
    const ui = drawJira(async () => ({ ok: true }));

    ui.press('[data-keep-local]');
    expect(ui.offer()).toBeNull();
    expect(document.activeElement).toBe(ui.target.querySelector('#card-input'));
    expect(ui.target.textContent).toContain('Added as it is, it becomes a local card titled PROJ-123, with the link in its text.');
    ui.target.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(ui.onsubmit).toHaveBeenCalledWith({ input: LINK, board: 'delivery' });
  });

  it('draws no offer for a page that gives no way to connect', () => {
    const ui = drawJira(undefined);

    expect(ui.offer()).toBeNull();
    expect(ui.target.textContent).toContain('a local card titled PROJ-123');
  });
});

// While the card is on its way only the pressed button says it is busy, and a second press sends nothing.
it('marks Add and start busy while it sends, not Add to Inbox, and sends once', async () => {
  let answer: (made: Made) => void = () => undefined;
  const onsubmit = vi.fn(() => new Promise<Made>((done) => (answer = done)));
  const ui = drawStart(onsubmit);

  ui.go()!.click();
  flushSync();
  ui.go()!.click();
  flushSync();

  expect(onsubmit).toHaveBeenCalledOnce();
  expect(ui.go()?.getAttribute('aria-busy')).toBe('true');
  expect(ui.target.querySelector('[data-add-card]')?.hasAttribute('aria-busy')).toBe(false);
  answer({ ok: false, reason: 'The card was refused.' });
  await settle();
  expect(ui.go()?.hasAttribute('aria-busy')).toBe(false);
});
