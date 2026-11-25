import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import { type Mounted, mounted } from '../test/mounted.svelte.ts';
import { type KnowledgeChangeInput, type KnowledgeInput, knowledgeView } from './knowledge.ts';
import KnowledgeBrowser from './KnowledgeBrowser.svelte';

// The middle pane is the one part of this screen a server render cannot see: Markdown prints its
// source there and only marks up in the browser. Here the file is really rendered.
let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const FILE = '---\ndescription: How search is tested\n---\n\nRun the list first.\n';

const input: KnowledgeInput = {
  folder: '/work/recipes/.nolzu/knowledge',
  exists: true,
  prefix: '.nolzu/knowledge/',
  files: ['search.md'],
  open: { path: 'search.md', text: FILE },
  changes: [],
  cards: [],
  busy: null,
};

// Every form carries the file that is open, so the action reads `?file=<path>&/<name>`. Matched by
// its end, which is the part that names the action.
const formOf = (target: Element, name: string) => target.querySelector(`form[action$="/${name}"]`);

const pane = () => {
  page = mounted(KnowledgeBrowser as never, { view: knowledgeView(input) });
  return page.target.querySelector('.body');
};

// A commit is direct git work and not a run, so the button says it is going rather than waiting
// for the board snapshot. The click itself is what a server render cannot reach.
const waiting = () => {
  const change: KnowledgeChangeInput = {
    id: 1,
    runId: 7,
    cardKey: 'APP-1',
    filePath: '.nolzu/knowledge/search.md',
    commitSha: null,
    summary: 'added',
    status: 'pending',
    note: null,
    committedAt: null,
    diff: null,
    diffTooLarge: false,
  };
  page = mounted(KnowledgeBrowser as never, { view: knowledgeView({ ...input, changes: [change] }) });
  return page.target;
};

