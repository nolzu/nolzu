import { readFileSync } from 'node:fs';
import { KB_MAINTENANCE_KEY } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { type KnowledgeChangeInput, type KnowledgeInput, knowledgeView, NO_KNOWLEDGE } from './knowledge.ts';
import KnowledgeBrowser from './KnowledgeBrowser.svelte';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// The server render without its hydration marks, so a pattern can read an element and what is in it.
const plain = (body: string) => body.replace(/<!--[\s\S]*?-->/g, '');

const change = (over: Partial<KnowledgeChangeInput> = {}): KnowledgeChangeInput => ({
  id: 1,
  runId: 7,
  cardKey: 'APP-1',
  filePath: '.nolzu/knowledge/search.md',
  commitSha: 'a1b2c3d4e5f6',
  summary: 'How search is tested',
  status: 'applied',
  note: null,
  committedAt: '2026-09-25T08:10:55+02:00',
  diffTooLarge: false,
  diff: '@@ -0,0 +2 @@\n+How search is tested\n-The old line\n',
  ...over,
});

const input = (over: Partial<KnowledgeInput> = {}): KnowledgeInput => ({
  folder: '/work/recipes/.nolzu/knowledge',
  exists: true,
  prefix: '.nolzu/knowledge/',
  files: ['search.md'],
  open: { path: 'search.md', text: '---\ndescription: How search is tested\n---\n\nRun the list first.' },
  changes: [change()],
  cards: [{ key: 'APP-1', title: 'Search the recipe list' }],
  busy: null,
  ...over,
});

// The component draws what the rules module returns, so every state is built the same way the page
// builds it.
const draw = (over: Partial<KnowledgeInput> = {}) => render(KnowledgeBrowser, { props: { view: knowledgeView(input(over)) } }).body;

// What every form on this screen posts to. The file that is open travels with the post, because an
// action written as `?/name` alone replaces the whole query and closes the file. The `&` is escaped
// in an attribute, which is what a browser reads back as `&`.
const action = (name: string, file = 'search.md') => `action="?file=${encodeURIComponent(file)}&amp;/${name}"`;

it('draws the file, its description and its history', () => {
  const shown = text(draw());

  expect(shown).toContain('search.md');
  // The count goes beside the group and the day at the foot of the file list.
  expect(shown).toContain('Project 1');
  // The foot says the last Optimize, and never when nothing has been optimized yet.
  expect(shown).toContain('Last Optimize never');
  expect(shown).not.toContain('Last reviewed');
  expect(shown).toContain('How search is tested');
  // The server render shows markdown as its source, which is the Markdown component's own rule.
  expect(shown).toContain('Run the list first.');
  expect(shown).toContain('a1b2c3');
});

it('draws the diff of a change with the added and removed lines marked, not only coloured', () => {
  const body = draw();

  // The sign in front of the line says what it is, so the diff reads without colour too.
  const lines = [...body.matchAll(/data-line="(\w+)">([^<]*)</g)].map((found) => [found[1], found[2]]);
  expect(lines).toEqual([
    ['hunk', '@@ -0,0 +2 @@'],
    ['add', '+How search is tested'],
    ['del', '-The old line'],
  ]);
});

it('links the file list, so picking a file is a plain request and needs no script', () => {
  // The folder of the open file is drawn open, so its files are links before any script runs.
  const body = draw({ files: ['search.md', 'notes/a.md', 'notes/testing.md'], open: { path: 'notes/a.md', text: 'A.' } });

  expect(body).toContain('href="?file=notes%2Ftesting.md"');
  expect(body).toContain('href="?file=search.md"');
});

// One folder per repository, folded with its count, then Shared and other folders, then the top files.
it('draws the files as a tree grouped by repository, each folder folded with its count unless it holds the open file', () => {
  const files = ['api/repository.md', 'api/search.md', 'run-recipe.md', 'shared/lists.md', 'testing/unit.md', 'web/repository.md'];
  const body = plain(draw({ files, repos: ['api', 'web'], open: { path: 'testing/unit.md', text: 'Unit.' } }));

  expect(body).toContain('role="tree"');
  expect(text(body)).toMatch(/api 2 web 1 Shared 1 testing 1 unit\.md .*run-recipe\.md/);
  expect(body).toMatch(/aria-expanded="false"[^>]*data-key="api\/"/);
  expect(body).toMatch(/aria-expanded="true"[^>]*data-key="testing\/"/);
  expect(body).not.toContain('href="?file=api%2Fsearch.md"');
  // One Tab stop, on the open file.
  expect(body.match(/tabindex="0"/g)).toHaveLength(1);
  expect(body).toMatch(/tabindex="0" data-key="testing\/unit.md"/);
});

