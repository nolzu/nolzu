import { type Component, createRawSnippet, flushSync } from 'svelte';
import { afterEach, expect, it } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- the ui package's mount helper, which is not exported
import { type Mounted, mounted } from '../../../../packages/ui/test/mounted.svelte.ts';
import Streamed from './Streamed.svelte';

// The card page draws before git answers: the loader returns the slow part as a promise, and this
// draws a quiet placeholder in its room until the answer lands.

// A `.svelte` test file, because the answer's snippet updates its text in an effect as a real one would.
const shown = createRawSnippet((value: () => unknown) => ({
  render: () => '<p data-value></p>',
  setup: (node) => {
    $effect(() => {
      node.textContent = String(value());
    });
  },
}));

interface Props extends Record<string, unknown> {
  promise: Promise<string>;
  scope: string;
  shape?: string;
}
let drawn: Mounted<Props> | null = null;
afterEach(() => {
  drawn?.remove();
  drawn = null;
});

// A promise and the hand that settles it, so the test says when git answers.
const later = <T,>() => {
  let settle!: (value: T) => void;
  let refuse!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    settle = yes;
    refuse = no;
  });
  return { promise, settle, refuse };
};
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};

const draw = (props: Props) => {
  drawn = mounted(Streamed as unknown as Component<Props>, { ...props, waiting: 'Reading the changes.', height: '120px', children: shown });
  return drawn;
};

it('draws the placeholder in the room the answer takes, then the answer', async () => {
  const git = later<string>();
  draw({ promise: git.promise, scope: 'APP-1' });

  const wait = document.querySelector<HTMLElement>('[data-waiting]');
  // A grey block fills the room. The words stay for screen readers only.
  expect(wait?.querySelector('[data-skeleton]')?.getAttribute('data-shape')).toBe('block');
  expect(wait?.querySelector<HTMLElement>('[data-skeleton] .bone')?.style.height).toBe('120px');
  expect(wait?.querySelector('[data-skeleton] .sr')?.textContent).toBe('Reading the changes.');
  expect(wait?.style.minHeight).toBe('120px');
  expect(wait?.getAttribute('aria-busy')).toBe('true');
  expect(document.querySelector('[data-value]')).toBeNull();

  git.settle('+29 -3');
  await tick();

  expect(document.querySelector('[data-waiting]')).toBeNull();
  expect(document.querySelector('[data-value]')?.textContent).toBe('+29 -3');
});

it('draws the skeleton shape it is given', () => {
  draw({ promise: later<string>().promise, scope: 'APP-1', shape: 'rows' });

  expect(document.querySelectorAll('[data-waiting] [data-skeleton] .row')).toHaveLength(3);
});

it('says the error page words in place when the part fails', async () => {
  const git = later<string>();
  draw({ promise: git.promise, scope: 'APP-1' });

  git.refuse({ message: 'Internal Error' });
  await tick();

  expect(document.querySelector('[data-failed]')?.textContent).toBe('Internal Error');
  expect(document.querySelector('[data-waiting]')).toBeNull();
});

it('says the failure message it was given, and the default words for one without a message', async () => {
  const git = later<string>();
  draw({ promise: git.promise, scope: 'APP-1' });
  git.refuse(new Error('git is not installed'));
  await tick();
  expect(document.querySelector('[data-failed]')?.textContent).toBe('git is not installed');
  drawn?.remove();

  const bare = later<string>();
  draw({ promise: bare.promise, scope: 'APP-1' });
  bare.refuse('boom');
  await tick();
  expect(document.querySelector('[data-failed]')?.textContent).toBe('Internal Error');
  drawn?.remove();

  const empty = later<string>();
  draw({ promise: empty.promise, scope: 'APP-1' });
  empty.refuse(new Error(''));
  await tick();
  expect(document.querySelector('[data-failed]')?.textContent).toBe('Internal Error');
});

it('keeps the answer drawn while a reload of the same card is on its way, and drops it for another card', async () => {
  const first = later<string>();
  const view = draw({ promise: first.promise, scope: 'APP-1' });
  first.settle('one');
  await tick();

  const reload = later<string>();
  view.set({ promise: reload.promise });
  expect(document.querySelector('[data-value]')?.textContent).toBe('one');

  reload.settle('two');
  await tick();
  expect(document.querySelector('[data-value]')?.textContent).toBe('two');

  view.set({ promise: later<string>().promise, scope: 'APP-2' });
  expect(document.querySelector('[data-value]')).toBeNull();
  expect(document.querySelector('[data-waiting]')).not.toBeNull();
});

it('draws the answer of the newest promise only', async () => {
  const slow = later<string>();
  const view = draw({ promise: slow.promise, scope: 'APP-1' });
  const fast = later<string>();
  view.set({ promise: fast.promise });

  fast.settle('new');
  await tick();
  slow.settle('old');
  await tick();

  expect(document.querySelector('[data-value]')?.textContent).toBe('new');
});

it('ignores the failure of an older promise once a newer one answered', async () => {
  const slow = later<string>();
  const view = draw({ promise: slow.promise, scope: 'APP-1' });
  const fast = later<string>();
  view.set({ promise: fast.promise });

  fast.settle('new');
  await tick();
  slow.refuse(new Error('old failure'));
  await tick();

  expect(document.querySelector('[data-failed]')).toBeNull();
  expect(document.querySelector('[data-value]')?.textContent).toBe('new');
});
