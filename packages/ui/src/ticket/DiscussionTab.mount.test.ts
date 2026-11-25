import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import DiscussionTab from './DiscussionTab.svelte';

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

const thread = (id: string, label: string, sessionId: string | null) => ({
  id,
  kind: id === 'ask' ? 'ask' : 'phase',
  label,
  sessionId,
  engine: sessionId === null ? null : 'codex#work',
});

function draw(
  onsend: (thread: string, text: string, model: string) => Promise<string | null>,
  over: Record<string, unknown> = {},
) {
  page = mounted(DiscussionTab as never, {
    threads: [thread('plan', 'Plan', 's-2'), thread('ask', 'Ask', null)],
    current: 'plan',
    messages: [],
    models: ['haiku', 'sonnet'],
    phaseModel: 'opus',
    resume: "cd '/home/dev/recipes/worktrees/APP-1' && claude --resume 's-2'",
    next: 'ask-2',
    onsend,
    oncopy: async () => null,
    ...over,
  });
  const target = page.target;
  const field = target.querySelector('textarea')!;
  const button = target.querySelector<HTMLButtonElement>('[data-send-message]')!;
  const type = (value: string) => {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
  };
  return { target, button, field, type };
}

it.each(['', '   ', '\n\t'])('keeps Send held while the message is %j', (value) => {
  const onsend = vi.fn(async () => null);
  const ui = draw(onsend);
  ui.type(value);

  expect(ui.button.getAttribute('aria-disabled')).toBe('true');
  ui.button.click();
  expect(onsend).not.toHaveBeenCalled();
});

it('sends once and clears the box, so a double click does not send twice', async () => {
  const onsend = vi.fn(async () => null);
  const ui = draw(onsend);
  ui.type('use the other index');

  ui.button.click();
  ui.button.click();
  await settle();

  expect(onsend).toHaveBeenCalledTimes(1);
  expect(onsend).toHaveBeenCalledWith('plan', 'use the other index', '');
  expect(ui.field.value).toBe('');
  expect(ui.target.textContent).toContain('Waiting for the board');
});

it('sends the model picked for this message, and only for this message', async () => {
  const onsend = vi.fn(async () => null);
  const ui = draw(onsend);
  ui.target.querySelector<HTMLButtonElement>('[data-model="haiku"]')!.click();
  flushSync();
  // The chip names the pick, and the list folds once a model is picked.
  expect(ui.target.querySelector('#message-model summary')?.textContent).toBe('haiku');
  expect(ui.target.querySelector<HTMLDetailsElement>('#message-model')?.open).toBe(false);
  ui.type('try haiku');

  ui.button.click();
  await settle();

  expect(onsend).toHaveBeenCalledWith('plan', 'try haiku', 'haiku');
});

it('keeps the message in the box when the send is refused, and says why', async () => {
  const ui = draw(async () => 'APP-1 is running. Wait for the run to end, then send the message.');
  ui.type('go on');

  ui.button.click();
  await settle();

  expect(ui.target.textContent).toContain('Wait for the run to end');
  // Not cleared. The words are the person's, and a box that emptied on a refusal loses them.
  expect(ui.field.value).toBe('go on');
  expect(ui.button.getAttribute('aria-disabled')).not.toBe('true');
});

// A phase thread that kept no session cannot send, whatever is typed into it.
it('refuses to send from a phase thread with no session', () => {
  const onsend = vi.fn(async () => null);
  const ui = draw(onsend, { threads: [thread('refine', 'Refine', null)], current: 'refine' });
  ui.type('go on');

  ui.button.click();

  expect(onsend).not.toHaveBeenCalled();
  expect(ui.button.getAttribute('aria-disabled')).toBe('true');
});

// The ask thread is the other side: it takes a note and starts nothing.
it('sends a note from the ask thread', async () => {
  const onsend = vi.fn(async () => null);
  const ui = draw(onsend, { current: 'ask' });
  ui.type('ask the designer first');

  ui.button.click();
  await settle();

  expect(onsend).toHaveBeenCalledWith('ask', 'ask the designer first', '');
});

// The browser is where markdown is rendered, because DOMPurify needs a DOM. Both halves here: the
// markup arrives, and a script in a message written by somebody else's agent does not.
it('renders a message as markdown and drops the markup that is not safe', () => {
  draw(async () => null, {
    messages: [{ id: 1, author: 'agent', body: '**bold** <script>alert(1)</script>', at: '2026-09-24T10:00:00.000Z' }],
  });

  const html = page!.target.innerHTML;
  expect(html).toContain('<strong>bold</strong>');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('alert(1)');
});

// The page owns the clipboard. The button hands it the whole command and says what happened.
it('copies the resume command and says so, or says why not', async () => {
  const oncopy = vi.fn(async () => null);
  const ui = draw(async () => null, { oncopy });

  ui.target.querySelector<HTMLButtonElement>('[data-copy-resume]')!.click();
  await settle();

  expect(oncopy).toHaveBeenCalledWith("cd '/home/dev/recipes/worktrees/APP-1' && claude --resume 's-2'");
  expect(ui.target.textContent).toContain('Copied.');
  // Copied, so the command stays off the page.
  expect(ui.target.querySelector('code.command')).toBeNull();

  page?.remove();
  const refused = draw(async () => null, { oncopy: async () => 'The browser refused the clipboard.' });
  refused.target.querySelector<HTMLButtonElement>('[data-copy-resume]')!.click();
  await settle();
  expect(refused.target.textContent).toContain('The browser refused the clipboard.');
  // Refused, so the command is printed for a copy by hand.
  expect(refused.target.querySelector('code.command')?.textContent).toBe("cd '/home/dev/recipes/worktrees/APP-1' && claude --resume 's-2'");
});