it('marks a file waiting for review, and counts it on its folded folder', () => {
  const waiting = change({ id: 2, filePath: '.nolzu/knowledge/web/repository.md', status: 'pending', commitSha: null, committedAt: null, diff: null });
  const files = ['search.md', 'web/form.md', 'web/repository.md'];
  const body = text(draw({ files, repos: ['api', 'web'], changes: [change(), waiting] }));

  expect(body).toContain('web 2 1 to review');
  // Open, the folder says which file waits, and its label still counts them for a screen reader.
  const open = draw({ files, repos: ['api', 'web'], changes: [change(), waiting], open: { path: 'web/form.md', text: 'A.' } });
  expect(open).toContain('aria-label="web, 2 files, 1 to review"');
  expect(text(open)).toMatch(/repository\.md not committed yet waiting for review/);
});

it('links the card that taught the file and marks the open file as the current page', () => {
  const body = draw();

  expect(body).toContain('href="/t/APP-1"');
  expect(body).toContain('aria-current="page"');
});

it('reads maintenance where a run belongs to no card, and offers no link', () => {
  const body = draw({ changes: [change({ cardKey: KB_MAINTENANCE_KEY })] });

  expect(text(body)).toContain('maintenance');
  expect(body).not.toContain('href="/t/');
});

it('keeps a change of a deleted card in the history and says the card is gone', () => {
  const body = draw({ changes: [change({ cardKey: 'APP-9' })] });

  expect(text(body)).toContain('card deleted');
  expect(body).not.toContain('href="/t/APP-9"');
});

it('renders the file without its frontmatter, so the description is not shown twice', () => {
  const body = draw();

  expect(text(body)).toContain('Run the list first.');
  // The server render prints the markdown source, and the frontmatter must be gone before it.
  expect(body).not.toContain('description: How search is tested</pre>');
  expect(body).not.toMatch(/<pre[^>]*>---/);
});

it('says why a change has no diff, naming the commit git could not find', () => {
  const shown = text(draw({ changes: [change({ diff: null })] }));

  expect(shown).toContain('git has no commit a1b2c3d in this folder, so there is no diff to show.');
});

it('says a change too large to show here belongs in the repository', () => {
  const shown = text(draw({ changes: [change({ diff: null, diffTooLarge: true })] }));

  expect(shown).toContain('This change is too large to show here.');
});

it('says no card is left when every change of the file came from one that was deleted', () => {
  const shown = text(draw({ changes: [change({ cardKey: 'APP-9' })] }));

  expect(shown).toContain('No change of this file names a card that is still here.');
});

it('says no run has changed a file that is in the folder with no row of its own', () => {
  const shown = text(draw({ files: ['notes/testing.md'], open: { path: 'notes/testing.md', text: 'Run the suite.' }, changes: [] }));

  expect(shown).toContain('No run has changed this file yet.');
});

it('names a maintenance run in words while it holds the folder', () => {
  const shown = text(draw({ busy: KB_MAINTENANCE_KEY }));

  expect(shown).toContain('A maintenance run is writing knowledge.');
  expect(shown).not.toContain(KB_MAINTENANCE_KEY);
});

// The run going, off the Now stream: the line names it with its time and what it does now, and the
// button that started it shows it running. The page clock counts the time.
it('names the knowledge run going, with its time and last action, on its line and its button', () => {
  const running = { name: 'Learn this project', since: '2026-10-12T11:58:55.000Z', line: 'Reading README.md' };
  const now = new Date('2026-10-12T12:00:00.000Z');
  const body = render(KnowledgeBrowser, { props: { view: knowledgeView(input({ busy: KB_MAINTENANCE_KEY, open: null })), running, now } }).body;

  expect(text(body)).toContain('Learn this project is writing knowledge · 1m 05s. The folder is locked until that run ends.');
  expect(text(body)).toContain('Reading README.md');
  expect(text(body)).not.toContain('A maintenance run');
  const busy = (html: string) => /<button[^>]*aria-busy="true"[^>]*>((?:(?!<\/button>)[\s\S])*)<\/button>/.exec(plain(html))?.[1] ?? '';
  expect(busy(body)).toMatch(/<span class="spin[^"]*" aria-hidden="true"><\/span>Learning this project · 1m 05s$/);

  const optimizing = render(KnowledgeBrowser, { props: { view: knowledgeView(input({ busy: KB_MAINTENANCE_KEY })), running: { ...running, name: 'Optimize' }, now } }).body;
  expect(busy(optimizing)).toMatch(/<span class="spin[^"]*" aria-hidden="true"><\/span>Optimizing · 1m 05s$/);
});

