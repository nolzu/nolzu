import { KB_MAINTENANCE_KEY, learnRepoKey } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import {
  changeSource,
  codeSpans,
  dayMonth,
  fileBody,
  fileMatches,
  frontmatterDescription,
  type KnowledgeChangeInput,
  type KnowledgeInput,
  knowledgeTree,
  knowledgeView,
  lineGroups,
  NO_KNOWLEDGE,
  pendingRuns,
} from './knowledge.ts';

const CARDS = [{ key: 'APP-1', title: 'Search the recipe list' }];

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
  diff: '@@ -0,0 +1 @@\n+How search is tested\n',
  ...over,
});

const input = (over: Partial<KnowledgeInput> = {}): KnowledgeInput => ({
  folder: '/work/recipes/.nolzu/knowledge',
  exists: true,
  prefix: '.nolzu/knowledge/',
  files: ['search.md'],
  open: { path: 'search.md', text: 'How search is tested.' },
  changes: [change()],
  cards: CARDS,
  busy: null,
  ...over,
});

describe('the description of a file', () => {
  it('reads it out of the frontmatter block at the top', () => {
    expect(frontmatterDescription('---\ndescription: How search is tested\ntitle: Search\n---\n\nThe body.')).toBe('How search is tested');
  });

  it('takes the quotes off, because they belong to the file format', () => {
    expect(frontmatterDescription('---\ndescription: "How search is tested"\n---\n')).toBe('How search is tested');
  });

  it('answers null for a file with no frontmatter, an empty description or a block that never closes', () => {
    expect(frontmatterDescription('# Search\n\nThe body.')).toBeNull();
    expect(frontmatterDescription('---\ndescription:\n---\n')).toBeNull();
    expect(frontmatterDescription('---\ndescription: How search is tested\n')).toBeNull();
  });

  it('reads no description out of the body, because only the top block is frontmatter', () => {
    expect(frontmatterDescription('# Search\n\n---\ndescription: not the frontmatter\n---\n')).toBeNull();
  });
});

describe('the paths a file depends on', () => {
  const NOTE = '---\ndescription: Read before changing search.\npaths: src/search.ts, .tasks/APP-1/design.html, src/new.ts\n---\n\nSearch is tested in the browser.';
  const onBase = { 'src/search.ts': true, '.tasks/APP-1/design.html': false };

  it('marks each path the base branch has, has not, or was not asked about', () => {
    const view = knowledgeView(input({ open: { path: 'search.md', text: NOTE }, pathsOnBase: onBase }));
    expect(view.open?.paths).toEqual([
      { path: 'src/search.ts', state: 'there' },
      { path: '.tasks/APP-1/design.html', state: 'gone' },
      { path: 'src/new.ts', state: 'unchecked' },
    ]);
  });

  // The open file's row reads the open text, so it is marked even where the page read no texts.
  it('names the gone paths on the file row, open or not, and none for a file with no paths key', () => {
    const view = knowledgeView(input({ files: ['old.md', 'search.md'], open: { path: 'search.md', text: NOTE }, fileTexts: { 'old.md': NOTE }, pathsOnBase: onBase }));
    expect(view.files.map((file) => file.gone)).toEqual([['.tasks/APP-1/design.html'], ['.tasks/APP-1/design.html']]);
    expect(knowledgeView(input({ pathsOnBase: onBase })).files.map((file) => file.gone)).toEqual([[]]);
    expect(knowledgeView(input()).open?.paths).toEqual([]);
  });
});

describe('the body of a file', () => {
  it('leaves the frontmatter block out, so the middle pane never repeats the description', () => {
    expect(fileBody('---\ndescription: How search is tested\n---\n\nRun the list first.')).toBe('Run the list first.');
    // Rendered as markdown the two dash lines become a rule and a heading. Neither may reach the pane.
    expect(knowledgeView(input({ open: { path: 'search.md', text: '---\ndescription: How search is tested\n---\n\nRun the list first.' } })).open?.body).not.toContain('---');
  });

  it('keeps a file with no frontmatter whole, dashes further down included', () => {
    expect(fileBody('# Search\n\n---\n\nThe body.')).toBe('# Search\n\n---\n\nThe body.');
  });

  it('keeps a block that never closes, because it is text and not frontmatter', () => {
    expect(fileBody('---\ndescription: How search is tested\n')).toBe('---\ndescription: How search is tested\n');
  });
});

