import type { Changes, DiffComment, DiffEntry, WorktreeRow } from '@nolzu/protocol';
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import ChangesTab from './ChangesTab.svelte';

// What the server render cannot reach: picking a file, the one request it makes, and the answer.

type Answer = { ok: true; text: string } | { ok: false; reason: string };

const row: WorktreeRow = { repo: '.', path: '/p/worktrees/APP-1', branch: 'feat/APP-1', base: 'main', ahead: 1, behind: 0, changed: 0, untracked: 0, unpushed: null, stale: false, staleReason: null };
const entry = (path: string, over: Partial<DiffEntry> = {}): DiffEntry => ({ path, oldPath: null, status: 'changed', added: 3, removed: 1, binary: false, ...over });
const leaf = (item: DiffEntry) => ({ name: item.path, path: item.path, entry: item, children: [] });

const list = entry('list.ts');
const search = entry('search.ts', { status: 'added' });
const picture = entry('hero.png', { status: 'added', binary: true, added: 0, removed: 0 });
const changes: Changes = {
  ok: true,
  row,
  untracked: [],
  committed: { stat: { files: 2, added: 6, removed: 2 }, tree: [leaf(list), leaf(picture)] },
  uncommitted: { stat: { files: 1, added: 3, removed: 1 }, tree: [leaf(search)] },
  // The tab draws the one diff from the base to the folder.
  diff: { stat: { files: 3, added: 6, removed: 2 }, tree: [leaf(list), leaf(picture), leaf(search)] },
};

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

