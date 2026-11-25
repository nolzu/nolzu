import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import Overview from './Overview.svelte';

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

function draw(onsave: (text: string) => Promise<string | null>, onunlink: (key: string) => Promise<string | null> = async () => null) {
  page = mounted(Overview as never, { summary: null, changesHref: '/t/APP-1/changes', ticket: null, extra: 'old', related: [{ key: 'APP-2', title: 'Sort' }], onsave, onunlink });
  return page.target;
}

it('saves the extra context as typed, once per press', async () => {
  const onsave = vi.fn(async () => null);
  const target = draw(onsave);
  const field = target.querySelector('textarea')!;
  field.value = 'Keep the old page.';
  field.dispatchEvent(new Event('input'));
  target.querySelector<HTMLButtonElement>('[data-save-context]')!.click();
  await settle();

  expect(onsave).toHaveBeenCalledTimes(1);
  expect(onsave).toHaveBeenCalledWith('Keep the old page.');
  expect(target.querySelector('[data-context-status]')?.textContent).toContain('Saved');
});

it('shows the sentence the save was refused with', async () => {
  const target = draw(async () => 'The extra context is over 64 kB, which is the limit.');
  target.querySelector<HTMLButtonElement>('[data-save-context]')!.click();
  await settle();

  expect(target.querySelector('[data-context-status]')?.textContent).toContain('over 64 kB');
});

it('removes a related card through the page', async () => {
  const onunlink = vi.fn(async () => null);
  const target = draw(async () => null, onunlink);
  target.querySelector<HTMLButtonElement>('[aria-label="Remove the link to APP-2"]')!.click();
  await settle();

  expect(onunlink).toHaveBeenCalledWith('APP-2');
});

it('sends one removal for two quick clicks', async () => {
  let done = () => {};
  const onunlink = vi.fn(() => new Promise<string | null>((resolve) => (done = () => resolve(null))));
  const target = draw(async () => null, onunlink);
  const button = target.querySelector<HTMLButtonElement>('[aria-label="Remove the link to APP-2"]')!;
  button.click();
  button.click();
  done();
  await settle();

  expect(onunlink).toHaveBeenCalledTimes(1);
});

// The run that was answered can ask again before the page reloads. The new question gets a composer
// of its own, and not the busy one left from the first send.
it('starts a fresh composer when a new run asks', async () => {
  page = mounted(Overview as never, {
    summary: null, changesHref: '/t/APP-1/changes', ticket: null, extra: null, related: [],
    blocked: { runId: 4, question: 'Titles only?', sessionId: 'e93a6d12-8b4f-4c07-a2d5-6f1e0c9b8a03' },
    onanswer: async () => null,
  });
  const field = page.target.querySelector<HTMLTextAreaElement>('#answer')!;
  field.value = 'Titles only.';
  field.dispatchEvent(new Event('input'));
  flushSync();
  page.target.querySelector<HTMLButtonElement>('[data-send-answer]')!.click();
  await settle();
  expect(page.target.querySelector('[data-send-answer]')?.getAttribute('aria-busy')).toBe('true');

  page.set({ blocked: { runId: 5, question: 'Sorted how?', sessionId: 'e93a6d12-8b4f-4c07-a2d5-6f1e0c9b8a03' } });

  expect(page.target.querySelector('[data-send-answer]')?.getAttribute('aria-busy')).not.toBe('true');
  expect(page.target.querySelector<HTMLTextAreaElement>('#answer')!.value).toBe('');
});

// A press fills the answer and nothing goes until Send. The send is the person's, with their edits.
it('fills the answer from a pressed option and sends nothing until Send', async () => {
  const onanswer = vi.fn(async () => null);
  page = mounted(Overview as never, {
    summary: null, changesHref: '/t/APP-1/changes', ticket: null, extra: null, related: [],
    blocked: {
      runId: 4,
      question: 'Stars or thumbs?',
      sessionId: 'e93a6d12-8b4f-4c07-a2d5-6f1e0c9b8a03',
      options: [{ label: '1 to 5 stars', means: 'A new column in recipes, one migration' }, { label: 'Thumbs up and down', means: 'Reuses the likes table, no migration' }],
    },
    onanswer,
  });
  const field = page.target.querySelector<HTMLTextAreaElement>('#answer')!;
  const [, thumbs] = page.target.querySelectorAll<HTMLButtonElement>('[aria-label="Answers the agent offered"] button');

  thumbs!.click();
  flushSync();
  await settle();

  expect(field.value).toBe('Thumbs up and down');
  expect(thumbs!.getAttribute('aria-pressed')).toBe('true');
  expect(onanswer).not.toHaveBeenCalled();

  page.target.querySelector<HTMLButtonElement>('[data-send-answer]')!.click();
  await settle();
  expect(onanswer).toHaveBeenCalledTimes(1);
  expect(onanswer).toHaveBeenCalledWith('Thumbs up and down');
});