describe('who taught a change', () => {
  it('names the card that exists', () => {
    expect(changeSource('APP-1', CARDS)).toEqual({ kind: 'card', key: 'APP-1', title: 'Search the recipe list' });
  });

  it('answers maintenance for a run that belongs to no card', () => {
    expect(changeSource(KB_MAINTENANCE_KEY, CARDS)).toEqual({ kind: 'maintenance', key: null, title: null });
  });

  it('answers null for a card that was deleted, so no link is offered to a card that is gone', () => {
    expect(changeSource('APP-9', CARDS)).toBeNull();
  });
});

describe('the taught-by list', () => {
  const rows = [
    change({ id: 1, cardKey: 'APP-1' }),
    change({ id: 2, cardKey: 'APP-9' }),
    change({ id: 3, cardKey: KB_MAINTENANCE_KEY }),
    change({ id: 4, cardKey: 'APP-1' }),
  ];

  it('keeps the card that exists, skips the card that was deleted and reads maintenance once', () => {
    const view = knowledgeView(input({ changes: rows }));

    expect(view.open?.taughtBy).toEqual([
      { kind: 'card', key: 'APP-1', title: 'Search the recipe list' },
      { kind: 'maintenance', key: null, title: null },
    ]);
  });

  it('leaves out a card whose change was reverted, because it taught nothing that is still there', () => {
    const view = knowledgeView(input({ changes: [change({ id: 1, cardKey: 'APP-1', status: 'reverted' })] }));

    expect(view.open?.taughtBy).toEqual([]);
    // The change itself stays in the history, with the word that says what happened to it.
    expect(view.open?.history.map((one) => one.statusLabel)).toEqual(['reverted']);
  });

  it('holds only the changes of the open file', () => {
    const other = change({ id: 2, filePath: '.nolzu/knowledge/testing.md', cardKey: KB_MAINTENANCE_KEY });

    expect(knowledgeView(input({ files: ['search.md', 'testing.md'], changes: [change(), other] })).open?.taughtBy).toEqual([
      { kind: 'card', key: 'APP-1', title: 'Search the recipe list' },
    ]);
  });
});