it('says the approve is going and takes no second click', () => {
  const target = waiting();
  const form = formOf(target, 'approve');

  form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  flushSync();

  expect(target.textContent).toContain('Applying the change and committing it in the knowledge folder.');
  // The pending block alone: Optimize sits beside it and is a run, so it follows the board snapshot
  // and not this click. Counted first, because every() and some() both answer about an empty list,
  // so a pending block that drew no buttons at all would read as a pass.
  expect(target.querySelectorAll('.waiting button[type="submit"]')).toHaveLength(2);
  expect([...target.querySelectorAll('.waiting button[type="submit"]')].every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
});

it('says the return is going, and says nothing about applying', () => {
  const target = waiting();
  const form = formOf(target, 'return');

  form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  flushSync();

  expect(target.textContent).toContain('Sending the change back with the note.');
  expect(target.textContent).not.toContain('Applying the change');
});

// A plain post reloaded the page at its top, and the answer printed far from Apply, so
// a press read as nothing happened. With `onpost` the page stays, and the answer prints under the list.
it('sends Apply in place and prints the answer under the pending list, not at the top', async () => {
  const sent: HTMLFormElement[] = [];
  let land: () => void = () => {};
  const target = waiting();
  page!.set({ onpost: (form: HTMLFormElement) => (sent.push(form), new Promise<void>((done) => (land = done))) });
  const form = formOf(target, 'approve')!;
  const submit = new Event('submit', { cancelable: true, bubbles: true });

  form.dispatchEvent(submit);
  flushSync();
  expect(submit.defaultPrevented).toBe(true);
  expect(sent).toEqual([form]);
  expect(target.textContent).toContain('Applying the change and committing it in the knowledge folder.');

  page!.set({ said: { ok: false, message: 'APP-2 is writing the knowledge folder right now.' } });
  land();
  await new Promise((done) => setTimeout(done, 0));
  flushSync();
  const said = target.querySelector('.said')!;
  expect(target.querySelectorAll('.said')).toHaveLength(1);
  expect(said.closest('section')?.querySelector('h2')?.textContent).toMatch(/^Pending review/);
  expect(said.getAttribute('role')).toBe('alert');
  expect(target.textContent).not.toContain('Applying the change');
  expect([...target.querySelectorAll('.waiting button[type="submit"]')].some((button) => (button as HTMLButtonElement).disabled)).toBe(false);
});

// An Apply answered ok takes its run out of the list at once, so it cannot be pressed again before the
// fresh view lands.
it('takes an applied run out of the pending list before the fresh view lands', async () => {
  let land: () => void = () => {};
  const target = waiting();
  page!.set({ onpost: () => new Promise<void>((done) => (land = done)) });
  formOf(target, 'approve')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  flushSync();
  page!.set({ said: { ok: true, message: 'Applied 1 file as commit abc1234.' } });
  land();
  await new Promise((done) => setTimeout(done, 0));
  flushSync();

  expect(target.querySelectorAll('.waiting')).toHaveLength(0);
  expect(target.querySelector('.said')?.textContent).toBe('Applied 1 file as commit abc1234.');
});

// Two runs waiting, each with its own kept lines, for Apply all and the large view.
const two = (extra: Record<string, unknown> = {}) => {
  const row = (id: number, runId: number, cardKey: string): KnowledgeChangeInput => ({
    id,
    runId,
    cardKey,
    filePath: '.nolzu/knowledge/search.md',
    commitSha: null,
    summary: 'added',
    status: 'pending',
    note: null,
    committedAt: null,
    diff: null,
    diffTooLarge: false,
  });
  const view = knowledgeView({ ...input, changes: [row(1, 7, 'APP-1'), row(2, 8, 'APP-2')] });
  const held = view.pending.map((one) => ({ ...one, held: [{ removed: [], added: [`A line ${one.runId} wrote.`] }] }));
  page = mounted(KnowledgeBrowser as never, { view: { ...view, pending: held }, ...extra });
  return page.target;
};

// Apply all posts exactly the runs on screen, and takes them all out of the list once it
// is answered ok. One run alone has no Apply all, since Apply is the same press.
it('sends every run on screen with Apply all, and empties the list on an ok answer', async () => {
  const sent: FormData[] = [];
  let land: () => void = () => {};
  const target = two({ onpost: (form: HTMLFormElement) => (sent.push(new FormData(form)), new Promise<void>((done) => (land = done))) });
  const all = [...target.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Apply all (2)')!;

  all.click();
  flushSync();
  expect(sent.map((form) => form.getAll('run'))).toEqual([['7', '8']]);
  expect(target.textContent).toContain('Applying every change, one commit each.');
  page!.set({ said: { ok: true, message: 'Applied 2 changes, one commit each.' } });
  land();
  await new Promise((done) => setTimeout(done, 0));
  flushSync();
  expect(target.querySelectorAll('.waiting')).toHaveLength(0);
  expect(target.querySelector('.said')?.textContent).toBe('Applied 2 changes, one commit each.');
  expect([...target.querySelectorAll('button')].some((button) => button.textContent?.trim().startsWith('Apply all'))).toBe(false);
});

it('draws no Apply all for one waiting run', () => {
  const target = waiting();
  expect([...target.querySelectorAll('button')].some((button) => button.textContent?.trim().startsWith('Apply all'))).toBe(false);
});

// The side pane caps each diff, so Read in full opens the run in a large dialog with its
// lines uncapped and Apply under them. Applied, the run leaves the list and the dialog goes with it.
it('opens a run in a large view with its lines and Apply, and closes it once applied', async () => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  let land: () => void = () => {};
  const sent: FormData[] = [];
  const target = two({ onpost: (form: HTMLFormElement) => (sent.push(new FormData(form)), new Promise<void>((done) => (land = done))) });
  const reads = [...target.querySelectorAll('button')].filter((button) => button.textContent?.trim() === 'Read in full');
  expect(reads).toHaveLength(2);

  reads[1]!.click();
  flushSync();
  const dialog = target.querySelector('dialog')!;
  expect(dialog.querySelector('.big ins')?.textContent).toBe('A line 8 wrote.');
  expect(dialog.querySelector('.big')?.classList.contains('kept')).toBe(false);
  [...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Apply')!.click();
  flushSync();
  expect(sent.map((form) => form.get('run'))).toEqual(['8']);
  page!.set({ said: { ok: true, message: 'Applied 1 file as commit abc1234.' } });
  land();
  await new Promise((done) => setTimeout(done, 0));
  flushSync();
  expect(target.querySelector('dialog')).toBeNull();
  expect(target.querySelectorAll('.waiting')).toHaveLength(1);
});

// With no `onpost` the form posts as a plain form, and the answer of that reload prints at the top.
it('posts the plain form with no onpost', () => {
  const target = waiting();
  const submit = new Event('submit', { cancelable: true, bubbles: true });
  formOf(target, 'approve')!.dispatchEvent(submit);
  expect(submit.defaultPrevented).toBe(false);
});

it('waits for nobody before the person answers', () => {
  const target = waiting();

  expect(target.textContent).not.toContain('Applying the change');
  expect(target.querySelectorAll('.waiting button[type="submit"]')).toHaveLength(2);
  expect([...target.querySelectorAll('.waiting button[type="submit"]')].some((button) => (button as HTMLButtonElement).disabled)).toBe(false);
});

// Revert is direct git work too, and it sits in the history of the open file.
const applied = () => {
  const change: KnowledgeChangeInput = {
    id: 4,
    runId: 7,
    cardKey: 'APP-1',
    filePath: '.nolzu/knowledge/search.md',
    commitSha: 'a1b2c3d4e5f6',
    summary: 'corrected',
    status: 'applied',
    note: null,
    committedAt: '2026-09-25T08:10:55+02:00',
    diff: '@@ -1 +1 @@\n+Run the list first.\n',
    diffTooLarge: false,
  };
  page = mounted(KnowledgeBrowser as never, { view: knowledgeView({ ...input, changes: [change] }) });
  return page.target;
};

it('says the revert is going and takes no second click', () => {
  const target = applied();
  const form = formOf(target, 'revert');

  form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  flushSync();

  expect(target.textContent).toContain('Making the revert commit in the knowledge folder.');
  expect(target.querySelectorAll('.change button')).toHaveLength(1);
  expect([...target.querySelectorAll('.change button')].every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
});

it('waits for nobody before the person clicks Revert', () => {
  const target = applied();

  expect(target.textContent).not.toContain('Making the revert commit');
  expect((target.querySelector('.change button') as HTMLButtonElement | null)?.disabled).toBe(false);
});

it('renders the file as markdown, with no heading made out of the frontmatter', () => {
  const body = pane();

  expect(body?.querySelector('p')?.textContent).toBe('Run the list first.');
  // Marked turns the two dash lines of a frontmatter block into a rule and a heading that repeat
  // the description the right pane already carries.
  expect(body?.querySelectorAll('hr, h1, h2')).toHaveLength(0);
  expect(body?.textContent).not.toContain('description:');
});

it('marks the file up rather than showing its source, which is what the middle pane is for', () => {
  const body = pane();

  expect(body?.querySelector('.markdown')?.tagName).toBe('DIV');
  expect(body?.querySelector('pre')).toBeNull();
});

// Optimize starts a run, and AGENTS.md says a button that starts a run reads its busy state from
// the board snapshot and never from the click. So the click leaves the button where it was: the
// next page load is what greys it out, because that load carries the snapshot.
const optimize = (over: Partial<KnowledgeInput> = {}) => {
  page = mounted(KnowledgeBrowser as never, { view: knowledgeView({ ...input, ...over }) });
  return page.target;
};

it('promises nothing of its own when Optimize is clicked', () => {
  // A change waits here too, so the click can be measured against the buttons that do promise
  // something: Approve and Return are direct git work and say they are going.
  const target = waiting();
  const before = target.textContent;

  formOf(target, 'optimize')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  flushSync();

  const button = formOf(target, 'optimize')?.querySelector('button') as HTMLButtonElement | undefined;
  expect(button?.disabled).toBe(false);
  expect([...target.querySelectorAll('.waiting button[type="submit"]')]).toHaveLength(2);
  expect([...target.querySelectorAll('.waiting button[type="submit"]')].some((one) => (one as HTMLButtonElement).disabled)).toBe(false);
  // Nothing at all moved on the screen. The next page load carries the board snapshot, and that is
  // what greys this button out.
  expect(target.textContent).toBe(before);
});

it('takes no click once the board snapshot says the lane is held', () => {
  const target = optimize({ busy: 'APP-1' });

  const button = formOf(target, 'optimize')?.querySelector('button') as HTMLButtonElement | undefined;
  expect(button?.disabled).toBe(true);
  // The sentence beside the button, which is this block's own. The left pane names the card, and
  // that line has tests of its own.
  expect(target.textContent).toContain('The knowledge lane is busy.');
  expect(target.textContent).toContain('APP-1 is writing knowledge.');
});

// The file opens plain, with the change one click away. Shown, the change sits
// between the real markup around it, in the order the file has them.
const SORTED_FILE = '# Recipe API\n\n## Sorting\n\nThe server sorts.\n\n## Errors\n\nThrow ApiDownError.\n';
const sorted = (diff = '@@ -3,3 +3,3 @@\n ## Sorting\n \n-Sort in the web app.\n+The server sorts.\n', text = SORTED_FILE) => {
  const change: KnowledgeChangeInput = {
    id: 2,
    runId: 7,
    cardKey: 'APP-1',
    filePath: '.nolzu/knowledge/search.md',
    commitSha: 'ffffffffffff',
    summary: 'sorted',
    status: 'applied',
    note: null,
    committedAt: '2026-09-25T08:10:55+02:00',
    diff,
    diffTooLarge: false,
  };
  const cards = [{ key: 'APP-1', title: 'Sort recipes by cooking time' }];
  page = mounted(KnowledgeBrowser as never, { view: knowledgeView({ ...input, open: { path: 'search.md', text }, changes: [change], cards }) });
  const body = page.target.querySelector('.body');
  const toggle = [...(body?.querySelectorAll('button') ?? [])].find((one) => one.textContent?.trim() === 'Show the change');
  return { body, toggle };
};

it('opens the file plain, with the card, Show the change and Revert above it', () => {
  const { body, toggle } = sorted();
  const head = body?.querySelector('.chg-h');

  expect(head?.textContent).toContain('Changed by APP-1 wrap-up · 2026-09-25');
  expect(head?.querySelector('a')?.getAttribute('href')).toBe('/t/APP-1');
  expect(head?.contains(toggle ?? null)).toBe(true);
  expect(toggle?.getAttribute('aria-pressed')).toBe('false');
  expect(formOf(head as Element, 'revert')).not.toBeNull();
  expect(body?.querySelector('del, ins')).toBeNull();
  expect([...(body?.querySelectorAll('h2, h3') ?? [])].map((one) => one.textContent)).toEqual(['Recipe API', 'Sorting', 'Errors']);
  expect(body?.textContent).toContain('The server sorts.');
});

it('shows the change between the rendered text around it, and hides it again', () => {
  const { body, toggle } = sorted();
  const heading = (words: string) => [...(body?.querySelectorAll('h1, h2, h3, h4') ?? [])].find((one) => one.textContent === words);
  const after = (first: Node | null | undefined, second: Node | null | undefined) =>
    first != null && second != null && (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  toggle?.click();
  flushSync();
  const block = body?.querySelector('del')?.closest('.change');
  expect(toggle?.getAttribute('aria-pressed')).toBe('true');
  expect(after(heading('Sorting'), block)).toBe(true);
  expect(after(block, heading('Errors'))).toBe(true);
  expect(block?.querySelector('del')?.textContent).toBe('Sort in the web app.');
  expect(block?.querySelector('ins')?.textContent).toBe('The server sorts.');

  toggle?.click();
  flushSync();
  expect(toggle?.getAttribute('aria-pressed')).toBe('false');
  expect(body?.querySelector('del, ins')).toBeNull();
});

it('keeps the inline code of a changed line', () => {
  const { body, toggle } = sorted('@@ -5 +5 @@\n-The server sorts.\n+Pass `sort=time` to sort.\n', SORTED_FILE.replace('The server sorts.', 'Pass `sort=time` to sort.'));
  toggle?.click();
  flushSync();

  expect(body?.querySelector('ins')?.innerHTML.replace(/<!---->/g, '')).toMatch(/Pass <code[^>]*>sort=time<\/code> to sort\./);
});

it('offers no toggle for the change that wrote the whole file', () => {
  const { body, toggle } = sorted('@@ -0,0 +1 @@\n+How search is tested\n', 'How search is tested\n');

  expect(body?.textContent).toContain('Written by APP-1 wrap-up · 2026-09-25');
  expect(toggle).toBeUndefined();
  expect(body?.querySelector('del, ins')).toBeNull();
});

// Search knowledge in the top bar narrows the file list by name and by what a file says. The
// route binds "/" to focusSearch through the app's one key handler.
it('filters the files by name and text, and focusSearch focuses the box', () => {
  const files = { ...input, files: ['api.md', 'search.md'], open: null, fileTexts: { 'api.md': 'Pass sort=time.', 'search.md': FILE } };
  page = mounted(KnowledgeBrowser as never, { view: knowledgeView(files) });
  const box = page.target.querySelector<HTMLInputElement>('input[data-search]')!;
  const names = () => [...page!.target.querySelectorAll('.kf .nm')].map((one) => one.textContent);
  const typeIn = (value: string) => {
    box.value = value;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
  };

  expect(box.closest('.top')?.querySelector('kbd')?.textContent).toBe('/');
  typeIn('SORT=');
  expect(names()).toEqual(['api.md']);
  typeIn('search');
  expect(names()).toEqual(['search.md']);
  typeIn('deploy');
  expect(names()).toEqual([]);
  expect(page.target.querySelector('.none')?.textContent).toBe('No file holds "deploy".');

});

it('focuses Search knowledge when the route asks', () => {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(KnowledgeBrowser, { target, props: { view: knowledgeView(input) } });
  flushSync();
  try {
    (instance as unknown as { focusSearch: () => void }).focusSearch();
    expect(document.activeElement).toBe(target.querySelector('input[data-search]'));
  } finally {
    void unmount(instance);
    target.remove();
  }
});

// A run writes its change summary in Markdown. History and Pending review sit under an h2 of the
// side pane, so a heading the run wrote starts at h3.
it('draws the change summaries as Markdown, under the side pane headings', () => {
  const said = '# Why\n\nRun the list **first**.';
  const change = (id: number, status: 'applied' | 'pending'): KnowledgeChangeInput => ({
    id,
    runId: id,
    cardKey: 'APP-1',
    filePath: '.nolzu/knowledge/search.md',
    commitSha: status === 'applied' ? 'ffffffffffff' : null,
    summary: said,
    status,
    note: null,
    committedAt: status === 'applied' ? '2026-09-25T08:10:55+02:00' : null,
    diff: null,
    diffTooLarge: false,
  });
  page = mounted(KnowledgeBrowser as never, { view: knowledgeView({ ...input, changes: [change(1, 'applied'), change(2, 'pending')] }) });

  for (const box of [page.target.querySelector('.hist'), page.target.querySelector('.waiting')]) {
    expect(box?.querySelector('strong')?.textContent).toBe('first');
    expect(box?.querySelector('h3')?.textContent).toBe('Why');
    expect(box?.querySelector('h1')).toBeNull();
    expect(box?.textContent).not.toContain('**');
  }
});

// The file list is a tree with one Tab stop. Up and down move, right and left open and close a
// folder or step in and out of it, Enter opens and closes a folder.
it('moves through the tree by keyboard and opens and closes folders', () => {
  const files = { ...input, files: ['api/repository.md', 'api/search.md', 'run-recipe.md', 'testing/unit.md'], repos: ['api', 'web'], open: null };
  page = mounted(KnowledgeBrowser as never, { view: knowledgeView(files) });
  const tree = page.target.querySelector<HTMLElement>('[role="tree"]')!;
  const press = (key: string) => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    flushSync();
  };
  const at = () => (document.activeElement as HTMLElement | null)?.dataset.key;
  const api = () => tree.querySelector('[data-key="api/"]')!;

  // No file is open, so the first row, the first repository's folder, is the one Tab stop.
  expect([...tree.querySelectorAll('[tabindex="0"]')].map((one) => (one as HTMLElement).dataset.key)).toEqual(['api/']);
  tree.querySelector<HTMLElement>('[tabindex="0"]')!.focus();
  expect(api().getAttribute('aria-expanded')).toBe('false');
  press('ArrowRight');
  expect(api().getAttribute('aria-expanded')).toBe('true');
  expect(api().querySelectorAll('a[role="treeitem"]')).toHaveLength(2);
  press('ArrowRight');
  expect(at()).toBe('api/repository.md');
  press('ArrowDown');
  expect(at()).toBe('api/search.md');
  press('ArrowLeft');
  expect(at()).toBe('api/');
  press('ArrowLeft');
  expect(api().getAttribute('aria-expanded')).toBe('false');
  press('Enter');
  expect(api().getAttribute('aria-expanded')).toBe('true');
  press('ArrowDown');
  press('ArrowDown');
  press('ArrowDown');
  expect(at()).toBe('testing/');
  // The top files come last.
  press('End');
  expect(at()).toBe('run-recipe.md');
  expect(tree.querySelector<HTMLElement>('[tabindex="0"]')?.dataset.key).toBe('run-recipe.md');
  press('Home');
  expect(at()).toBe('api/');
  // The row the arrows reached keeps the Tab stop.
  expect(tree.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  // A key that does not come from a row is left alone.
  (document.activeElement as HTMLElement).blur();
  expect(() => tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))).not.toThrow();
  expect(document.activeElement).toBe(document.body);
});

it('opens a folder on a click on its row, and opens every folder with a match while a search runs', () => {
  const files = { ...input, files: ['api/repository.md', 'testing/unit.md'], open: null, fileTexts: { 'api/repository.md': 'Pass sort=time.' } };
  page = mounted(KnowledgeBrowser as never, { view: knowledgeView(files) });
  const row = page.target.querySelector<HTMLElement>('[data-key="testing/"] .row')!;

  row.click();
  flushSync();
  expect(page.target.querySelector('[data-key="testing/"]')?.getAttribute('aria-expanded')).toBe('true');

  const box = page.target.querySelector<HTMLInputElement>('input[data-search]')!;
  box.value = 'sort=';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect([...page.target.querySelectorAll('.kf .nm')].map((one) => one.textContent)).toEqual(['repository.md']);
});

it('keeps the focus on the file a keyboard user opens', () => {
  page = mounted(KnowledgeBrowser as never, { view: knowledgeView({ ...input, files: ['run-recipe.md', 'api/repository.md'] }) });
  const links = [...page.target.querySelectorAll('a[role="treeitem"]')];
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect(link.hasAttribute('data-sveltekit-keepfocus')).toBe(true);
});

it('keeps the header and Search while the folder is read, with grey shapes in each pane', () => {
  page = mounted(KnowledgeBrowser as never, { view: null, repos: { repos: [{ path: 'api', stub: true }], starts: { engine: 'claude', model: 'm', effort: 'low', severalProfiles: false }, refusal: null } });
  const target = page.target;
  expect(target.querySelector('h1')?.textContent).toBe('Knowledge');
  expect(target.querySelector('[data-search]')).not.toBeNull();
  expect(target.querySelector('.list [data-skeleton]')?.getAttribute('data-shape')).toBe('list');
  expect(target.querySelector('.list [data-skeleton] .sr')?.textContent).toBe('Reading the knowledge folder with git.');
  expect(target.querySelectorAll('.doc [data-skeleton]').length).toBeGreaterThan(0);
  expect(target.querySelectorAll('.side [data-skeleton]').length).toBeGreaterThan(0);
  // Nothing that reads as an answer before the answer: no tree, no Learn, no Pending review, no Optimize.
  expect(target.querySelector('[role="tree"]')).toBeNull();
  expect(target.textContent).not.toMatch(/Pending review|Learn your repositories|Pick a file|Optimize/);
});