function draw(answer: (ask: { path: string }) => Answer) {
  const onopen = vi.fn(async (ask: { path: string; oldPath: string | null; group: string }) => answer(ask));
  page = mounted(ChangesTab as never, { changes, onopen });
  const pick = async (path: string) => {
    page?.target.querySelector<HTMLButtonElement>(`[data-open="${path}"]`)?.click();
    flushSync();
    await settle();
  };
  const viewer = () => page?.target.querySelector('[data-viewer]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return { onopen, pick, viewer };
}

it('asks for the one patch it opens, and not the whole diff', async () => {
  const ui = draw(() => ({ ok: true, text: '@@ -1 +1 @@\n-old\n+new\n' }));

  await ui.pick('list.ts');

  expect(ui.onopen).toHaveBeenCalledTimes(1);
  expect(ui.onopen).toHaveBeenCalledWith({ path: 'list.ts', oldPath: null, group: 'branch' });
  expect(ui.viewer()).toContain('+new');
});

it('asks once per file picked, and not again for the file already open', async () => {
  const ui = draw(() => ({ ok: true, text: '+x\n' }));

  await ui.pick('list.ts');
  await ui.pick('list.ts');
  await ui.pick('search.ts');

  expect(ui.onopen.mock.calls.map(([ask]) => [ask.path, ask.group])).toEqual([
    ['list.ts', 'branch'],
    ['search.ts', 'branch'],
  ]);
});

it('shows a binary file as a marker and asks for nothing', async () => {
  const ui = draw(() => ({ ok: true, text: 'never' }));

  await ui.pick('hero.png');

  expect(ui.onopen).not.toHaveBeenCalled();
  expect(ui.viewer()).toContain('Binary file, no text to show.');
});

it('shows the counts and the plain sentence for a file over the cap', async () => {
  const ui = draw(() => ({ ok: false, reason: 'The diff of list.ts is over 262144 bytes, which is too large to show here.' }));

  await ui.pick('list.ts');

  expect(ui.viewer()).toContain('+3 -1');
  expect(ui.viewer()).toContain('too large to show here');
});

it('shows the answer to the file picked last, when an earlier answer arrives after it', async () => {
  const answers: ((said: Answer) => void)[] = [];
  const onopen = vi.fn(() => new Promise<Answer>((resolve) => answers.push(resolve)));
  page = mounted(ChangesTab as never, { changes, onopen });
  const pick = (path: string) => {
    page?.target.querySelector<HTMLButtonElement>(`[data-open="${path}"]`)?.click();
    flushSync();
  };

  pick('list.ts');
  // A grey block stands in the diff's place while git reads it, with the words for a screen reader.
  expect(page.target.querySelector('[data-viewer] [data-skeleton]')?.getAttribute('data-shape')).toBe('block');
  expect(page.target.querySelector('[data-viewer] [data-skeleton] .sr')?.textContent).toBe('Reading the patch.');
  pick('search.ts');
  answers[1]?.({ ok: true, text: '+search\n' });
  await settle();
  answers[0]?.({ ok: true, text: '+list\n' });
  await settle();

  expect(page.target.querySelector('[data-viewer]')?.textContent).toContain('+search');
  expect(page.target.querySelector('[data-viewer]')?.textContent).not.toContain('+list');
  expect(page.target.querySelector('[data-viewer] [data-skeleton]')).toBeNull();
});

it('asks again for the open file when its last answer was a refusal', async () => {
  let calls = 0;
  const ui = draw(() => (++calls === 1 ? { ok: false, reason: 'The local app is not answering.' } : { ok: true, text: '@@ -1 +1 @@\n+back\n' }));

  await ui.pick('list.ts');
  await ui.pick('list.ts');

  expect(ui.onopen).toHaveBeenCalledTimes(2);
  expect(ui.viewer()).toContain('+back');
});

it('says binary in the viewer header instead of counting no lines', async () => {
  const ui = draw(() => ({ ok: true, text: 'never' }));

  await ui.pick('hero.png');

  expect(page?.target.querySelector('[data-viewer] .stat')?.textContent).toBe('binary');
});

describe('comments on diff lines', () => {
  // list.ts as git shows it from the base to the folder: line 2 rewritten, line 3 added.
  const PATCH = '@@ -1,2 +1,3 @@\n export const list = [];\n-export const old = 1;\n+export const sorted = list.sort();\n+export const count = list.length;\n';
  const comment = (over: Partial<DiffComment> = {}): DiffComment => ({
    id: 7,
    repo: '.',
    file: 'list.ts',
    line: 2,
    lineText: 'export const sorted = list.sort();',
    text: 'Sort by title, not by id.',
    commit: 'abc1234',
    createdAt: '2026-10-15T08:00:00.000Z',
    sentAt: null,
    ...over,
  });

  function open(comments: DiffComment[] = [], patch = PATCH) {
    const calls = {
      onopen: vi.fn(async () => ({ ok: true as const, text: patch })),
      oncomment: vi.fn(async () => null as string | null),
      onedit: vi.fn(async () => null as string | null),
      ondelete: vi.fn(async () => null as string | null),
    };
    page = mounted(ChangesTab as never, { changes, comments, ...calls });
    const pick = async (path = 'list.ts') => {
      page?.target.querySelector<HTMLButtonElement>(`[data-open="${path}"]`)?.click();
      flushSync();
      await settle();
    };
    const rows = () => [...(page?.target.querySelectorAll<HTMLElement>('.ln') ?? [])];
    // What follows each line: the comments drawn under it, by their text.
    const under = (line: number) => {
      const row = rows().find((one) => one.querySelector('[data-gutter]')?.getAttribute('data-gutter') === String(line));
      const found: string[] = [];
      for (let next = row?.nextElementSibling; next?.matches('[data-comment]'); next = next.nextElementSibling) found.push(next.textContent?.replace(/\s+/g, ' ').trim() ?? '');
      return found;
    };
    return { ...calls, pick, rows, under, target: page.target };
  }

  it('draws both line numbers and a gutter on every line of the folder, and none on a removed line', async () => {
    const ui = open();
    await ui.pick();

    expect(ui.rows().map((row) => [...row.querySelectorAll('.no')].map((no) => no.textContent))).toEqual([
      ['', ''],
      ['1', '1'],
      ['2', ''],
      ['', '2'],
      ['', '3'],
    ]);
    expect([...ui.target.querySelectorAll('[data-gutter]')].map((button) => button.getAttribute('aria-label'))).toEqual([
      'Comment on line 1',
      'Comment on line 2',
      'Comment on line 3',
    ]);
  });

  it('opens a field under the line whose gutter was pressed, and saves the line, its text and the comment', async () => {
    const ui = open();
    await ui.pick();

    ui.target.querySelector<HTMLButtonElement>('[data-gutter="2"]')!.click();
    flushSync();
    const field = ui.target.querySelector<HTMLTextAreaElement>('[data-comment="new"] textarea')!;
    expect(document.activeElement).toBe(field);
    expect(ui.rows()[3]?.nextElementSibling?.matches('[data-comment="new"]')).toBe(true);
    field.value = 'Sort by title, not by id.';
    field.dispatchEvent(new Event('input'));
    flushSync();
    ui.target.querySelector<HTMLButtonElement>('[data-save]')!.click();
    await settle();

    expect(ui.oncomment).toHaveBeenCalledWith({ file: 'list.ts', line: 2, lineText: 'export const sorted = list.sort();', text: 'Sort by title, not by id.' });
    expect(ui.target.querySelector('[data-comment="new"]')).toBeNull();
  });

  it('saves with Cmd Enter and closes with Esc, and neither key reaches the page', async () => {
    const ui = open();
    const page = vi.fn();
    window.addEventListener('keydown', page);
    await ui.pick();
    ui.target.querySelector<HTMLButtonElement>('[data-gutter="1"]')!.click();
    flushSync();
    const field = ui.target.querySelector<HTMLTextAreaElement>('[data-comment="new"] textarea')!;
    field.value = 'Keep the empty list.';
    field.dispatchEvent(new Event('input'));
    flushSync();

    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await settle();
    expect(ui.oncomment).toHaveBeenCalledWith(expect.objectContaining({ line: 1, text: 'Keep the empty list.' }));

    ui.target.querySelector<HTMLButtonElement>('[data-gutter="3"]')!.click();
    flushSync();
    ui.target.querySelector('[data-comment="new"] textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(ui.target.querySelector('[data-comment="new"]')).toBeNull();
    window.removeEventListener('keydown', page);
    expect(page).not.toHaveBeenCalled();
  });

  it('keeps the field and says why when the save is refused, and sends nothing empty', async () => {
    const ui = open();
    ui.oncomment.mockResolvedValueOnce('APP-1 does not change list.ts, so it takes no comment.');
    await ui.pick();
    ui.target.querySelector<HTMLButtonElement>('[data-gutter="3"]')!.click();
    flushSync();

    ui.target.querySelector<HTMLButtonElement>('[data-save]')!.click();
    await settle();
    expect(ui.oncomment).not.toHaveBeenCalled();
    expect(ui.target.querySelector('[role="alert"]')?.textContent).toBe('The comment is empty. Write what should change on this line.');

    const field = ui.target.querySelector<HTMLTextAreaElement>('[data-comment="new"] textarea')!;
    field.value = 'Count once.';
    field.dispatchEvent(new Event('input'));
    flushSync();
    ui.target.querySelector<HTMLButtonElement>('[data-save]')!.click();
    await settle();
    expect(ui.target.querySelector('[data-comment="new"] [role="alert"]')?.textContent).toBe('APP-1 does not change list.ts, so it takes no comment.');
  });

  it('shows a saved comment under its line with Edit and Delete, which send its id', async () => {
    const ui = open([comment()]);
    await ui.pick();

    expect(ui.under(2)).toEqual([expect.stringContaining('You line 2 ·')]);
    expect(ui.under(2)[0]).toContain('Sort by title, not by id. Edit Delete Goes with the next send back');
    expect(ui.rows()[3]?.classList.contains('cm')).toBe(true);

    ui.target.querySelector<HTMLButtonElement>('[data-edit]')!.click();
    flushSync();
    const field = ui.target.querySelector<HTMLTextAreaElement>('[data-comment="7"] textarea')!;
    expect(field.value).toBe('Sort by title, not by id.');
    field.value = 'Sort by title.';
    field.dispatchEvent(new Event('input'));
    flushSync();
    ui.target.querySelector<HTMLButtonElement>('[data-save]')!.click();
    await settle();
    expect(ui.onedit).toHaveBeenCalledWith(7, 'Sort by title.');

    ui.target.querySelector<HTMLButtonElement>('[data-delete]')!.click();
    await settle();
    expect(ui.ondelete).toHaveBeenCalledWith(7);
  });

  it('shows a comment whose line moved at its new line, and says where it was made', async () => {
    const ui = open([comment({ line: 1, lineText: 'export const count = list.length;' })]);
    await ui.pick();

    expect(ui.under(3)).toEqual([expect.stringContaining('You line 3, made on line 1 ·')]);
    expect(ui.target.querySelector('[data-outdated]')).toBeNull();
  });

  it('shows a comment whose line is gone as outdated at the end of its file, with the line it was made on', async () => {
    const ui = open([comment({ lineText: 'export const sorted = list.sort((a, b) => a.id - b.id);' })]);
    await ui.pick();

    const outdated = ui.target.querySelector<HTMLElement>('[data-outdated]')!;
    expect(outdated.textContent?.replace(/\s+/g, ' ')).toContain('made on line 2');
    expect(outdated.textContent?.replace(/\s+/g, ' ')).toContain('Outdated The line it was made on: export const sorted = list.sort((a, b) => a.id - b.id);');
    expect(outdated.previousElementSibling?.matches('.ln')).toBe(true);
    expect(outdated.nextElementSibling).toBeNull();
    expect(ui.under(2)).toEqual([]);
  });

  it('shows a comment whose file left the diff under that file name, as outdated', () => {
    const ui = open([comment({ file: 'src/gone.ts' })]);

    const gone = ui.target.querySelector<HTMLElement>('section[aria-label="Comments on src/gone.ts"]')!;
    expect(gone.querySelector('header')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('src/gone.ts no longer in the diff');
    expect(gone.querySelector('[data-outdated]')).not.toBeNull();
    expect(ui.target.textContent).toContain('1 comment');
  });

  it('offers no gutter on a page that cannot write a comment', async () => {
    page = mounted(ChangesTab as never, { changes, comments: [comment()], onopen: async () => ({ ok: true, text: PATCH }) });
    page.target.querySelector<HTMLButtonElement>('[data-open="list.ts"]')!.click();
    flushSync();
    await settle();

    expect(page.target.querySelector('[data-gutter]')).toBeNull();
    expect(page.target.querySelector('[data-edit]')).toBeNull();
    expect(page.target.textContent).toContain('Sort by title, not by id.');
  });

  // Every repository's panel stays on the page, so two fields on the same line number must not share
  // an id, or the label of one would name the other.
  it('gives two new comment fields on the same line their own ids, as two repository panels hold them', async () => {
    const first = open();
    await first.pick();
    const second = mounted(ChangesTab as never, { changes, onopen: async () => ({ ok: true, text: PATCH }), oncomment: async () => null });
    try {
      second.target.querySelector<HTMLButtonElement>('[data-open="list.ts"]')!.click();
      flushSync();
      await settle();
      for (const target of [first.target, second.target]) target.querySelector<HTMLButtonElement>('[data-gutter="2"]')!.click();
      flushSync();

      const fields = [first.target, second.target].map((target) => target.querySelector<HTMLTextAreaElement>('[data-comment="new"] textarea')!);
      expect(fields[0]!.id).not.toBe(fields[1]!.id);
      for (const field of fields) expect(document.querySelector(`label[for="${field.id}"]`)?.closest('[data-comment]')).toBe(field.closest('[data-comment]'));
    } finally {
      second.remove();
    }
  });
});