it('says the folder holds nothing yet, in its own words', () => {
  const shown = text(draw({ files: [], open: null, changes: [] }));

  expect(shown).toContain(NO_KNOWLEDGE);
  expect(shown).toContain('Project 0');
});

it('names the card that is writing while the folder is locked', () => {
  const shown = text(draw({ busy: 'APP-2' }));

  expect(shown).toContain('APP-2 is writing knowledge. The folder is locked until that run ends.');
});

it('shows a pending change with its file, its word and no diff, because it has no commit', () => {
  const shown = text(draw({ changes: [change({ status: 'pending', commitSha: null, committedAt: null, diff: null })] }));

  expect(shown).toContain('waiting for review');
  expect(shown).toContain('There is no commit yet. The change waits for a person.');
});

it('shows a reverted change with the word that says what happened to it', () => {
  const shown = text(draw({ changes: [change({ status: 'reverted' })] }));

  expect(shown).toContain('reverted');
  expect(shown).toContain('Nothing waits for a person.');
});

it('says there is no project when the folder could not be worked out', () => {
  const shown = text(draw({ folder: null, exists: false, files: [], open: null, changes: [] }));

  expect(shown).toContain('There is no project set');
  expect(shown).not.toContain(NO_KNOWLEDGE);
});

it('names the folder that is not there yet', () => {
  const shown = text(draw({ exists: false, files: [], open: null, changes: [] }));

  expect(shown).toContain('/work/recipes/.nolzu/knowledge');
  expect(shown).toContain('The first wrap-up that teaches something makes it.');
});

// Revert sits in the change history of the open file, which is where it sits.
// The other button on the side is Optimize, which every open file carries.
it('offers Revert on an applied change, with the change it answers', () => {
  const body = draw();

  expect(text(body)).toContain('Revert');
  expect(body).toContain(action('revert'));
  expect(body).toContain('name="change" value="1"');
  expect([...body.matchAll(/<button/g)]).toHaveLength(2);
});

it('says what Revert does before it is clicked', () => {
  expect(text(draw())).toContain('Commits this file back to what it was before this change.');
});