it('draws no answer buttons for a plain question', () => {
  page = mounted(Overview as never, {
    summary: null, changesHref: '/t/APP-1/changes', ticket: null, extra: null, related: [],
    blocked: { runId: 4, question: 'Titles only?', sessionId: 'e93a6d12-8b4f-4c07-a2d5-6f1e0c9b8a03' },
    onanswer: async () => null,
  });

  expect(page.target.querySelector('[role="group"]')).toBeNull();
  expect(page.target.querySelector('#answer')).not.toBeNull();
});

// A folded block opens with one press of a real button, so Enter and Space work as on any button, and
// a second press folds it again. The preview shows only while it is folded.
it('opens the folded ticket with one press of its button, and folds it again', () => {
  page = mounted(Overview as never, { summary: null, changesHref: null, extra: null, related: [], ticket: 'The list has no search.' });
  const button = page.target.querySelector<HTMLButtonElement>('[aria-controls="ticket-body"]')!;
  const body = () => page!.target.querySelector<HTMLElement>('#ticket-body')!;
  const peek = () => page!.target.querySelector('[aria-labelledby="ticket"] .peek');

  expect(button.tagName).toBe('BUTTON');
  expect(button.type).toBe('button');
  expect(body().hidden).toBe(true);
  expect(peek()?.textContent).toBe('The list has no search.');

  button.click();
  flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(body().hidden).toBe(false);
  expect(peek()).toBeNull();

  button.click();
  flushSync();
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(body().hidden).toBe(true);
});

// Fold state is page state only: a new card starts from the defaults again.
it('starts the plan open on a card in Plan or Implement and folded elsewhere, and keeps a press to the page', () => {
  const plan = '1. Add the option.\n2. Test it.\n';
  page = mounted(Overview as never, { summary: null, changesHref: null, ticket: null, extra: null, related: [], plan, planOpen: true });
  const button = () => page!.target.querySelector<HTMLButtonElement>('[aria-controls="plan-body"]')!;

  expect(button().getAttribute('aria-expanded')).toBe('true');
  button().click();
  flushSync();
  expect(button().getAttribute('aria-expanded')).toBe('false');
  page.remove();

  page = mounted(Overview as never, { summary: null, changesHref: null, ticket: null, extra: null, related: [], plan, planOpen: false });
  expect(button().getAttribute('aria-expanded')).toBe('false');
});

it('opens the extra context field from its button and puts the cursor in it', async () => {
  const onsave = vi.fn(async () => null);
  page = mounted(Overview as never, { summary: null, changesHref: null, ticket: null, extra: null, related: [], onsave });

  page.target.querySelector<HTMLButtonElement>('[data-add-context]')!.click();
  await settle();

  expect(document.activeElement).toBe(page.target.querySelector('#extra'));
  // The ticket starts folded, so Add context opens it to show the field.
  expect(page.target.querySelector<HTMLElement>('#ticket-body')?.hidden).toBe(false);
  expect(page.target.querySelector('[data-add-context]')).toBeNull();
});

it('takes the default or sends the typed answer on a blocking question, once per press', async () => {
  const onchoose = vi.fn(async (): Promise<string | null> => null);
  const gate = { phase: 'refine', file: 'refine/refined.md', lines: null, check: null, questions: [{ id: 'Q1', question: 'Match ingredients?', answer: 'no', settled: null }] };
  page = mounted(Overview as never, { summary: null, changesHref: null, ticket: null, extra: null, related: [], gate, onchoose });
  const target = page.target;

  target.querySelector<HTMLButtonElement>('[data-take-default]')!.click();
  await settle();
  expect(onchoose).toHaveBeenLastCalledWith('Q1', undefined);

  target.querySelector<HTMLButtonElement>('[data-write-choice]')!.click();
  flushSync();
  const field = target.querySelector<HTMLTextAreaElement>('#choice-Q1')!;
  field.value = 'Titles and ingredients.';
  field.dispatchEvent(new Event('input'));
  onchoose.mockImplementationOnce(async () => 'Q1 names no default, so write an answer.');
  target.querySelector<HTMLButtonElement>('[data-send-choice]')!.click();
  await settle();
  expect(onchoose).toHaveBeenLastCalledWith('Q1', 'Titles and ingredients.');
  expect(onchoose).toHaveBeenCalledTimes(2);
  // A refusal keeps the typed answer and says why.
  expect(target.querySelector<HTMLTextAreaElement>('#choice-Q1')?.value).toBe('Titles and ingredients.');
  expect(target.querySelector('[data-choice="Q1"] [role="status"]')?.textContent).toContain('names no default');
});

