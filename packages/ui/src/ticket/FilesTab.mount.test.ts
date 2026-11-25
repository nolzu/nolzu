import type { CardFileGroup } from '@nolzu/protocol';
import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import FilesTab from './FilesTab.svelte';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const url = (path: string, download = false) => `/api/card/APP-1/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
const groups: CardFileGroup[] = [
  {
    folder: 'implement',
    share: false,
    files: [
      { path: 'implement/pr.md', name: 'pr.md', size: 20, kind: 'markdown', phase: 'implement', modified: 0, when: '15:40' },
      { path: 'implement/notes.ts', name: 'notes.ts', size: 20, kind: 'text', phase: 'implement', modified: 0, when: '15:40' },
    ],
  },
  {
    folder: 'qa',
    share: false,
    files: [{ path: 'qa/checks.md', name: 'checks.md', size: 922, kind: 'markdown', phase: 'plan', modified: 0, when: '15:32' }],
  },
  {
    folder: 'share',
    share: true,
    files: [
      { path: 'share/shot.png', name: 'shot.png', size: 4, kind: 'image', phase: null, modified: 0, when: 'Mon 09:00' },
      { path: 'share/bundle.zip', name: 'bundle.zip', size: 3, kind: 'download', phase: null, modified: 0, when: 'Mon 09:00' },
    ],
  },
  {
    folder: 'mockups',
    share: false,
    files: [{ path: 'mockups/main-page.html', name: 'main-page.html', size: 40, kind: 'html', phase: null, modified: 0, when: '15:50' }],
  },
];

async function open(path: string, text = '') {
  const onread = vi.fn(async () => ({ ok: true as const, text }));
  page = mounted(FilesTab as never, { groups, folder: null, fileUrl: url, onread });
  page.target.querySelector<HTMLButtonElement>(`[data-file="${path}"]`)!.click();
  flushSync();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
  return { onread, viewer: page.target.querySelector('[data-viewer]')! };
}

it('renders a markdown file through the sanitizing renderer', async () => {
  const { onread, viewer } = await open('implement/pr.md', '# Search\n\n<img src=x onerror=alert(1)>');

  expect(onread).toHaveBeenCalledWith('implement/pr.md');
  expect(viewer.querySelector('h1')?.textContent).toBe('Search');
  expect(viewer.innerHTML).not.toContain('onerror');
});

it('shows a code file as text, with its tags escaped', async () => {
  const { viewer } = await open('implement/notes.ts', 'const a = "<b>bold</b>";');

  expect(viewer.querySelector('pre')?.textContent).toBe('const a = "<b>bold</b>";');
  expect(viewer.querySelector('b')).toBeNull();
});

it('shows an image inline from the file address, and reads no text for it', async () => {
  const { onread, viewer } = await open('share/shot.png');

  expect(onread).not.toHaveBeenCalledWith('share/shot.png');
  expect(viewer.querySelector('img')?.getAttribute('src')).toBe(url('share/shot.png'));
});

// A mockup is only useful drawn. The frame's sandbox is empty, so the file runs no script and gets
// no origin of its own, whatever the route sends.
it('draws an html file in a sandboxed frame from the file address, Preview first', async () => {
  const { viewer } = await open('mockups/main-page.html', '<h1>Recipes</h1>');
  const frame = viewer.querySelector('iframe')!;

  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.getAttribute('src')).toBe(url('mockups/main-page.html'));
  expect(frame.getAttribute('title')).toContain('main-page.html');
  expect(viewer.querySelector('[data-mode="preview"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(viewer.querySelector('pre')).toBeNull();
  const tab = viewer.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
  expect(tab.textContent).toContain('Open in a new tab');
  expect(tab.getAttribute('href')).toBe(url('mockups/main-page.html'));
  expect(tab.getAttribute('rel')).toContain('noopener');
});

it('shows the source of an html file as text on Source, with its tags escaped', async () => {
  const { viewer } = await open('mockups/main-page.html', '<h1>Recipes</h1>');
  viewer.querySelector<HTMLButtonElement>('[data-mode="source"]')!.click();
  flushSync();

  expect(viewer.querySelector('iframe')).toBeNull();
  expect(viewer.querySelector('pre')?.textContent).toBe('<h1>Recipes</h1>');
  expect(viewer.querySelector('h1')).toBeNull();
  expect(viewer.querySelector('[data-mode="source"]')?.getAttribute('aria-pressed')).toBe('true');
});

it('opens the next html file on Preview again', async () => {
  const { viewer } = await open('mockups/main-page.html', '<h1>Recipes</h1>');
  viewer.querySelector<HTMLButtonElement>('[data-mode="source"]')!.click();
  flushSync();
  page!.target.querySelector<HTMLButtonElement>('[data-file="implement/notes.ts"]')!.click();
  await settle();
  page!.target.querySelector<HTMLButtonElement>('[data-file="mockups/main-page.html"]')!.click();
  await settle();

  expect(page!.target.querySelector('[data-viewer] iframe')).not.toBeNull();
});

it('says why an html file was refused, and draws no frame', async () => {
  const onread = vi.fn(async () => ({ ok: false as const, reason: 'mockups/main-page.html is 300 kB, over the 256 kB a page shows. Open it in the card folder.' }));
  page = mounted(FilesTab as never, { groups, folder: null, fileUrl: url, onread });
  await settle();
  page.target.querySelector<HTMLButtonElement>('[data-file="mockups/main-page.html"]')!.click();
  await settle();

  expect(page.target.querySelector('[data-viewer] iframe')).toBeNull();
  expect(page.target.querySelector('[data-viewer] .body')?.textContent).toContain('over the 256 kB');
});

// The header says which phase wrote the file, read off the card folder layout and not off the folder
// it sits in: Plan writes the QA checks into QA's folder.
it('names the phase that wrote the file in the preview header', async () => {
  const { viewer } = await open('qa/checks.md', '1. Search');
  const head = viewer.querySelector('header')?.textContent?.replace(/\s+/g, ' ').trim();

  expect(head).toContain('qa/checks.md');
  expect(head).toContain('922 B');
  expect(head).toContain('Written by Plan, 15:32');
});

it('names the phase of the folder for an ordinary phase file', async () => {
  const { viewer } = await open('implement/pr.md', 'Done');

  expect(viewer.querySelector('header')?.textContent?.replace(/\s+/g, ' ')).toContain('Written by Implement, 15:40');
});

it('names no phase for a file a person put in, only when it changed', async () => {
  const { viewer } = await open('share/shot.png');

  expect(viewer.querySelector('header')?.textContent).toContain('Changed Mon 09:00');
  expect(viewer.querySelector('header')?.textContent).not.toContain('Written by');
});

// A file the viewer has no view for opens all the same, with the reason and Download in the head.
it('opens a file the viewer cannot show with a plain line, and Download in the head', async () => {
  const { onread, viewer } = await open('share/bundle.zip');

  expect(onread).not.toHaveBeenCalledWith('share/bundle.zip');
  expect(viewer.querySelector('.body [role="status"]')?.textContent?.trim()).toBe('No preview for this kind of file.');
  expect(viewer.querySelector('a[download]')?.getAttribute('href')).toBe(url('share/bundle.zip', true));
});

it('says a note too big for the viewer is too big, not a kind it cannot show', async () => {
  const huge: CardFileGroup[] = [{ folder: 'implement', share: false, files: [{ path: 'implement/progress.md', name: 'progress.md', size: 300 * 1024, kind: 'download', tooBig: true, phase: 'implement', modified: 0 }] }];
  page = mounted(FilesTab as never, { groups: huge, folder: null, fileUrl: url, onread: vi.fn(async () => ({ ok: true as const, text: '' })) });
  page.target.querySelector<HTMLButtonElement>('[data-file="implement/progress.md"]')!.click();
  flushSync();

  expect(page.target.querySelector('[data-viewer] .body [role="status"]')?.textContent?.trim()).toBe('This file is 300 KB, too big to show here. Download it to read it.');
});

async function settle() {
  flushSync();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

// The Files tab opens the plan, so the tab never lands on an empty preview.
it('opens plan/plan.md first when the card has one', async () => {
  const withPlan: CardFileGroup[] = [
    ...groups,
    { folder: 'plan', share: false, files: [{ path: 'plan/plan.md', name: 'plan.md', size: 9, kind: 'markdown', phase: 'plan', modified: 0, when: '15:00' }] },
  ];
  const onread = vi.fn(async () => ({ ok: true as const, text: '# Plan' }));
  page = mounted(FilesTab as never, { groups: withPlan, folder: null, fileUrl: url, onread });
  await settle();

  expect(onread).toHaveBeenCalledWith('plan/plan.md');
  expect(page.target.querySelector('[data-viewer] header')?.textContent).toContain('plan/plan.md');
});

it('opens the first file the viewer can show when there is no plan', async () => {
  const pdfFirst: CardFileGroup[] = [
    { folder: 'refine', share: false, files: [{ path: 'refine/sketch.pdf', name: 'sketch.pdf', size: 3, kind: 'download', phase: 'refine', modified: 0, when: '09:00' }] },
    ...groups,
  ];
  const onread = vi.fn(async () => ({ ok: true as const, text: 'Done' }));
  page = mounted(FilesTab as never, { groups: pdfFirst, folder: null, fileUrl: url, onread });
  await settle();

  expect(onread).toHaveBeenCalledWith('implement/pr.md');
  expect(page.target.querySelector('[data-viewer] header')?.textContent).toContain('implement/pr.md');
});

it('opens the file the link names over the plan', async () => {
  const onread = vi.fn(async () => ({ ok: true as const, text: '' }));
  page = mounted(FilesTab as never, { groups, folder: null, fileUrl: url, onread, start: 'qa/checks.md' });
  await settle();

  expect(onread).toHaveBeenCalledWith('qa/checks.md');
  expect(onread).not.toHaveBeenCalledWith('implement/pr.md');
});

it('opens the file the link names even when the card has a plan', async () => {
  const withPlan: CardFileGroup[] = [
    ...groups,
    { folder: 'plan', share: false, files: [{ path: 'plan/plan.md', name: 'plan.md', size: 9, kind: 'markdown', phase: 'plan', modified: 0, when: '15:00' }] },
  ];
  const onread = vi.fn(async () => ({ ok: true as const, text: '' }));
  page = mounted(FilesTab as never, { groups: withPlan, folder: null, fileUrl: url, onread, start: 'qa/checks.md' });
  await settle();

  expect(onread).toHaveBeenCalledWith('qa/checks.md');
  expect(onread).not.toHaveBeenCalledWith('plan/plan.md');
});

// The query is typed by anyone, so only a file the listing holds opens. A path out of the card folder
// is in no listing, and the tab opens as it would with no query.
it('opens no file the query names outside the card folder', async () => {
  for (const start of ['../other/secret.md', '/etc/passwd', 'qa/../../x.md', 'qa/nothing.md']) {
    const onread = vi.fn(async () => ({ ok: true as const, text: '' }));
    page = mounted(FilesTab as never, { groups, folder: null, fileUrl: url, onread, start });
    await settle();

    expect(onread, start).toHaveBeenCalledTimes(1);
    expect(onread, start).toHaveBeenCalledWith('implement/pr.md');
    page.remove();
    page = null;
  }
});

// A QA screenshot thumbnail links here with its path, and the tab opens the image.
it('opens an image the query names', async () => {
  const onread = vi.fn(async () => ({ ok: true as const, text: '' }));
  page = mounted(FilesTab as never, { groups, folder: null, fileUrl: url, onread, start: 'share/shot.png' });
  await settle();

  expect(page.target.querySelector('[data-viewer] img')?.getAttribute('src')).toBe(url('share/shot.png'));
  expect(onread).not.toHaveBeenCalled();
});

it('copies a text file from the preview header, beside Download, and says so', async () => {
  const oncopy = vi.fn(async () => null);
  page = mounted(FilesTab as never, { groups, folder: null, fileUrl: url, onread: async () => ({ ok: true as const, text: '# Search' }), oncopy });
  await settle();
  const head = page.target.querySelector('[data-viewer] header')!;
  head.querySelector<HTMLButtonElement>('[data-copy]')!.click();
  await settle();

  expect(head.querySelector('a[download]')?.textContent).toContain('Download');
  expect(oncopy).toHaveBeenCalledWith('# Search');
  expect(head.querySelector('[role="status"]')?.textContent).toBe('Copied.');
});

it('says why a copy was refused', async () => {
  const oncopy = vi.fn(async () => 'The browser refused the clipboard.');
  page = mounted(FilesTab as never, { groups, folder: null, fileUrl: url, onread: async () => ({ ok: true as const, text: 'a' }), oncopy });
  await settle();
  page.target.querySelector<HTMLButtonElement>('[data-copy]')!.click();
  await settle();

  expect(page.target.querySelector('[data-viewer] [role="status"]')?.textContent).toBe('The browser refused the clipboard.');
});

it('offers no Copy for an image', async () => {
  const oncopy = vi.fn(async () => null);
  page = mounted(FilesTab as never, { groups, folder: null, fileUrl: url, onread: async () => ({ ok: true as const, text: '' }), oncopy });
  await settle();
  page.target.querySelector<HTMLButtonElement>('[data-file="share/shot.png"]')!.click();
  await settle();

  expect(page.target.querySelector('[data-copy]')).toBeNull();
});

// The answer belongs to the file it was about, so a file picked while the clipboard answered shows none.
it('drops a copy answer that comes back after another file was picked', async () => {
  let answer: (said: string | null) => void = () => {};
  const oncopy = vi.fn(() => new Promise<string | null>((done) => (answer = done)));
  page = mounted(FilesTab as never, { groups, folder: null, fileUrl: url, onread: async () => ({ ok: true as const, text: 'a' }), oncopy });
  await settle();
  page.target.querySelector<HTMLButtonElement>('[data-copy]')!.click();
  page.target.querySelector<HTMLButtonElement>('[data-file="qa/checks.md"]')!.click();
  await settle();
  answer(null);
  await settle();

  expect(page.target.querySelector('[data-viewer] [role="status"]')?.textContent).toBe('');
});

// The text of a file comes from the page after a pick, so a grey block holds its place until then.
it('draws a grey block while the file is read', () => {
  page = mounted(FilesTab as never, { groups, folder: null, fileUrl: url, onread: () => new Promise(() => {}) });
  page.target.querySelector<HTMLButtonElement>('[data-file="implement/notes.ts"]')!.click();
  flushSync();

  const viewer = page.target.querySelector('[data-viewer]')!;
  expect(viewer.querySelector('[data-skeleton]')?.getAttribute('data-shape')).toBe('block');
  expect(viewer.querySelector('[data-skeleton] .sr')?.textContent).toBe('Reading the file.');
});

// A run once put an npm cache of five thousand files in the card folder, and the tab listed each one.
const many = (folder: string, count: number) =>
  Array.from({ length: count }, (_, at) => ({ path: `${folder}/${at}.html`, name: `${at}.html`, size: 10, kind: 'html' as const, phase: null, modified: 0, when: '15:50' }));
const big: CardFileGroup[] = [
  { folder: 'plan', share: false, files: [{ path: 'plan/plan.md', name: 'plan.md', size: 5, kind: 'markdown', phase: 'plan', modified: 0, when: '15:00' }] },
  { folder: 'design', share: false, files: many('design/screens', 51), caches: [{ path: 'design/node_modules', count: 812 }] },
  { folder: '', share: false, files: [], caches: [{ path: '.npm', count: 5190 }] },
];

it('folds a folder of more than fifty files into one line with its count and size, which opens on a press', async () => {
  page = mounted(FilesTab as never, { groups: big, folder: null, fileUrl: url, onread: vi.fn(async () => ({ ok: true as const, text: '' })) });
  await settle();
  const fold = page.target.querySelector<HTMLButtonElement>('[data-fold="design/screens"]')!;

  expect(fold.textContent?.replace(/\s+/g, ' ').trim()).toBe('design/screens/ 51 files 510 B');
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(page.target.querySelectorAll('[data-file^="design/"]')).toHaveLength(0);
  fold.click();
  flushSync();
  expect(fold.getAttribute('aria-expanded')).toBe('true');
  expect(page.target.querySelectorAll('[data-file^="design/"]')).toHaveLength(51);
  fold.click();
  flushSync();
  expect(page.target.querySelectorAll('[data-file^="design/"]')).toHaveLength(0);
});

it('draws a cache folder as one line with its count that opens nothing', async () => {
  page = mounted(FilesTab as never, { groups: big, folder: null, fileUrl: url, onread: vi.fn(async () => ({ ok: true as const, text: '' })) });
  await settle();
  const caches = [...page.target.querySelectorAll('[data-cache]')];

  expect(caches.map((one) => one.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['design/node_modules/ 812 files, a cache, not listed', '.npm/ 5190 files, a cache, not listed']);
  expect(caches.every((one) => one.tagName === 'DIV')).toBe(true);
});

// A real card held npm logs and four coverage files beside pr.md. Every subfolder starts folded, so a
// person sees the expected files first.
it('folds every subfolder of a group, whatever its size, and opens it on a press', async () => {
  const work: CardFileGroup[] = [
    { folder: 'implement', share: false, files: [
      { path: 'implement/pr.md', name: 'pr.md', size: 5, kind: 'markdown', phase: 'implement', modified: 0 },
      { path: 'implement/work/cov.json', name: 'cov.json', size: 5, kind: 'text', phase: 'implement', modified: 0 },
    ] },
  ];
  page = mounted(FilesTab as never, { groups: work, folder: null, fileUrl: url, onread: vi.fn(async () => ({ ok: true as const, text: '' })) });
  await settle();
  const fold = page.target.querySelector<HTMLButtonElement>('[data-fold="implement/work"]')!;

  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(page.target.querySelector('[data-file="implement/pr.md"]')).not.toBeNull();
  expect(page.target.querySelector('[data-file="implement/work/cov.json"]')).toBeNull();
  fold.click();
  flushSync();
  expect(fold.getAttribute('aria-expanded')).toBe('true');
  expect(page.target.querySelector('[data-file="implement/work/cov.json"]')).not.toBeNull();
});

it('shows a folded folder open when the file the link names sits in it', async () => {
  page = mounted(FilesTab as never, { groups: big, folder: null, fileUrl: url, onread: vi.fn(async () => ({ ok: true as const, text: '' })), start: 'design/screens/7.html' });
  await settle();

  expect(page.target.querySelector('[data-fold="design/screens"]')?.getAttribute('aria-expanded')).toBe('true');
  expect(page.target.querySelector('[data-file="design/screens/7.html"]')?.getAttribute('aria-pressed')).toBe('true');
  // A press folds it again, the open file in it or not.
  page.target.querySelector<HTMLButtonElement>('[data-fold="design/screens"]')!.click();
  flushSync();
  expect(page.target.querySelector('[data-fold="design/screens"]')?.getAttribute('aria-expanded')).toBe('false');
});

// A JSON file reads as a tree: the root open, deeper levels folded, each value colored by its kind,
// and the raw text a press away.
it('draws a JSON file as a tree with the root open, and Raw shows the text', async () => {
  const json: CardFileGroup[] = [{ folder: 'qa', share: false, files: [{ path: 'qa/cov.json', name: 'cov.json', size: 60, kind: 'text', phase: 'qa', modified: 0 }] }];
  const text = '{"total": {"lines": {"pct": 91.5, "ok": true, "note": null, "name": "api"}}}';
  page = mounted(FilesTab as never, { groups: json, folder: null, fileUrl: url, onread: vi.fn(async () => ({ ok: true as const, text })) });
  await settle();
  const viewer = page.target.querySelector('[data-viewer]')!;
  const levels = () => [...viewer.querySelectorAll<HTMLDetailsElement>('details[data-json-depth]')].map((one) => [one.dataset.jsonDepth, one.open]);
  // jsdom does not open a disclosure on a click, so the test opens it as the browser would.
  const unfold = (depth: number) => {
    const node = viewer.querySelector<HTMLDetailsElement>(`details[data-json-depth="${depth}"]`)!;
    node.open = true;
    node.dispatchEvent(new Event('toggle'));
    flushSync();
  };

  expect(levels()).toEqual([['0', true], ['1', false]]);
  unfold(1);
  unfold(2);
  expect(viewer.querySelector('.number')?.textContent).toBe('91.5');
  expect(viewer.querySelector('.boolean')?.textContent).toBe('true');
  expect(viewer.querySelector('.null')?.textContent).toBe('null');
  expect(viewer.querySelector('.string')?.textContent).toBe('"api"');
  viewer.querySelector<HTMLButtonElement>('[data-mode="raw"]')!.click();
  flushSync();
  expect(viewer.querySelector('pre')?.textContent).toBe(text);
  expect(viewer.querySelector('[data-json-tree]')).toBeNull();
});

// A big array draws one page of rows, and each press adds the next page.
it('draws a page of a long array and shows more on a press', async () => {
  const json: CardFileGroup[] = [{ folder: 'qa', share: false, files: [{ path: 'qa/rows.json', name: 'rows.json', size: 2000, kind: 'text', phase: 'qa', modified: 0 }] }];
  const text = JSON.stringify(Array.from({ length: 450 }, (_, at) => at));
  page = mounted(FilesTab as never, { groups: json, folder: null, fileUrl: url, onread: vi.fn(async () => ({ ok: true as const, text })) });
  await settle();
  const viewer = page.target.querySelector('[data-viewer]')!;
  const more = () => viewer.querySelector<HTMLButtonElement>('[data-json-more]');

  expect(viewer.querySelectorAll('.number')).toHaveLength(200);
  expect(more()?.textContent).toBe('Show 200 more of 250');
  more()!.click();
  flushSync();
  more()!.click();
  flushSync();
  expect(viewer.querySelectorAll('.number')).toHaveLength(450);
  expect(more()).toBeNull();
});

it('shows a 64-bit id with every digit the file holds', async () => {
  const json: CardFileGroup[] = [{ folder: 'qa', share: false, files: [{ path: 'qa/id.json', name: 'id.json', size: 30, kind: 'text', phase: 'qa', modified: 0 }] }];
  page = mounted(FilesTab as never, { groups: json, folder: null, fileUrl: url, onread: vi.fn(async () => ({ ok: true as const, text: '{"id": 1234567890123456789}' })) });
  await settle();

  expect(page.target.querySelector('[data-viewer] .number')?.textContent).toBe('1234567890123456789');
});

it('shows JSON it cannot read as plain text, with a line that says so', async () => {
  const json: CardFileGroup[] = [{ folder: 'qa', share: false, files: [{ path: 'qa/cut.json', name: 'cut.json', size: 9, kind: 'text', phase: 'qa', modified: 0 }] }];
  page = mounted(FilesTab as never, { groups: json, folder: null, fileUrl: url, onread: vi.fn(async () => ({ ok: true as const, text: '{"a": 1,' })) });
  await settle();
  const viewer = page.target.querySelector('[data-viewer]')!;

  expect(viewer.textContent).toContain('This file could not be read as JSON, so it shows as plain text.');
  expect(viewer.querySelector('pre')?.textContent).toBe('{"a": 1,');
});