// A file taught twice. The older commit cannot be taken back on its own, so only the newer one
// carries a button.
it('offers Revert on the newest applied change alone', () => {
  const body = draw({ changes: [change({ id: 1 }), change({ id: 2, commitSha: 'ffffffffffff' })] });

  expect([...body.matchAll(/&amp;\/revert"/g)]).toHaveLength(1);
  expect(body).toContain('name="change" value="2"');
});

// The other side. A change that is not applied is not in the files, so there is nothing to take
// back and no button.
it('offers no Revert on a change that was reverted, waits for review or was returned', () => {
  for (const status of ['reverted', 'pending', 'returned'] as const) {
    expect(draw({ changes: [change({ status, commitSha: status === 'reverted' ? 'a1b2c3d4e5f6' : null, diff: null })] })).not.toContain(action('revert'));
  }
});

it('offers a Revert per file when one run taught two, because each row is its own change', () => {
  const body = draw({
    files: ['search.md', 'testing.md'],
    changes: [change({ id: 1 }), change({ id: 2, filePath: '.nolzu/knowledge/testing.md' })],
  });

  // One file is open, so the history of that file holds one of the two rows.
  expect([...body.matchAll(/&amp;\/revert"/g)]).toHaveLength(1);
  expect(body).toContain('name="change" value="1"');
});

describe('a change waiting for review', () => {
  const waiting = (over: Partial<KnowledgeChangeInput> = {}) =>
    change({ status: 'pending', commitSha: null, committedAt: null, diff: null, ...over });

  it('offers Approve and Return, with a note field for the return', () => {
    const body = draw({ changes: [waiting()] });

    // The button is named Apply. It posts to the same approve action.
    expect(text(body)).toContain('Apply');
    expect(text(body)).toContain('Why it goes back');
    expect(body).toContain(action('approve'));
    expect(body).toContain(action('return'));
    // The run travels with the post, because one run is one commit.
    expect(body).toContain('name="run" value="7"');
    expect(body).toContain('name="note"');
  });

  // One run is one commit, so the two buttons answer the whole run and not one file of it.
  it('draws one pair of buttons for a run that wrote two files', () => {
    const body = draw({
      files: ['search.md', 'testing.md'],
      changes: [waiting({ id: 1 }), waiting({ id: 2, filePath: '.nolzu/knowledge/testing.md' })],
    });

    expect([...body.matchAll(/&amp;\/approve"/g)]).toHaveLength(1);
    expect(text(body)).toContain('search.md');
    expect(text(body)).toContain('testing.md');
  });

  it('draws a pair of buttons per run when two runs are waiting', () => {
    const body = draw({ changes: [waiting({ id: 1, runId: 7 }), waiting({ id: 2, runId: 8 })] });

    expect([...body.matchAll(/&amp;\/approve"/g)]).toHaveLength(2);
  });
});

it('shows what the last approve or return answered, refused or done', () => {
  const view = knowledgeView(input());
  const refused = render(KnowledgeBrowser, { props: { view, said: { ok: false, message: 'The kept copy of this change is gone.' } } }).body;

  expect(text(refused)).toContain('The kept copy of this change is gone.');
  expect(refused).toContain('role="alert"');
});

it('shows the note a returned change was sent back with, so the history says why', () => {
  const shown = text(
    draw({ changes: [change({ status: 'returned', commitSha: null, committedAt: null, diff: null, note: 'Name the endpoint, not the file.' })] }),
  );

  expect(shown).toContain('Returned with this note: Name the endpoint, not the file.');
  expect(shown).toContain('This change was returned, so nothing was committed and there is no diff.');
  // Nothing is waiting: the change was answered.
  expect(shown).toContain('Nothing waits for a person.');
});

it('sets no colour literal, so the screen stays on the design tokens', () => {
  const source = new URL('./KnowledgeBrowser.svelte', import.meta.url);
  const written = readFileSync(source, 'utf8');

  expect(written).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(written).not.toMatch(/oklch\(/);
});

// No DOM here lays out a page, so the sum is read off the component: a file name in an open folder
// starts where the folder's label does, after the row's padding, the chevron and the gap.
it('lines the file names in a folder up with its label', () => {
  const css = readFileSync(new URL('./KnowledgeBrowser.svelte', import.meta.url), 'utf8');
  const px = (rule: RegExp) => Number(css.match(rule)?.[1]);

  const label = px(/\n {2}\.row \{[^}]*padding: \d+px (\d+)px;/) + px(/\n {2}\.chev \{[^}]*width: (\d+)px;/) + px(/\n {2}\.row \{[^}]*gap: (\d+)px;/);
  const name = px(/\n {2}\.tree ul \{[^}]*padding-left: (\d+)px;/) + px(/\n {2}\.kf \{[^}]*padding: \d+px (\d+)px;/);

  expect(label).toBe(30);
  expect(name).toBe(label);
});

// Optimize is the one button on this screen that starts a run. It rewrites
// the file that is open, so it is drawn only while one is.
describe('Optimize', () => {
  // A file that is neither the first in the list nor the fixture's usual one, so the hidden input
  // can only read right if it is bound to the file that is open.
  const deeper = { files: ['search.md', 'notes/testing.md'], open: { path: 'notes/testing.md', text: '# Testing\n\nRun the list first.' } };

  it('posts the open file, and says what the run does', () => {
    const body = draw(deeper);

    expect(body).toContain(action('optimize', 'notes/testing.md'));
    expect(body).toContain('name="file" value="notes/testing.md"');
    expect(text(body)).toContain('Rewrites this file so it stays short and true.');
  });

  // The post carries the file, so the person lands back on the file they optimized. Without it the
  // action would replace the whole query and the screen would come back with nothing open.
  it('says to open the file again, never to reload, because a reload posts it twice', () => {
    expect(text(draw())).toContain('Open the file again to see how the run ended.');
    expect(text(draw())).not.toContain('Reload');
  });

  it('is not drawn while no file is open', () => {
    expect(draw({ open: null })).not.toContain('/optimize"');
  });

  // The busy state comes from the board snapshot and from nowhere else, so a run already writing
  // the folder is what greys the button out.
  it('takes no click while the knowledge lane is held', () => {
    const body = draw({ busy: KB_MAINTENANCE_KEY });

    expect(body).toMatch(/&amp;\/optimize"[\s\S]*?<button[^>]*disabled/);
    expect(text(body)).toContain('The knowledge lane is busy.');
  });

  it('takes a click while nothing is writing the folder', () => {
    const body = draw();

    expect(body).toMatch(/&amp;\/optimize"[\s\S]*?<button(?![^>]*disabled)/);
  });

  // The one run on this screen, so the one amber go button. Approve, Return and Revert are git work.
  it('is the go button, and the only one on the screen', () => {
    const body = draw({ changes: [change(), change({ id: 2, runId: 8, status: 'pending', commitSha: null, committedAt: null, diff: null })] });

    for (const name of ['optimize', 'approve', 'return', 'revert']) expect(body).toContain(`&amp;/${name}"`);
    expect(body).toMatch(/&amp;\/optimize"[\s\S]*?<button[^>]*class="[^"]*\bgo\b/);
    expect(body.match(/class="[^"]*\bbtn go\b/g)).toHaveLength(1);
  });
});

// The change, inline in the open file.
describe('the change in the file', () => {
  const FILE = '# Recipe API\n\n## Sorting\n\nThe server sorts.\n\n## Errors\n\nThrow ApiDownError.\n';
  const SORTED = '@@ -3,3 +3,3 @@\n ## Sorting\n \n-Sort in the web app.\n+The server sorts.\n';
  const sorted = (over: Partial<KnowledgeInput> = {}) =>
    draw({ open: { path: 'search.md', text: FILE }, changes: [change({ id: 1 }), change({ id: 2, commitSha: 'ffffffffffff', diff: SORTED })], ...over });

  // The person reads the file first. The change is one click away, and the toggle is in the
  // browser only, so the inline lines are in the mount tests.
  it('draws the plain file, with one line above it: its card, Show the change and Revert', () => {
    const body = plain(sorted());
    const block = body.slice(body.indexOf('<div class="change'), body.indexOf('<pre class="markdown'));

    expect(text(block)).toContain('Changed by APP-1 wrap-up · 2026-09-25');
    expect(block).toContain('href="/t/APP-1"');
    expect(block).toMatch(/<button[^>]*aria-pressed="false"[^>]*>\s*Show the change<\/button>/);
    expect(block).toContain(action('revert'));
    expect(block).toContain('name="change" value="2"');
    expect(body).not.toContain('<del');
    expect(body).not.toContain('<ins');
    expect(body).toContain('## Sorting\n\nThe server sorts.\n\n## Errors');
  });

  it('says the card wrote the file at the top, and marks no line, for the change that made it', () => {
    const body = draw({ open: { path: 'search.md', text: 'How search is tested\n' } });

    expect(text(body)).toContain('Written by APP-1 wrap-up · 2026-09-25');
    expect(body).not.toContain('<ins');
    expect(body).not.toContain('Show the change');
  });

  it('keeps the card and Revert above the file, with no toggle, for a change it cannot place', () => {
    const body = sorted({ changes: [change({ diff: '@@ -3,3 +3,3 @@\n ## Gone\n \n-Old line.\n+A line the file no longer has.\n' })] });

    expect(text(body)).toContain('Changed by APP-1 wrap-up · 2026-09-25');
    expect(body).toContain(action('revert'));
    expect(body).not.toContain('Show the change');
  });

  it('names a maintenance run in words where it changed the file, with no link', () => {
    const body = sorted({ changes: [change({ cardKey: KB_MAINTENANCE_KEY, diff: SORTED })] });

    expect(text(body)).toContain('Changed by a maintenance run · 2026-09-25');
    expect(body).not.toContain('href="/t/');
  });

  it('draws the file whole, with no Revert, while none of its changes is applied', () => {
    const body = sorted({ changes: [change({ status: 'pending', commitSha: null, committedAt: null, diff: null })] });

    expect(body).not.toContain('<ins');
    expect(body).not.toContain(action('revert'));
  });

  it('names the file from its repository and counts its lines above it', () => {
    expect(text(sorted())).toContain('.nolzu/knowledge/search.md · 9 lines');
  });
});

// The three git answers keep their posts: the same action, the same fields.
it('posts Revert, Apply and Return as before, and Optimize with the open file', () => {
  const body = draw({ changes: [change(), change({ id: 2, runId: 8, status: 'pending', commitSha: null, committedAt: null, diff: null })] });
  const forms = [...body.matchAll(/<form method="POST" action="\?file=search\.md&amp;\/(\w+)"[^>]*>([\s\S]*?)<\/form>/g)].map(
    (found) => [found[1], [...(found[2] ?? '').matchAll(/name="(\w+)"/g)].map((name) => name[1])],
  );

  expect(Object.fromEntries(forms)).toEqual({ optimize: ['file'], revert: ['change'], approve: ['run'], return: ['run', 'note'] });
  expect(body).toContain('name="run" value="8"');
});

it('sends the run of the waiting change in both Apply and Return, and the change id in Revert', () => {
  const body = draw({ changes: [change({ id: 3 }), change({ id: 4, runId: 8, status: 'pending', commitSha: null, committedAt: null, diff: null })] });
  const valueIn = (name: string, field: string) =>
    new RegExp(`action="\\?file=search\\.md&amp;\\/${name}"[^>]*>[\\s\\S]*?name="${field}" value="(\\d+)"`).exec(body)?.[1];

  expect(valueIn('approve', 'run')).toBe('8');
  expect(valueIn('return', 'run')).toBe('8');
  expect(valueIn('revert', 'change')).toBe('3');
});

it('lists the history of the open file newest first, with the lines each change added and took out', () => {
  const body = draw({
    changes: [
      change({ id: 1, summary: 'First note', committedAt: '2026-09-20T10:00:00+02:00' }),
      change({ id: 2, summary: 'Second note', committedAt: '2026-09-22T10:00:00+02:00', diff: '@@ -1 +1,2 @@\n-old\n+new\n+newer\n' }),
      change({ id: 3, summary: 'Third note', status: 'reverted', committedAt: '2026-09-24T10:00:00+02:00' }),
    ],
  });
  const history = /<ul class="hist[^"]*">([\s\S]*?)<\/ul>/.exec(body)?.[1] ?? '';

  expect([...text(history).matchAll(/(First|Second|Third) note/g)].map((found) => found[1])).toEqual(['Third', 'Second', 'First']);
  expect(text(history)).toContain('2026-09-22 +2 -1');
  expect(text(history)).toContain('2026-09-24 reverted');
});

it('shows what a change waiting for review would write, with Apply and Return under it', () => {
  const held = { before: 'Run the list first.\n', after: 'Run the list first.\nThen open one recipe.\n' };
  const body = plain(draw({ changes: [change({ status: 'pending', commitSha: null, committedAt: null, diff: null, held })] }));
  const waiting = /<div class="waiting[^"]*">([\s\S]*)<\/aside>/.exec(body)?.[1] ?? '';

  expect(waiting).toMatch(/<ins[^>]*>Then open one recipe\.<\/ins>/);
  expect(waiting.indexOf('</ins>')).toBeLessThan(waiting.indexOf(action('approve')));
  expect(text(body)).toContain('Pending review 1');
  expect(text(body)).toContain('The next wrap-up of this card reads the note.');
});

// A returned note goes to the next run of the same kind, and a maintenance run has no card.
it('says which run reads the note of a returned maintenance change', () => {
  const waiting = { status: 'pending' as const, commitSha: null, committedAt: null, diff: null };
  const said = (phase: string) => text(draw({ changes: [change({ cardKey: KB_MAINTENANCE_KEY, phase, ...waiting })] }));

  expect(said('orient')).toContain('Drops the files. The next Learn this project run reads the note.');
  expect(said('optimize')).toContain('Drops the files. The next Optimize run reads the note.');
});

// A deleted card's kept change names a key no card has, so nothing would read a returned note.
it('says no run reads the note of a change whose card was deleted', () => {
  const waiting = { status: 'pending' as const, commitSha: null, committedAt: null, diff: null };
  expect(text(draw({ changes: [change({ cardKey: 'APP-3 (deleted)', ...waiting })] }))).toContain('Drops the files. Its card was deleted, so no run reads the note.');
});

it('dates each file in the list, and says when Optimize last changed one', () => {
  const shown = text(
    draw({
      files: ['search.md', 'testing.md'],
      fileDates: { 'search.md': '2026-10-06T09:00:00+02:00' },
      changes: [change({ cardKey: KB_MAINTENANCE_KEY, committedAt: '2026-10-04T10:00:00+02:00' })],
    }),
  );

  expect(shown).toContain('search.md updated 2026-10-06');
  expect(shown).toContain('testing.md not committed yet');
  expect(shown).toContain('Last Optimize 4 Oct');
  expect(shown).toContain('.nolzu/knowledge');
});

describe('the review switch', () => {
  const drawn = (review: boolean | null) => render(KnowledgeBrowser, { props: { view: knowledgeView(input()), review } }).body;

  it('posts the review setting from the foot of the side pane, checked while it is on', () => {
    const body = drawn(true);

    expect(body).toContain(action('review'));
    expect(body).toContain('name="field" value="reviewKnowledge"');
    expect(body).toMatch(/<input[^>]*role="switch"[^>]*checked/);
    expect(text(body)).toContain('Review changes before applying');
  });

  it('is off while the setting is off, and is not drawn when the page passes no setting', () => {
    expect(drawn(false)).not.toMatch(/<input[^>]*role="switch"[^>]*checked/);
    expect(drawn(null)).not.toContain('role="switch"');
  });

  // Cream when on, never amber: a setting starts no run.
  it('is not a go button', () => {
    expect(drawn(true).match(/class="[^"]*\bbtn go\b/g)).toHaveLength(1);
  });
});

describe('the path check', () => {
  const NOTE = '---\ndescription: Read before changing search.\npaths: src/search.ts, .tasks/APP-1/design.html, web/app.ts\n---\n\nSearch is tested in the browser.';
  const onBase = { 'src/search.ts': true, '.tasks/APP-1/design.html': false };

  it('says in words, not colour, which paths the base branch no longer has', () => {
    const shown = text(draw({ open: { path: 'search.md', text: NOTE }, pathsOnBase: onBase }));

    expect(shown).toContain('Depends on 3');
    expect(shown).toContain('src/search.ts on the base branch');
    expect(shown).toContain('.tasks/APP-1/design.html not on the base branch');
    expect(shown).toContain('web/app.ts not checked');
    expect(shown).toContain('1 path not on the base branch');
  });

  it('says a file from before the entry shape names no paths, and marks no row', () => {
    const shown = text(draw());

    expect(shown).toContain('This file names no paths it depends on.');
    expect(shown).not.toContain('not on the base branch');
  });
});

// Learn this project belongs to no card, so this screen offers it and answers its questions.
describe('Learn this project', () => {
  const learnSection = (body: string) => /<section class="sec learn[^"]*"[^>]*>([\s\S]*?)<\/section>/.exec(plain(body))?.[1] ?? '';

  // The screen's first view, with no file open. Beside an open file Optimize is the one go button.
  it('offers the run as the go button while no file is open, held while the knowledge lane is busy', () => {
    const idle = learnSection(draw({ open: null }));
    expect(idle).toContain('action="?/learn"');
    expect(text(idle)).toContain('asks you up to four questions, and writes up to three short files. They wait here for your review.');
    expect(idle).toMatch(/class="[^"]*\bbtn go\b/);
    expect(learnSection(draw({ open: null, busy: 'APP-1' }))).toMatch(/<button[^>]*disabled/);
    expect(learnSection(draw())).toBe('');
  });

  it('draws the question it waits on with an answer button for each answer, and Send and resume', () => {
    const asked = { question: 'Is a folder off limits?', options: [{ label: 'The tickets folder', means: 'no run may change it.' }, { label: 'Skip', means: 'nothing to add.' }] };
    const body = learnSection(render(KnowledgeBrowser, { props: { view: knowledgeView(input({ open: null })), learn: asked } }).body);

    expect(text(body)).toContain('Learn this project asks Is a folder off limits?');
    expect(body).toContain('action="?/answer"');
    expect(body.match(/class="opt[ "]/g)).toHaveLength(2);
    expect(body).toMatch(/<textarea[^>]*name="answer"/);
    expect(text(body)).toContain('Send and resume');
    expect(body).not.toContain('action="?/learn"');
  });
});

// Learn your repositories: the repositories with which ones have only their first lines, ticked at
// first, the Starts line every run shows before it starts, and the go button.
describe('Learn your repositories', () => {
  const reposSection = (body: string) => /<section class="sec learn[^"]*" id="learn-repos"[^>]*>([\s\S]*?)<\/section>/.exec(plain(body))?.[1] ?? '';
  const offer = (over: Record<string, unknown> = {}) => ({
    repos: [
      { path: 'api', stub: true },
      { path: 'web', stub: false },
    ],
    starts: { engine: 'claude-code', model: 'haiku', effort: 'low', severalProfiles: false },
    refusal: null,
    ...over,
  });
  const drawRepos = (repos: ReturnType<typeof offer> | null, over: Partial<KnowledgeInput> = { open: null }) =>
    reposSection(render(KnowledgeBrowser, { props: { view: knowledgeView(input(over)), repos } }).body);

  it('lists each repository, ticks the ones with only their first lines, and shows what each run starts on', () => {
    const body = drawRepos(offer());

    expect(body).toContain('action="?/learnRepos"');
    expect(body).toMatch(/<input type="checkbox" name="repo" value="api"[^>]*checked/);
    expect(body).not.toMatch(/<input type="checkbox" name="repo" value="web"[^>]*checked/);
    expect(text(body)).toContain('api not learned yet');
    expect(text(body)).toContain('web learned');
    expect(text(body)).toContain('Starts: Claude Code · haiku · low');
    expect(text(body)).toContain('No estimate yet: this project has no measured run of this kind.');
    expect(text(body)).toContain('Learn 1 repository');
    expect(body).toMatch(/class="[^"]*\bbtn go\b/);
  });

  // A result that waits in Pending review is neither missing nor learned, and is not ticked again.
  it('says a repository waits for review, and leaves its box unticked', () => {
    const body = drawRepos(offer({ repos: [{ path: 'api', stub: true, waiting: true }] }));

    expect(text(body)).toContain('api waiting for review');
    expect(body).not.toMatch(/<input type="checkbox" name="repo" value="api"[^>]*checked/);
  });

  it('shows the estimate per repository once runs measured one', () => {
    const estimate = { costUsd: 0.006, lowMs: 20_000, highMs: 40_000, from: 'history' as const, runs: 5 };
    const body = drawRepos(offer({ starts: { engine: 'claude-code', model: 'haiku', effort: 'low', severalProfiles: false, estimate } }));

    expect(text(body)).toMatch(/per repository, from 5 runs in this project\./);
  });

  // Before a Learn run is measured, a Refine run on the same model and effort is the low end.
  it('names a Refine run on the same model and effort before any Learn run is measured', () => {
    const like = { costUsd: 0.048, lowMs: 21_000, highMs: 21_000, from: 'preset' as const, runs: 0 };
    const body = drawRepos(offer({ starts: { engine: 'claude-code', model: 'haiku', effort: 'low', severalProfiles: false, like } }));

    expect(text(body)).toContain('No Learn run measured yet. A Refine run on this model and effort is about $0.05 · under a minute, and a Learn run reads more files, so expect more per repository.');
  });

  // A repository in a Learn chain is not offered again while the chain runs.
  it('shows the repositories a Learn run is on as queued, unticked and off, with no go button', () => {
    const body = drawRepos(offer({ repos: [{ path: 'api', stub: true, queued: 'running' }, { path: 'web', stub: true, queued: 'waiting' }, { path: 'docs', stub: false }] }));

    expect(text(body)).toContain('api learning now');
    expect(text(body)).toContain('web waiting to learn');
    expect(body).toMatch(/<input type="checkbox" name="repo" value="web"[^>]*disabled/);
    expect(body).not.toMatch(/<input type="checkbox" name="repo" value="web"[^>]*checked/);
    expect(text(body)).toContain('Learn runs are going, one after another.');
    expect(text(body)).not.toMatch(/Learn \d+ repositor/);
  });

  it('says every repository is learned in place of a button that counts none', () => {
    const body = drawRepos(offer({ repos: [{ path: 'api', stub: false }, { path: 'web', stub: true, waiting: true }] }));

    expect(text(body)).toContain('Every repository is learned or waits for review.');
    expect(text(body)).not.toContain('Learn 0 repositories');
  });

  it('says why no run would start in place of the Starts line, and holds the button', () => {
    const body = drawRepos(offer({ refusal: 'Learn your repositories uses haiku, which Claude Code no longer offers. Learn your repositories will not start until you pick another.' }));

    expect(text(body)).toContain('Claude Code no longer offers.');
    expect(text(body)).not.toContain('Starts:');
    expect(body).toMatch(/<button[^>]*disabled/);
    expect(drawRepos(offer(), { open: null, busy: 'APP-1' })).toMatch(/<button[^>]*disabled/);
  });

  it('draws nothing beside an open file, or with no repository', () => {
    expect(drawRepos(offer(), {})).toBe('');
    expect(drawRepos(offer({ repos: [] }))).toBe('');
    expect(drawRepos(null)).toBe('');
  });
});