// Settling the last question folds the gate and hides the pressed button, so focus moves to the fold
// button instead of falling back to the top of the page.
it('moves focus to the fold button when the last question is settled', async () => {
  const onchoose = vi.fn(async (): Promise<string | null> => null);
  const question = { id: 'Q1', question: 'Match ingredients?', answer: 'no', settled: null as string | null };
  const gate = { phase: 'refine', file: 'refine/refined.md', lines: ['- Concluded: titles only.'], check: null, questions: [question] };
  page = mounted(Overview as never, { summary: null, changesHref: null, ticket: null, extra: null, related: [], gate, onchoose });

  const take = page.target.querySelector<HTMLButtonElement>('[data-take-default]')!;
  take.focus();
  take.click();
  await settle();
  page.set({ gate: { ...gate, questions: [{ ...question, settled: 'no' }] } } as never);

  const toggle = page.target.querySelector<HTMLButtonElement>('[aria-controls="gate-body"]');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(toggle);
});

// With a next column to start, focus lands on its button instead, which makes the move.
it('moves focus to Start Plan when the last question is settled, and the press asks for the move', async () => {
  const onchoose = vi.fn(async (): Promise<string | null> => null);
  const ongatestart = vi.fn();
  const question = { id: 'Q1', question: 'Match ingredients?', answer: 'no', settled: null as string | null };
  const gate = { phase: 'refine', file: 'refine/refined.md', lines: ['- Concluded: titles only.'], check: null, questions: [question] };
  page = mounted(Overview as never, { summary: null, changesHref: null, ticket: null, extra: null, related: [], gate, onchoose, gateNext: 'Plan', ongatestart });

  page.target.querySelector<HTMLButtonElement>('[data-take-default]')!.click();
  await settle();
  page.set({ gate: { ...gate, questions: [{ ...question, settled: 'no' }] } } as never);

  const start = page.target.querySelector<HTMLButtonElement>('[data-gate-start]');
  expect(document.activeElement).toBe(start);
  start?.click();
  expect(ongatestart).toHaveBeenCalledOnce();
});

// The board card's Check chip links #output-check, which opens the folded gate and its list.
it('opens the folded gate and the check list when the address ends in #output-check', async () => {
  const gate = { phase: 'implement', file: 'implement/progress.md', lines: ['- Done: the search box.'], questions: [], check: { problems: [{ file: 'implement/summary.md', problem: 'The file is missing.' }], note: null } };
  window.location.hash = '#output-check';
  Element.prototype.scrollIntoView ??= () => {};
  try {
    page = mounted(Overview as never, { summary: null, changesHref: null, ticket: null, extra: null, related: [], gate });
    await settle();
    const list = page.target.querySelector<HTMLDetailsElement>('#output-check');

    expect(list?.open).toBe(true);
    expect(page.target.querySelector('#gate-body')?.hasAttribute('hidden')).toBe(false);
  } finally {
    window.location.hash = '';
  }
});

it('opens the check list once per arrival, and again when only the hash changes', async () => {
  const problem = { file: 'implement/summary.md', problem: 'The file is missing.' };
  const gate = { phase: 'implement', file: 'implement/progress.md', lines: ['- Done: the search box.'], questions: [], check: { problems: [problem], note: null } };
  window.location.hash = '#output-check';
  Element.prototype.scrollIntoView ??= () => {};
  try {
    page = mounted(Overview as never, { summary: null, changesHref: null, ticket: null, extra: null, related: [], gate });
    await settle();
    const list = () => page!.target.querySelector<HTMLDetailsElement>('#output-check')!;
    list().open = false;
    list().dispatchEvent(new Event('toggle'));
    flushSync();

    // A reload of the gate data, as after answering a question, leaves the folded list folded.
    page.set({ gate: { ...gate, check: { problems: [{ ...problem }], note: null } } });
    await settle();
    expect(list().open).toBe(false);

    window.location.hash = '';
    window.location.hash = '#output-check';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await settle();
    expect(list().open).toBe(true);
  } finally {
    window.location.hash = '';
  }
});