describe('the change history', () => {
  it('shows the newest change first, with its short sha, day and diff', () => {
    const view = knowledgeView(input({ changes: [change({ id: 1 }), change({ id: 2, commitSha: 'ffffffffffff', committedAt: '2026-09-26T09:00:00+02:00' })] }));

    expect(view.open?.history.map((one) => one.id)).toEqual([2, 1]);
    expect(view.open?.history[0]).toMatchObject({ shortSha: 'fffffff', when: '2026-09-26' });
    expect(view.open?.history[1]?.diff).toContain('+How search is tested');
  });

  it('names the file by its path inside the folder, whatever git calls it', () => {
    expect(knowledgeView(input()).open?.history[0]?.path).toBe('search.md');
  });

// Revert is offered on one change of one file, and only while the folder can still take it back.
describe('which change of the open file can be reverted', () => {
  const can = (over: Partial<KnowledgeInput> = {}) => knowledgeView(input(over)).open?.history.map((one) => [one.id, one.canRevert]);

  it('offers the applied change of the open file', () => {
    expect(can()).toEqual([[1, true]]);
  });

  // A later commit on the same path moved the file on, so taking the older commit back would drop
  // that work. git refuses it, and a button that always refuses is worse than no button.
  it('offers only the newest applied change when a file was taught twice', () => {
    expect(can({ changes: [change({ id: 1 }), change({ id: 2, commitSha: 'ffffffffffff' })] })).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it('offers nothing on a change that was reverted, waits for review or was returned', () => {
    for (const status of ['reverted', 'pending', 'returned'] as const) {
      expect(can({ changes: [change({ status })] })).toEqual([[1, false]]);
    }
  });

  // The commit of a moved change is in the repository that moved into the workspace.
  it('offers nothing on a change made in a knowledge folder the project no longer uses, and says where its commit is', () => {
    const view = knowledgeView(input({ changes: [change({ movedFrom: '/work/recipes/app/.nolzu/knowledge', diff: null })] }));

    expect(view.open?.history.map((one) => [one.id, one.canRevert, one.diffNote])).toEqual([
      [1, false, 'This change was committed in /work/recipes/app/.nolzu/knowledge, before this project became a workspace. Its diff and its commit are there.'],
    ]);
  });

  it('offers the newest change made in this folder when an older one moved', () => {
    expect(can({ changes: [change({ id: 1, movedFrom: '/work/recipes/app/.nolzu/knowledge' }), change({ id: 2 })] })).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(can({ changes: [change({ id: 1 }), change({ id: 2, movedFrom: '/work/recipes/app/.nolzu/knowledge' })] })).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  // The pending list answers a whole run through Approve and Return, so no row there carries it.
  it('offers nothing in the pending list', () => {
    const view = knowledgeView(input({ changes: [change({ status: 'pending', commitSha: null, committedAt: null, diff: null })] }));

    expect(view.pending.map((one) => one.canRevert)).toEqual([false]);
  });
});

  it('carries a pending change with no sha and no day, and lists it as pending', () => {
    const view = knowledgeView(input({ changes: [change({ status: 'pending', commitSha: null, committedAt: null, diff: null })] }));

    expect(view.pending.map((one) => one.statusLabel)).toEqual(['waiting for review']);
    expect(view.pending[0]).toMatchObject({ sha: null, shortSha: null, when: null });
  });

  it('lists a pending change of a file that is not open, because the list is the whole folder', () => {
    const view = knowledgeView(input({ open: null, changes: [change({ status: 'pending', commitSha: null, committedAt: null })] }));

    expect(view.pending).toHaveLength(1);
    expect(view.open).toBeNull();
  });
});

describe('a returned change', () => {
  const returned = () => change({ status: 'returned', commitSha: null, committedAt: null, diff: null, note: 'Name the endpoint, not the file.' });

  it('stays in the history with its note, and waits for nobody', () => {
    const view = knowledgeView(input({ changes: [returned()] }));

    expect(view.pending).toEqual([]);
    expect(view.open?.history[0]).toMatchObject({ statusLabel: 'returned', note: 'Name the endpoint, not the file.' });
  });

  // The pending sentence would say the change waits for a person, and nobody is waiting.
  it('says nothing was committed rather than that it waits for a person', () => {
    const view = knowledgeView(input({ changes: [returned()] }));

    expect(view.open?.history[0]?.diffNote).toBe('This change was returned, so nothing was committed and there is no diff.');
  });

  it('taught the file nothing, because it was never applied', () => {
    expect(knowledgeView(input({ changes: [returned()] })).open?.taughtBy).toEqual([]);
  });

  it('moves the last reviewed day nowhere', () => {
    expect(knowledgeView(input({ changes: [returned()] })).lastReviewed).toBeNull();
  });
});

// A change that waits is held aside, so it is not in the file either.
it('leaves a card whose change is still pending out of the taught-by list', () => {
  const view = knowledgeView(input({ changes: [change({ status: 'pending', commitSha: null, committedAt: null, diff: null })] }));

  expect(view.open?.taughtBy).toEqual([]);
});

describe('the pending list', () => {
  it('groups the files of one run, because one run is one commit', () => {
    const rows = [
      change({ id: 1, runId: 7, status: 'pending', commitSha: null, committedAt: null, diff: null }),
      change({ id: 2, runId: 7, filePath: '.nolzu/knowledge/testing.md', status: 'pending', commitSha: null, committedAt: null, diff: null }),
      change({ id: 3, runId: 8, status: 'pending', commitSha: null, committedAt: null, diff: null }),
    ];

    const runs = pendingRuns(knowledgeView(input({ files: ['search.md', 'testing.md'], changes: rows })).pending);

    expect(runs.map((one) => [one.runId, one.changes.map((change) => change.path)])).toEqual([
      [7, ['search.md', 'testing.md']],
      [8, ['search.md']],
    ]);
    expect(runs[0]?.source).toEqual({ kind: 'card', key: 'APP-1', title: 'Search the recipe list' });
  });

  it('groups nothing when nothing waits', () => {
    expect(pendingRuns([])).toEqual([]);
  });

  // Two runs under the reserved key write knowledge, so the run's phase says which one is waiting.
  it('names the run that wrote it: a wrap-up, Optimize, Learn this project or Learn your repositories', () => {
    const waiting = { status: 'pending' as const, commitSha: null, committedAt: null, diff: null };
    const rows = [
      change({ id: 1, runId: 7, ...waiting }),
      change({ id: 2, runId: 8, cardKey: KB_MAINTENANCE_KEY, phase: 'optimize', ...waiting }),
      change({ id: 3, runId: 9, cardKey: KB_MAINTENANCE_KEY, phase: 'orient', ...waiting }),
      change({ id: 4, runId: 10, cardKey: KB_MAINTENANCE_KEY, ...waiting }),
      change({ id: 5, runId: 11, cardKey: learnRepoKey('api'), phase: 'learn-repo', ...waiting }),
    ];

    expect(pendingRuns(knowledgeView(input({ changes: rows })).pending).map((one) => one.by)).toEqual(['wrap-up', 'Optimize', 'Learn this project', 'Optimize', 'Learn your repositories']);
  });
});

describe('why a change shows no diff', () => {
  it('says nothing is committed yet while the change waits for a person', () => {
    const view = knowledgeView(input({ changes: [change({ status: 'pending', commitSha: null, committedAt: null, diff: null })] }));

    expect(view.pending[0]?.diffNote).toBe('There is no commit yet. The change waits for a person.');
  });

  it('names the commit git does not have, so the reader knows where to look', () => {
    const view = knowledgeView(input({ changes: [change({ diff: null })] }));

    expect(view.open?.history[0]?.diffNote).toBe('git has no commit a1b2c3d in this folder, so there is no diff to show.');
  });

  it('says a patch over the size the page reads is too large, rather than blaming git', () => {
    const view = knowledgeView(input({ changes: [change({ diff: null, diffTooLarge: true })] }));

    expect(view.open?.history[0]?.diffNote).toBe('This change is too large to show here. Open commit a1b2c3d in the folder to read it.');
  });

  it('has nothing to say when there is a diff', () => {
    expect(knowledgeView(input()).open?.history[0]?.diffNote).toBeNull();
  });
});

describe('the folder', () => {
  it('counts the files and marks the open one', () => {
    const view = knowledgeView(input({ files: ['search.md', 'testing.md'] }));

    expect(view.fileCount).toBe(2);
    expect(view.files.map((file) => file.open)).toEqual([true, false]);
    expect(view.empty).toBe(false);
  });

  it('is empty when it holds no file, and says so rather than reading as broken', () => {
    const view = knowledgeView(input({ files: [], open: null, changes: [] }));

    expect(view.empty).toBe(true);
    expect(view.problem).toBeNull();
    expect(NO_KNOWLEDGE).toContain('earned from real work');
  });

  it('says there is no project when no folder could be worked out', () => {
    const view = knowledgeView(input({ folder: null, exists: false, files: [], open: null }));

    expect(view.problem).toBe('There is no project set, so there is no knowledge folder yet. Make a project on New project.');
    expect(view.empty).toBe(false);
  });

  it('says the folder is not there yet, and names it, when it has not been made', () => {
    const view = knowledgeView(input({ exists: false, files: [], open: null }));

    expect(view.problem).toContain('/work/recipes/.nolzu/knowledge');
    expect(view.problem).toContain('first wrap-up');
  });

  it('takes the last reviewed day from the newest applied change and ignores the others', () => {
    const rows = [
      change({ id: 1, committedAt: '2026-09-20T10:00:00+02:00' }),
      change({ id: 2, status: 'reverted', committedAt: '2026-09-28T10:00:00+02:00' }),
      change({ id: 3, committedAt: '2026-09-24T10:00:00+02:00' }),
      change({ id: 4, status: 'pending', commitSha: null, committedAt: null }),
    ];

    expect(knowledgeView(input({ changes: rows })).lastReviewed).toBe('2026-09-24');
  });

  it('has no last reviewed day while nothing is applied', () => {
    expect(knowledgeView(input({ changes: [change({ status: 'pending', commitSha: null, committedAt: null })] })).lastReviewed).toBeNull();
  });

  it('carries the card that is writing right now', () => {
    expect(knowledgeView(input({ busy: 'APP-1' })).busy).toBe('APP-1');
  });

  it('reads a maintenance run as words, because its reserved key is not a card a person knows', () => {
    expect(knowledgeView(input({ busy: KB_MAINTENANCE_KEY })).busy).toBe('A maintenance run');
  });
});

// The change is shown where it happened, inline in the file, with the card that taught it and
// Revert.
describe('the change shown in the file', () => {
  const FILE = [
    '---',
    'description: How the web app calls the recipe API',
    '---',
    '',
    '# Recipe API',
    '',
    '## Sorting',
    '',
    'The server sorts. Pass `sort=time`.',
    'Recipes with no minutes go last.',
    '',
    '## Errors',
    '',
    'Throw ApiDownError.',
    '',
  ].join('\n');
  const SORTED = [
    '@@ -7,4 +7,5 @@',
    ' ## Sorting',
    ' ',
    '-Recipes come back in the order they were saved.',
    '+The server sorts. Pass `sort=time`.',
    '+Recipes with no minutes go last.',
    ' ',
    '',
  ].join('\n');
  const sorted = (over: Partial<KnowledgeInput> = {}) =>
    knowledgeView(input({ open: { path: 'search.md', text: FILE }, changes: [change({ id: 1 }), change({ id: 2, commitSha: 'ffffffffffff', diff: SORTED })], ...over }));

  it('cuts the file around the lines the newest applied change wrote', () => {
    expect(sorted().open?.parts).toEqual([
      { kind: 'text', text: '# Recipe API\n\n## Sorting' },
      { kind: 'change', removed: ['Recipes come back in the order they were saved.'], added: ['The server sorts. Pass `sort=time`.', 'Recipes with no minutes go last.'] },
      { kind: 'text', text: '## Errors\n\nThrow ApiDownError.' },
    ]);
  });

  it('carries the card that taught the change, and it is the change Revert takes back', () => {
    const inline = sorted().open?.inline;

    expect(inline?.change).toMatchObject({ id: 2, canRevert: true, source: { kind: 'card', key: 'APP-1' } });
    expect(inline?.whole).toBe(false);
  });

  it('places every group of a change with two hunks', () => {
    const two = ['@@ -5,1 +5,1 @@', '-# Recipes', '+# Recipe API', '@@ -9,1 +9,1 @@', '-Sort in the web app.', '+The server sorts. Pass `sort=time`.', ''].join('\n');
    const parts = sorted({ changes: [change({ diff: two })] }).open?.parts ?? [];

    expect(parts.filter((part) => part.kind === 'change')).toEqual([
      { kind: 'change', removed: ['# Recipes'], added: ['# Recipe API'] },
      { kind: 'change', removed: ['Sort in the web app.'], added: ['The server sorts. Pass `sort=time`.'] },
    ]);
    expect(parts[0]).toEqual({ kind: 'change', removed: ['# Recipes'], added: ['# Recipe API'] });
  });

  it('places a change that only removed lines where they were', () => {
    const removed = ['@@ -11,2 +10,0 @@', '-', '-Old sorting note.', ''].join('\n');
    const parts = sorted({ changes: [change({ diff: removed })] }).open?.parts;

    expect(parts?.[1]).toEqual({ kind: 'change', removed: ['', 'Old sorting note.'], added: [] });
    expect(parts?.[0]).toEqual({ kind: 'text', text: '# Recipe API\n\n## Sorting\n\nThe server sorts. Pass `sort=time`.\nRecipes with no minutes go last.' });
  });

  // A change that only took lines out leaves none of its own to find, so the lines git printed
  // around it have to be where they were. A line written by hand above them moves the place.
  it('leaves out a change that only removed lines once the lines around it moved', () => {
    const removed = ['@@ -9,3 +9,2 @@', ' The server sorts. Pass `sort=time`.', '-Old sorting note.', ' Recipes with no minutes go last.', ''].join('\n');
    expect(sorted({ changes: [change({ diff: removed })] }).open?.parts.map((part) => part.kind)).toEqual(['text', 'change', 'text']);

    const moved = FILE.replace('## Sorting\n', '## Sorting\n\nA line written by hand.\n');
    const view = sorted({ open: { path: 'search.md', text: moved }, changes: [change({ diff: removed })] });

    expect(view.open?.parts.map((part) => part.kind)).toEqual(['text']);
    expect(view.open?.inline).toMatchObject({ whole: false, change: { id: 1 } });
  });

  // A change that made the file is the whole file. Drawn as added lines it would turn the page into
  // a diff, so the file reads as itself and the card and Revert sit at the top.
  it('leaves the file whole for the change that wrote it, and says it wrote it', () => {
    const view = knowledgeView(input({ open: { path: 'search.md', text: 'How search is tested\n' } }));

    expect(view.open?.parts).toEqual([{ kind: 'text', text: 'How search is tested\n' }]);
    expect(view.open?.inline).toMatchObject({ whole: true, change: { id: 1 } });
  });

  it('leaves the lines out of the file when the file moved on since, and keeps the card and Revert', () => {
    const moved = FILE.replace('The server sorts.', 'The API sorts.');
    const view = sorted({ open: { path: 'search.md', text: moved } });

    expect(view.open?.parts.map((part) => part.kind)).toEqual(['text']);
    expect(view.open?.inline).toMatchObject({ whole: false, change: { id: 2 } });
  });

  it('never cuts a code block in two', () => {
    const fenced = FILE.replace('## Sorting\n', '## Sorting\n```\n').replace('## Errors', '```\n## Errors');
    const diff = SORTED.replace('@@ -7,4 +7,5 @@', '@@ -7,5 +7,6 @@').replace(' ## Sorting\n ', ' ## Sorting\n ```\n ');

    expect(sorted({ open: { path: 'search.md', text: fenced }, changes: [change({ diff })] }).open?.parts.map((part) => part.kind)).toEqual(['text']);
  });

  it('never cuts the frontmatter, which the page reads the description from', () => {
    const diff = ['@@ -2,1 +2,1 @@', '-description: The API', '+description: How the web app calls the recipe API', ''].join('\n');

    expect(sorted({ changes: [change({ diff })] }).open?.parts.map((part) => part.kind)).toEqual(['text']);
  });

  it('shows no change in the file while none of it is applied', () => {
    const view = sorted({ changes: [change({ status: 'pending', commitSha: null, committedAt: null, diff: null })] });

    expect(view.open?.inline).toBeNull();
    expect(view.open?.parts).toEqual([{ kind: 'text', text: FILE.split('\n').slice(4).join('\n') }]);
  });

  it('keeps the card and Revert at the top for an applied change git has no diff of', () => {
    const view = sorted({ changes: [change({ diff: null })] });

    expect(view.open?.parts.map((part) => part.kind)).toEqual(['text']);
    expect(view.open?.inline).toMatchObject({ whole: false, change: { id: 1 } });
  });

  it('names the file from its repository and counts its lines, for the line above it', () => {
    expect(sorted().open).toMatchObject({ repoPath: '.nolzu/knowledge/search.md', lineCount: 14 });
  });
});

describe('the lines of a change', () => {
  it('counts what a change added and removed', () => {
    const view = knowledgeView(input({ changes: [change({ diff: '@@ -1,2 +1,3 @@\n same\n-old\n+new\n+newer\n' })] }));

    expect(view.open?.history[0]?.lines).toEqual({ added: 2, removed: 1 });
  });

  it('counts nothing for a change git has no diff of', () => {
    expect(knowledgeView(input({ changes: [change({ diff: null })] })).open?.history[0]?.lines).toBeNull();
  });

  it('marks the code spans of a line, and keeps a line with a lone backtick as text', () => {
    expect(codeSpans('Pass `sort=time` to sort.')).toEqual([
      { text: 'Pass ', code: false },
      { text: 'sort=time', code: true },
      { text: ' to sort.', code: false },
    ]);
    expect(codeSpans('A ` alone')).toEqual([{ text: 'A ` alone', code: false }]);
  });
});

// A change that waits has no commit, so its lines come from the kept copy set against the file as
// it is in the folder now.
describe('what a change waiting for review would write', () => {
  const waiting = (held: KnowledgeChangeInput['held']) => change({ status: 'pending', commitSha: null, committedAt: null, diff: null, held });

  it('shows the lines it would add and take out, and counts them', () => {
    const view = knowledgeView(input({ changes: [waiting({ before: 'Run the list.\nOld line.\n', after: 'Run the list.\nNew line.\nAnd one more.\n' })] }));

    expect(view.pending[0]?.held).toEqual([{ removed: ['Old line.'], added: ['New line.', 'And one more.'] }]);
    expect(view.pending[0]?.lines).toEqual({ added: 2, removed: 1 });
  });

  it('shows every line as added for a file the run made, and as removed for one it deleted', () => {
    expect(knowledgeView(input({ changes: [waiting({ before: null, after: 'One.\nTwo.\n' })] })).pending[0]?.held).toEqual([{ removed: [], added: ['One.', 'Two.'] }]);
    expect(knowledgeView(input({ changes: [waiting({ before: 'One.\n', after: null })] })).pending[0]?.held).toEqual([{ removed: ['One.'], added: [] }]);
  });

  it('shows no lines when the kept copy is gone, and says the change waits', () => {
    const view = knowledgeView(input({ changes: [waiting(undefined)] }));

    expect(view.pending[0]?.held).toBeNull();
    expect(view.pending[0]?.diffNote).toBe('There is no commit yet. The change waits for a person.');
  });

  it('keeps no lines for a change that is not waiting, even when a kept copy is still there', () => {
    const kept = { before: 'a\n', after: 'b\n' };
    const view = knowledgeView(input({ changes: [change({ status: 'returned', held: kept }), change({ id: 2, status: 'applied', held: kept })] }));

    expect(view.open?.history.map((one) => one.held)).toEqual([null, null]);
  });
});

describe('a line diff', () => {
  it('answers no group for two equal texts', () => {
    expect(lineGroups('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('keeps the groups apart where a line in between stayed', () => {
    expect(lineGroups('a\nb\nc\nd\n', 'a\nB\nc\nD\n')).toEqual([
      { removed: ['b'], added: ['B'] },
      { removed: ['d'], added: ['D'] },
    ]);
  });

  it('reads a missing last newline as the same line', () => {
    expect(lineGroups('a\nb', 'a\nb\n')).toEqual([]);
  });
});

describe('the folder pane', () => {
  it('dates each file by the newest commit that touched it', () => {
    const view = knowledgeView(input({ files: ['search.md', 'testing.md'], fileDates: { 'search.md': '2026-10-06T09:00:00+02:00' } }));

    expect(view.files.map((file) => [file.path, file.updated])).toEqual([
      ['search.md', '2026-10-06'],
      ['testing.md', null],
    ]);
  });

  it('takes the last Optimize day from the newest maintenance change', () => {
    const rows = [
      change({ id: 1, cardKey: KB_MAINTENANCE_KEY, committedAt: '2026-10-01T10:00:00+02:00' }),
      change({ id: 2, cardKey: KB_MAINTENANCE_KEY, committedAt: '2026-10-04T10:00:00+02:00' }),
      change({ id: 3, committedAt: '2026-10-09T10:00:00+02:00' }),
    ];

    expect(knowledgeView(input({ changes: rows })).lastOptimize).toBe('2026-10-04');
    expect(knowledgeView(input()).lastOptimize).toBeNull();
    // Learn this project carries the same key and is no Optimize.
    expect(knowledgeView(input({ changes: [...rows, change({ id: 4, cardKey: KB_MAINTENANCE_KEY, phase: 'orient', committedAt: '2026-10-08T10:00:00+02:00' })] })).lastOptimize).toBe('2026-10-04');
  });

  it('names the folder the way its repository does, or in full at the root', () => {
    expect(knowledgeView(input()).place).toBe('.nolzu/knowledge');
    expect(knowledgeView(input({ prefix: '' })).place).toBe('/work/recipes/.nolzu/knowledge');
  });
});

// The screen names the folder short, never the long path of the machine, and the foot says the
// last Optimize as a day and a month.
describe('the folder and the foot, short', () => {
  it('names the folder the short way the page gives, in the empty line and the foot', () => {
    const view = knowledgeView(input({ exists: false, files: [], open: null, prefix: '', shown: '.nolzu/knowledge' }));

    expect(view.problem).toBe('There is no folder .nolzu/knowledge yet. The first wrap-up that teaches something makes it.');
    expect(view.place).toBe('.nolzu/knowledge');
    expect(view.folder).toBe('/work/recipes/.nolzu/knowledge');
  });

  it('says a day as the day and the short month', () => {
    expect(dayMonth('2026-10-04')).toBe('4 Oct');
    expect(dayMonth('2026-01-31')).toBe('31 Jan');
    expect(dayMonth(null)).toBeNull();
  });
});

// The Search knowledge box filters the file list by name and by what the file says.
describe('fileMatches', () => {
  const row = (name: string, text = '') => ({ path: name, name, open: false, updated: null, text, gone: [], pending: false });

  it('matches the name or the text, in any case, and every file on an empty query', () => {
    expect(fileMatches(row('api.md', 'Pass sort=time'), 'API')).toBe(true);
    expect(fileMatches(row('api.md', 'Pass sort=time'), 'SORT=')).toBe(true);
    expect(fileMatches(row('api.md', 'Pass sort=time'), 'deploy')).toBe(false);
    expect(fileMatches(row('api.md'), '  ')).toBe(true);
  });

  it('carries each file text from the page into its row', () => {
    const view = knowledgeView(input({ fileTexts: { 'search.md': 'How search is tested' } }));

    expect(view.files[0]?.text).toBe('How search is tested');
    expect(knowledgeView(input()).files[0]?.text).toBe('');
  });
});

// The file list is a folder tree, grouped by repository: one folded row per folder with its
// count, the folder of the open file open, and the files at the top of the folder last.
describe('knowledgeTree', () => {
  // Sorted by codepoint, as the page hands them over.
  const files = ['api/repository.md', 'api/search.md', 'notes.md', 'run-recipe.md', 'shared/lists.md', 'testing/e2e/login.md', 'testing/unit.md', 'web/form.md', 'web/repository.md'];
  const repos = ['web', 'api'];

  it("groups by the project's repositories in its order, each with its file first, then Shared, then other folders", () => {
    const tree = knowledgeTree(knowledgeView(input({ files, open: null, changes: [], repos })).files, repos);

    expect(tree.folders.map((folder) => [folder.path, folder.label, folder.files.length])).toEqual([
      ['web', 'web', 2],
      ['api', 'api', 2],
      ['shared', 'Shared', 1],
      ['testing', 'testing', 2],
    ]);
    expect(tree.folders[0]?.files.map((file) => file.name)).toEqual(['repository.md', 'form.md']);
    // A file deeper down keeps the folders under the first one in its name, so nothing reads the same.
    expect(tree.folders[3]?.files.map((file) => file.name)).toEqual(['e2e/login.md', 'unit.md']);
    expect(tree.top.map((file) => file.name)).toEqual(['notes.md', 'run-recipe.md']);
    expect(tree.folders.some((folder) => folder.holdsOpen)).toBe(false);
  });

  // The project folder's repository keeps its file and notes at the top, with the run recipe.
  it('puts the repository file of the project folder first among the top files', () => {
    const tree = knowledgeTree(knowledgeView(input({ files: ['build.md', 'repository.md', 'run-recipe.md'], open: null, changes: [] })).files, ['.', 'api']);

    expect(tree.top.map((file) => file.name)).toEqual(['repository.md', 'build.md', 'run-recipe.md']);
  });

  it('shows no folder row for a project of one repository', () => {
    const tree = knowledgeTree(knowledgeView(input({ files: ['api/repository.md', 'api/search.md', 'run-recipe.md'], open: null, changes: [] })).files, ['api']);

    expect(tree.folders).toEqual([]);
    expect(tree.top.map((file) => [file.path, file.name])).toEqual([
      ['api/repository.md', 'repository.md'],
      ['api/search.md', 'search.md'],
      ['run-recipe.md', 'run-recipe.md'],
    ]);
  });

  it('knows which folder holds the open file', () => {
    const tree = knowledgeTree(knowledgeView(input({ files, open: { path: 'api/repository.md', text: 'x' }, changes: [] })).files, repos);

    expect(tree.folders.map((folder) => folder.holdsOpen)).toEqual([false, true, false, false]);
  });

  it('marks a file with a change waiting for review, and counts them on its folder', () => {
    const waiting = change({ filePath: '.nolzu/knowledge/web/repository.md', status: 'pending', commitSha: null, committedAt: null, diff: null });
    // An applied change is not waiting, so the api file stays unmarked.
    const applied = change({ id: 3, filePath: '.nolzu/knowledge/api/repository.md' });
    const view = knowledgeView(input({ files, open: null, changes: [change(), waiting, applied] }));
    const tree = knowledgeTree(view.files, repos);

    expect(view.files.filter((file) => file.pending).map((file) => file.path)).toEqual(['web/repository.md']);
    expect(tree.folders.map((folder) => folder.pending)).toEqual([1, 0, 0, 0]);
  });
});