// An Ask run takes no place on the board, so the line says where the answer comes, not that the board
// queues a run.
it('says the answer comes in the thread, not that the board queues a run', async () => {
  const ui = draw(async () => null, { current: 'ask' });
  ui.type('where does the list come from?');

  ui.button.click();
  await settle();

  expect(ui.target.textContent).toContain('Sent. The answer shows here when the run ends.');
  expect(ui.target.textContent).not.toContain('Waiting for the board');
});

// While the answer to the first message is not there, a press sends nothing and says why.
it('sends nothing while the Ask run goes, and says to wait for its answer', async () => {
  const onsend = vi.fn(async () => null);
  const ui = draw(onsend, { threads: [thread('ask', 'Ask', 'a-1')], current: 'ask', asking: true });
  ui.type('and who reads it?');

  ui.button.click();
  await settle();

  expect(onsend).not.toHaveBeenCalled();
  expect(ui.button.getAttribute('aria-disabled')).toBe('true');
  expect(ui.target.textContent).toContain('The agent is still answering. Wait for its answer, then send the next message.');
  expect(ui.field.value).toBe('and who reads it?');
});

// Send is held while the box is empty, and a press says why rather than doing nothing.
it('refuses an empty message with a sentence', () => {
  const onsend = vi.fn(async () => null);
  const ui = draw(onsend);
  ui.type('   ');

  ui.button.click();
  flushSync();

  expect(onsend).not.toHaveBeenCalled();
  expect(ui.target.textContent).toContain('The message is empty.');
});

// The refusal is about the empty box, so it goes once the person writes.
it('drops the empty sentence when the person types', () => {
  const ui = draw(vi.fn(async () => null));
  ui.type('   ');
  ui.button.click();
  flushSync();
  expect(ui.target.textContent).toContain('The message is empty.');

  ui.type('why?');
  flushSync();

  expect(ui.target.textContent).not.toContain('The message is empty.');
});

// The line promised an answer. Once the run ends and the answer is in, the line goes.
it('drops the sent line when the Ask run ends', async () => {
  const ui = draw(async () => null, { current: 'ask' });
  ui.type('where does the list come from?');
  ui.button.click();
  await settle();
  page!.set({ asking: true });
  expect(ui.target.textContent).toContain('Sent. The answer shows here');

  page!.set({ asking: false });

  expect(ui.target.textContent).not.toContain('Sent. The answer shows here');
});

// The tab opens on the newest message: a frame after it drew, as the router scrolls to the top first.
it('scrolls to the end of the thread a frame after it opens', async () => {
  const scrolled = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  draw(async () => null, { messages: [{ id: 1, author: 'agent', body: 'Done.', at: '2026-09-24T10:00:00.000Z' }] });
  expect(scrolled).not.toHaveBeenCalled();

  await new Promise((done) => requestAnimationFrame(() => done(null)));

  expect(scrolled).toHaveBeenCalledWith({ top: document.documentElement.scrollHeight });
  scrolled.mockRestore();
});

// The three dot menu: the button opens a menu of one item that takes the focus, Escape closes it and
// gives the focus back, and Rename edits the name in place and saves it on Enter.
it('renames an ask discussion from its menu, with the keyboard', async () => {
  const onrename = vi.fn(async () => null);
  const asked = { ...thread('ask', 'Ask', 'a-1'), count: 2, subject: 'Where the list comes from' };
  const ui = draw(async () => null, { threads: [thread('plan', 'Plan', 's-2'), asked], onrename });
  const frame = () => new Promise((done) => requestAnimationFrame(() => done(null)));
  const button = ui.target.querySelector<HTMLButtonElement>('#menu-button-ask')!;

  button.click();
  flushSync();
  await frame();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(button.getAttribute('aria-controls')).toBe('menu-ask');
  const item = ui.target.querySelector<HTMLButtonElement>('#menu-ask [role="menuitem"]')!;
  expect(document.activeElement).toBe(item);

  item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();
  expect(ui.target.querySelector('#menu-ask')).toBeNull();
  expect(button.hasAttribute('aria-controls')).toBe(false);
  expect(document.activeElement).toBe(button);

  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  flushSync();
  ui.target.querySelector<HTMLButtonElement>('[data-rename]')!.click();
  flushSync();
  await frame();
  const field = ui.target.querySelector<HTMLInputElement>('#rename-ask')!;
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe('Where the list comes from');
  field.value = 'Search plan';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();

  expect(onrename).toHaveBeenCalledWith('ask', 'Search plan');
  expect(ui.target.querySelector('#rename-ask')).toBeNull();
});

it('keeps the name box open and says why when the rename is refused', async () => {
  const asked = { ...thread('ask', 'Ask', 'a-1'), count: 2 };
  const ui = draw(async () => null, { threads: [asked], current: 'ask', onrename: async () => 'The name is over 80 characters.' });
  ui.target.querySelector<HTMLButtonElement>('#menu-button-ask')!.click();
  flushSync();
  ui.target.querySelector<HTMLButtonElement>('[data-rename]')!.click();
  flushSync();
  const field = ui.target.querySelector<HTMLInputElement>('#rename-ask')!;
  field.value = 'x';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();

  expect(ui.target.querySelector('#rename-ask')).not.toBeNull();
  expect(ui.target.textContent).toContain('The name is over 80 characters.');
});

// A send that throws lets Send go and says why, so it never stays busy for the life of the page.
it('lets Send go and says why when the send throws', async () => {
  const ui = draw(async () => {
    throw new Error('offline');
  });
  ui.type('go on');

  ui.button.click();
  await settle();

  expect(ui.button.hasAttribute('aria-busy')).toBe(false);
  expect(ui.target.textContent).toContain('The message could not be sent.');
  expect(ui.field.value).toBe('go on');
});
