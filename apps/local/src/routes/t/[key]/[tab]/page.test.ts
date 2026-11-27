import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { boardFor, tabsFor } from '@nolzu/core';
import { createCard, getSetting, openDatabase, saveCardPull, saveRun, storeDiscussions, savePlainSummary, saveVerdict, startRun, writeSetting } from '@nolzu/core/node';
import type { BoardKind } from '@nolzu/protocol';
import { type QaInput, qaView } from '@nolzu/ui/qa';
import type { StackStatus } from '$lib/qa-panel.ts';
import type { ReviewView } from '$lib/review.ts';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createLoop, type Loop } from '$lib/loop.ts';

// The route reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported and opens anything. The fake engine is handed to the loop below by name, not
// through the environment, because fake mode ignores NOLZU_DATA_DIR on purpose.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-ticket-route-'));
process.env.NOLZU_DATA_DIR = dir;

const { load } = await import('./+page.server.ts');
interface Event {
  params: { key: string; tab: string };
  parent: () => Promise<{ tabs: readonly { id: string; label: string }[]; ticket: { key: string; board: string } }>;
  request: Request;
  url: URL;
}
const page = load as unknown as (
  event: Event,
) => Promise<{
  qa: QaInput | null;
  qaStatus: Promise<StackStatus> | null;
  current: string;
  hasChanges: boolean;
  overview: { strip: readonly { phase: string }[] } | null;
  review: ReviewView | null;
  filesFolder: string | null;
}>;

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
];

const open = (board: string, tab = 'overview') =>
  page({
    params: { key: 'APP-1', tab },
    parent: async () => ({ tabs: TABS, ticket: { key: 'APP-1', board } }),
    request: new Request(`http://localhost/t/APP-1/${tab}`),
    url: new URL(`http://localhost/t/APP-1/${tab}`),
  });

// The tabs come from core, so these tests read the real per-board list rather than a literal beside it
// that can drift from it.
const openCard = (key: string, board: BoardKind, tab: string, query = '') =>
  page({
    params: { key, tab },
    parent: async () => ({ tabs: tabsFor(board), ticket: { key, board } }),
    request: new Request(`http://localhost/t/${key}/${tab}${query}`),
    url: new URL(`http://localhost/t/${key}/${tab}${query}`),
  });

const project = mkdtempSync(join(tmpdir(), 'nolzu-ticket-route-project-'));
const asked = join(project, 'asked.txt');

// One loop per data directory, so the loop the route reaches is this one. The fake engine keeps the
// run on this machine and off any network.
let live: Loop;
let db = openDatabase(dir);
beforeAll(() => {
  db.close();
  live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  db = live.db;
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd: project });
  writeSetting(db, 'projectPath', project);
  // A real command, so a board that should ask nothing can be caught asking.
  writeSetting(db, 'qaApp', { '*': { mode: 'own', start: 'true', stop: null, status: `touch ${asked}; echo "api  running"` } });
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'qa', title: 'APP-1 title' });
  // One card per board, on that board's first stage, with the project's own key prefix.
  createCard(db, { key: 'APP-2', board: 'epics', stage: 'inbox', title: 'APP-2 title' });
  createCard(db, { key: 'APP-3', board: 'investigations', stage: 'inbox', title: 'APP-3 title' });
  createCard(db, { key: 'APP-4', board: 'questions', stage: 'inbox', title: 'APP-4 title' });
  createCard(db, { key: 'APP-5', board: 'prreview', stage: 'incoming', title: 'APP-5 title' });
  mkdirSync(join(project, 'worktrees', 'APP-1'), { recursive: true });
});
afterAll(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('builds the QA panels on the overview of a Delivery card, with what the project reported', async () => {
  const data = await open('delivery');
  // The panels draw at once, and the status command's answer is streamed beside them.
  const view = data.qa === null || data.qaStatus === null ? null : qaView({ ...data.qa, ...(await data.qaStatus) });

  expect(view?.stack.status).toBe('api  running');
  expect(view?.verdict.note).toContain('QA has not run');
});

// The panels belong to the Delivery board. On another board there is no QA run and no stack, and
// the project must not be asked a question about one.
it('builds no QA panels for a card from another board, and runs no status command', async () => {
  rmSync(asked, { force: true });

  const data = await open('questions');

  expect(data.qa).toBeNull();
  expect(existsSync(asked)).toBe(false);
});

// The other tabs read git and the card folder. The panels, and the command behind them, belong to
// the overview alone.
it('builds no QA panels on another tab of the same card', async () => {
  rmSync(asked, { force: true });

  const data = await open('delivery', 'files');

  expect(data.qa).toBeNull();
  expect(existsSync(asked)).toBe(false);
});

// Getting started's "Read what changed" turns done when the overview opens on a plain summary, and not
// on an overview with no summary yet or on another tab.
it('marks the plain summary read when the overview shows one, and tells the open streams once', async () => {
  writeSetting(db, 'gettingStarted', []);
  const told = vi.spyOn(live, 'changed');
  createCard(db, { key: 'APP-9', board: 'delivery', stage: 'refine', title: 'APP-9 title' });

  await openCard('APP-9', 'delivery', 'overview');
  await openCard('APP-9', 'delivery', 'files');
  expect(getSetting(db, 'gettingStarted')).toEqual([]);

  const run = startRun(db, { cardKey: 'APP-9', phase: 'refine', engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  saveRun(db, run, { sessionId: null, model: 'haiku', costUsd: 0, durationMs: 1, tokens: null, question: null, failureReason: null, failureStatus: null, state: 'complete', cardState: 'ready', retry: null });
  savePlainSummary(db, run, 'The ticket says what done means now.');
  told.mockClear();
  await openCard('APP-9', 'delivery', 'overview');
  await openCard('APP-9', 'delivery', 'overview');

  expect(getSetting(db, 'gettingStarted')).toEqual(['summary']);
  expect(told).toHaveBeenCalledTimes(1);
  told.mockRestore();
  writeSetting(db, 'gettingStarted', null);
});

// The busy state of the three buttons comes from the board snapshot, which is the rule in AGENTS.md.
// A QA run holds the stack lane, and the page has to carry that into the panel rather than drawing
// live buttons over a stack that belongs to a run.
it('carries the stack lane of the running QA run into the buttons', async () => {
  // The start command outlives the assertions below, so the lane stays held while they run.
  const status = `touch ${asked}; echo "api  running"`;
  writeSetting(db, 'qaApp', { '*': { mode: 'own', start: 'sleep 30; true', stop: null, status } });
  live.start('APP-1', 'qa');

  await vi.waitFor(async () => {
    const data = await open('delivery');
    const view = data.qa === null ? null : qaView({ ...data.qa, status: null, statusProblem: null });
    expect(view?.stack.buttons.map((button) => button.refused !== null)).toEqual([true, true, true]);
    expect(view?.stack.buttons[0]?.refused).toContain('running QA');
  });

  live.stop((db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id);
  writeSetting(db, 'qaApp', { '*': { mode: 'own', start: 'true', stop: null, status } });
});

// The ticket page of a card on each board, loaded the way the route loads it. Every board draws an
// overview, so every board has to answer with one, and the phases in its trail have to be that board's.
it.each([
  ['delivery', 'APP-1'],
  ['epics', 'APP-2'],
  ['investigations', 'APP-3'],
  ['questions', 'APP-4'],
  ['prreview', 'APP-5'],
] as [BoardKind, string][])('loads the overview of a card on the %s board', async (board, key) => {
  const data = await openCard(key, board, 'overview');

  expect(data.current).toBe('overview');
  // Read back from the card row and not from the board this test passed in, so a card that landed on
  // another board, or a trail built from one hardcoded list, fails here.
  const stored = (db.prepare('SELECT board FROM cards WHERE key = ?').get(key) as { board: BoardKind }).board;
  // The phase of each agent stage, each one once: the two PR review stages run one phase, and the
  // trail draws one segment for it.
  const phases = [
    ...new Set(
      boardFor(stored, getSetting(db, 'deliveryFlow'))
        .stages.filter((stage) => stage.role === 'agent')
        .map((stage) => stage.phase),
    ),
  ];
  expect(data.overview?.strip.map((segment) => segment.phase)).toEqual(phases);
});

// Every tab the three boards with no Changes tab do offer. A tab in the list that the route cannot
// load is a tab bar offering a page that is not there.
it.each(['files', 'discussion', 'log', 'settings'])('loads the %s tab of a card on the Epics board', async (tab) => {
  expect((await openCard('APP-2', 'epics', tab)).current).toBe(tab);
});

// An empty Changes tab would read as a page that broke, and a redirect to the overview would hide that
// the address was wrong.
it('answers 404 for the Changes tab of a card on a board that has none', async () => {
  await expect(openCard('APP-2', 'epics', 'changes')).rejects.toMatchObject({ status: 404 });
  await expect(openCard('APP-4', 'questions', 'changes')).rejects.toMatchObject({ status: 404 });
});

// The overview links the diff, so it has to know whether this card's board has a Changes tab. Without
// this the link on an Epics card led to the 404 above.
it('says on which boards there is a diff to link', async () => {
  expect((await openCard('APP-1', 'delivery', 'overview')).hasChanges).toBe(true);
  expect((await openCard('APP-2', 'epics', 'overview')).hasChanges).toBe(false);
});

// The Files tab's empty state names the card folder, because that is where a person copies a log for
// an investigate run. The path is built from the key, so a wrong argument or the wrong tab in the
// guard typechecks and loses it, and nothing on screen says which card the folder belongs to.
it('carries the card folder to the Files tab and nowhere else', async () => {
  expect((await openCard('APP-4', 'questions', 'files')).filesFolder).toBe(join(project, '.tasks', 'APP-4'));
  expect((await openCard('APP-4', 'questions', 'overview')).filesFolder).toBeNull();
});

// The other half of `hasChanges`. Passed unconditionally the whole gate stays green, and an Epics card's
// Overview offers "See the diff" into the 404 above. Read as source, because vitest resolves `$lib` here
// and not `$app/paths`, so this route cannot be rendered in a test.
it('passes the diff link to the Overview only when the card has a Changes tab', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toContain("changesHref={data.hasChanges ? resolve('/t/[key]/[tab]', { key, tab: 'changes' }) : null}");
});

// The plan opens the file of this card, so the Files address is built from the page's key. Read as
// source for the reason above.
it('links the plan to the Files tab of the card of the page', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toContain("const filesAt = (path: string) => `${resolve('/t/[key]/[tab]', { key, tab: 'files' })}?");
  expect(source).toContain("planHref={filesAt('plan/plan.md')}");
});

// The PRs tab of a card before Pull request is one it grows into, so the address leads to the overview
// rather than answering 404, the way a tab not built yet does.
it('sends the PRs tab of a card before Pull request to the overview rather than answering 404', async () => {
  const early = page({
    params: { key: 'APP-1', tab: 'prs' },
    parent: async () => ({ tabs: tabsFor('delivery', 'qa'), ticket: { key: 'APP-1', board: 'delivery' } }),
    request: new Request('http://localhost/t/APP-1/prs'),
    url: new URL('http://localhost/t/APP-1/prs'),
  });
  await expect(early).rejects.toMatchObject({ status: 307 });
});

// Read off the database alone: opening the tab asks GitHub nothing.
it('loads the pull requests of a Delivery card on the PRs tab', async () => {
  const pull = saveCardPull(db, 'APP-1', { repo: 'example/api', number: 7, url: null, foundBy: 'attached', title: 'Return the cooking time', state: 'open' });
  storeDiscussions(db, pull, 'pat', [{ kind: 'comment', githubId: 'I1', path: null, line: null, resolved: false, outdated: false, messages: [{ githubId: 'I1', author: 'dana', body: 'Looks close.', createdAt: '2026-10-01T00:00:00Z' }] }]);

  const data = (await openCard('APP-1', 'delivery', 'prs')) as unknown as {
    current: string;
    prs: { repo: string; number: number; foundBy: string }[] | null;
    prDiscussions: { ref: string; messages: { body: string; unread: boolean }[] }[] | null;
  };

  expect(data.current).toBe('prs');
  expect(data.prs?.map((one) => [one.repo, one.number, one.foundBy])).toEqual([['example/api', 7, 'attached']]);
  // Loading leaves the dots alone: the tab marks them seen once it has drawn them.
  expect(data.prDiscussions?.map((one) => [one.ref, one.messages[0]?.body, one.messages[0]?.unread])).toEqual([['T1', 'Looks close.', true]]);
});

// Why the pull request cannot merge reaches the overview off the database, only from Review to Wrap-up.
it('loads why the open pull requests cannot merge on the overview of a card from Review to Wrap-up', async () => {
  createCard(db, { key: 'APP-31', board: 'delivery', stage: 'pr-watch', title: 'APP-31 title' });
  saveCardPull(db, 'APP-31', { repo: 'example/api', number: 8, url: null, foundBy: 'branch', state: 'open', merge: { blockers: [{ kind: 'draft' }], running: false } });
  saveCardPull(db, 'APP-31', { repo: 'example/web', number: 2, url: null, foundBy: 'branch', state: 'merged', merge: { blockers: [{ kind: 'draft' }], running: false } });
  const at = (stage: string) =>
    page({
      params: { key: 'APP-31', tab: 'overview' },
      parent: async () => ({ tabs: tabsFor('delivery', stage), ticket: { key: 'APP-31', board: 'delivery', stage } }),
      request: new Request('http://localhost/t/APP-31/overview'),
      url: new URL('http://localhost/t/APP-31/overview'),
    }) as unknown as Promise<{ merge: { repo: string; number: number; read: unknown; at: string }[] }>;

  const data = await at('pr-watch');
  expect(data.merge.map((one) => [one.repo, one.number, one.read])).toEqual([['example/api', 8, { blockers: [{ kind: 'draft' }], running: false }]]);
  expect(Date.parse(data.merge[0]?.at ?? '')).not.toBeNaN();
  expect((await at('implement')).merge).toEqual([]);
});

// The Review tab, end to end: the round file in the card folder reaches the page as blocks.
it('loads the round of findings on the Review tab of a PR reviews card', async () => {
  const folder = join(project, '.tasks', 'APP-5', 'pr-review');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'round.md'),
    `issue: src/recipes/import.ts:88\nOne bad file stops the whole import. Return an empty list here.\n\nsuggestion: src/recipes/import.ts:120\nThe caller reads the file twice. Read it once.\n\npraise: src/recipes/list.ts:14\nThe list reads in one pass.\n`,
  );

  const data = await openCard('APP-5', 'prreview', 'review');

  expect(data.current).toBe('review');
  expect(data.review?.blocks.map((block) => block.label)).toEqual(['issue', 'suggestion', 'praise']);
  expect(data.review?.problem).toBeNull();
  expect(data.review?.rounds.map((round) => round.number)).toEqual([1]);
});

// The card folder is read on the tab that shows it and nowhere else.
it('reads no round on another tab of the same card', async () => {
  expect((await openCard('APP-5', 'prreview', 'files')).review).toBeNull();
  expect((await openCard('APP-5', 'prreview', 'overview')).review).toBeNull();
});

// The Review tab is one board's. On a card that has not got it the address is a page that is not
// there, and a redirect to the overview would hide that the address was wrong. This only holds while
// `tabAnywhere` searches every board and not the Delivery list alone.
it('answers 404 for the Review tab of a card on a board that has none', async () => {
  await expect(openCard('APP-1', 'delivery', 'review')).rejects.toMatchObject({ status: 404, body: { message: expect.stringContaining('no Review tab on APP-1') } });
  await expect(openCard('APP-2', 'epics', 'review')).rejects.toMatchObject({ status: 404 });
});

// No test can render this route, so the one line that joins the loader to the component is read as
// source. Without it the tab loads a round and draws the placeholder.
it('draws the Review tab from what the loader read', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toContain('{:else if data.review !== null}');
  expect(source).toContain('blocks={data.review.blocks}');
  expect(source).toContain('oncopy={copyBlock}');
  expect(source).toContain('read={data.review.read}');
  expect(source).toContain('head={data.review.head}');
  // The next round is the decision panel's amber button beside the tab, so the tab sends no move.
  expect(source).not.toContain("resolve('/api/board/move')");
  // The clipboard is the page's call, because packages/ui never touches the browser. What the call
  // does on a browser that takes it and on one that refuses is `clipboard.test.ts`.
  expect(source).toContain('await copyText(text)');
});

// The round links are plain `?round=` addresses, so the number in the address has to reach the
// reader. A link that loaded the newest round whatever it said would look like it worked.
it('loads the round the address asks for', async () => {
  const folder = join(project, '.tasks', 'APP-5', 'pr-review');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'round.md'), `issue: src/recipes/import.ts:88\nOne bad file stops the whole import.\n`);
  writeFileSync(join(folder, 'round-2.md'), `praise: src/recipes/import.ts:88\nThe bad file now returns an empty list.\n`);

  expect((await openCard('APP-5', 'prreview', 'review', '?round=1')).review?.current).toBe(1);
  expect((await openCard('APP-5', 'prreview', 'review', '?round=2')).review?.current).toBe(2);
  expect((await openCard('APP-5', 'prreview', 'review')).review?.current).toBe(2);
  expect((await openCard('APP-5', 'prreview', 'review', '?round=9')).review?.current).toBe(2);
});

// The second round reaches the page beside the first, with every round before it, so the tab can say
// what changed. This is what every later round is for.
it('loads the rounds before the one shown, and why a re-review makes sense', async () => {
  const folder = join(project, '.tasks', 'APP-5', 'pr-review');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'round.md'), `issue: src/recipes/import.ts:88\nOne bad file stops the whole import.\n`);
  writeFileSync(join(folder, 'round-2.md'), `praise: src/recipes/import.ts:90\nThe bad file now returns an empty list.\n`);
  db.prepare("UPDATE cards SET stage = 'incoming', pr_author = 'dana', pr_round = 2, pr_head_sha = 'a1b2c3d', pr_head_commits = 1, pr_seen_sha = 'e4f5a6b', pr_seen_commits = 3 WHERE key = 'APP-5'").run();

  const data = await openCard('APP-5', 'prreview', 'review');

  expect(data.review?.current).toBe(2);
  expect(data.review?.read.map((round) => round.number)).toEqual([1, 2]);
  expect(data.review?.read[0]?.blocks.map((block) => block.label)).toEqual(['issue']);
  expect(data.review?.why).toBe('dana pushed 2 commits after round 2.');
});

// The message buttons are wired in page code, which no test can render. Read as source: the request
// goes to the message route with the kind it asks for, and no draft file is read for the box.
it('asks the message route for a message and reads no draft file', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toContain("resolve('/api/card/[key]/commit-message', { key })");
  expect(source).toContain('body: JSON.stringify({ short, ...at(repo) })');
  expect(source).toContain('onwrite={writeMessage}');
  expect(source).not.toMatch(/COMMIT\.md|data\.draft|redraft/);
});

// The Settings tab draws the card's repositories from what the loader read, and no other tab
// pays for reading them.
it('loads the repository choice on the Settings tab only', async () => {
  writeSetting(db, 'repos', [
    { path: '.', base: 'main' },
    { path: 'api', base: 'main' },
  ]);
  try {
    const settings = (await openCard('APP-1', 'delivery', 'settings')) as unknown as { repos: { repos: { path: string }[] } | null };
    expect(settings.repos?.repos.map((repo) => repo.path)).toEqual(['.', 'api']);
    expect(((await openCard('APP-1', 'delivery', 'overview')) as unknown as { repos: unknown }).repos).toBeNull();
  } finally {
    writeSetting(db, 'repos', null);
  }
});

// One group per card repository, and the tab draws every one of them.
it('loads the Changes tab as one group per repository', async () => {
  const data = (await openCard('APP-1', 'delivery', 'changes')) as unknown as {
    groups: Promise<{ repo: string; name: string; changes: unknown; publish: unknown }[]>;
  };
  const groups = await data.groups;

  expect(groups.map((one) => one.repo)).toEqual(['.']);
  // The root goes by its folder's name, so the tab says which repository it is.
  expect(groups.map((one) => one.name)).toEqual([basename(project)]);
  expect(groups[0]?.changes).not.toBeNull();
  expect(data).not.toHaveProperty('changes');
  expect(data).not.toHaveProperty('publish');
});

// Each group's calls name its repository, and the project folder sends none, so the requests
// of a card with one repository are the ones it always sent.
it("sends the group's repository on the commit, message, patch and push calls", () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toContain("import { at } from '$lib/repo-param.ts';");
  expect(source).toContain('body: JSON.stringify({ message, only: paths, ...at(repo), ...(hooks ? { hooks: true } : {}) })');
  // The push goes to the card the tab shows, whatever its key.
  expect(source).toContain("resolve('/api/card/[key]/push', { key })");
  // Commit and push in the push dialog sends its message and untracked files on the same call.
  expect(source).toContain('body: JSON.stringify({ confirmed: true, ...at(repo), ...(commit ?? {}), ...(hooks ? { hooks: true } : {}) })');
  expect(source).toContain('new URLSearchParams({ path: ask.path, group: ask.group, ...at(repo) })');
  // A commit of the Not committed list names itself on its patch and its file list, with the repository.
  expect(source).toContain("if (ask.commit !== undefined) query.set('commit', ask.commit);");
  expect(source).toContain("`${resolve('/api/card/[key]/commit-diff', { key })}?${new URLSearchParams({ commit, ...at(repo) })}`");
  // The view is the address's, else the stage's default, and the switch writes it to the address.
  expect(source).toContain("changesView(\n      page.url.searchParams.get('view'),\n      data.ticket.stage,");
  expect(source).toContain("?view=${view}`, { keepFocus: true, noScroll: true });");
  expect(source).toContain(
    '<ChangeGroups {groups} view={viewOf(groups)} onview={pickView} oncommitdiff={commitDiff} card={page.params.key ?? null} onopen={open} oncommit={commit} onwrite={writeMessage} onpush={push} onpull={pull} oncopy={copyOutput} onopenpr={openPr} comments={data.comments ?? []} oncomment={comment} onedit={editComment} ondelete={deleteComment}>',
  );
  // The groups stream, so a git write waits for the new ones before it answers, as it did before they
  // streamed: the tab never says "Committed" over the old diff.
  expect(source).toContain('await Promise.allSettled([data.groups, data.qaStatus]);');
  expect(source.match(/await reread\(\);/g)?.length).toBe(5);
  // The pull after a rejected push names the group's repository too, and the page reads the card again.
  expect(source).toContain("const answer = await fetch(resolve('/api/card/[key]/pull', { key }), {");
  expect(source).toContain('body: JSON.stringify(at(repo)),');
});

// A diff comment goes to the card the tab shows and names its group's repository, and the Changes tab
// reads the card's comments with its groups.
it('posts a comment, an edit and a delete under the key of the page, and reads the comments on the Changes tab', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toContain("commentWrite(resolve('/api/card/[key]/comments', { key }), 'POST', { ...ask, ...at(repo) })");
  expect(source).toContain("commentWrite(resolve('/api/card/[key]/comments/[id]', { key, id: String(id) }), 'PATCH', { text })");
  expect(source).toContain("commentWrite(resolve('/api/card/[key]/comments/[id]', { key, id: String(id) }), 'DELETE')");
  expect(readFileSync(new URL('./+page.server.ts', import.meta.url), 'utf8')).toContain("comments: wanted.current === 'changes' ? commentsOf(database(), params.key) : null,");
});

// Send back with comments on the Changes tab posts under the card the tab shows, holds on the card of
// the Delivery snapshot, and says which Implement session it goes on in.
it('sends the comments back under the key of the page, and reads the Implement session on the Changes tab', async () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toContain("postWrite(fetch, resolve('/api/card/[key]/send-back', { key }), {})");
  expect(source).toContain("delivery?.cards.find((one) => one.key === page.params.key)");
  expect(source).toMatch(/\{#snippet next\(\)\}\s*\{#if shownCard !== null\}\s*<SendBackPanel /);

  startRun(db, { cardKey: 'APP-1', phase: 'implement', engine: 'fake', model: 'sonnet', effort: 'medium', sessionId: '5d82f1e9-7a3b-4c8d-9e0f-3b4a5c6d7e03', logPath: '', lane: null });
  const changes = (await openCard('APP-1', 'delivery', 'changes')) as unknown as { implementSession: string | null };
  const overview = (await openCard('APP-1', 'delivery', 'overview')) as unknown as { implementSession: string | null };
  expect(changes.implementSession).toBe('5d82f1e9');
  // The overview's Fix it goes on in it too, read with the overview so it never waits on the facts git
  // streams.
  expect(overview.implementSession).toBe('5d82f1e9');
  expect((await openCard('APP-1', 'delivery', 'files')) as unknown as { implementSession: string | null }).toMatchObject({ implementSession: null });
});

// The card page head counts the open diff comments, which Send back with comments names, and only a
// board with a Changes tab asks. A card with no checkout has no change to count.
it('counts the open diff comments in the card layout, and none on a board with no Changes tab', async () => {
  const { load: layout } = await import('../+layout.server.ts');
  const read = layout as unknown as (event: { params: { key: string } }) => Promise<{ openComments: number; changes: Promise<Record<string, string>> | null }>;
  const add = (key: string, sent: string | null) =>
    db
      .prepare("INSERT INTO diff_comments (card_key, repo, file, line, line_text, body, commit_sha, created_at, sent_at) VALUES (?, '.', 'src/list.ts', 1, 'x', 'Sort it.', 'abc123', '2026-10-15T08:00:00.000Z', ?)")
      .run(key, sent);
  add('APP-1', null);
  add('APP-1', null);
  add('APP-1', '2026-10-15T09:00:00.000Z');
  add('APP-2', null);
  // A second Delivery card, so the count must come from the key of the page and not from APP-1.
  createCard(db, { key: 'APP-77', board: 'delivery', stage: 'implement', title: 'APP-77 title' });
  add('APP-77', null);
  try {
    const delivery = await read({ params: { key: 'APP-1' } });
    expect(delivery.openComments).toBe(2);
    // No checkout yet, which the head says as "Changes none yet".
    expect(await delivery.changes).toEqual({ changes: 'none yet' });
    expect((await read({ params: { key: 'APP-2' } })).openComments).toBe(0);
    expect((await read({ params: { key: 'APP-77' } })).openComments).toBe(1);
  } finally {
    db.prepare('DELETE FROM diff_comments').run();
    db.prepare('DELETE FROM cards WHERE key = ?').run('APP-77');
  }
});

// The closed card asks the routes of its own key: the pull request state and the revert of its change.
it('reads the pull request state and posts the revert under the key of the page', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toContain("readCardPulls(resolve('/api/card/[key]/pr', { key }))");
  expect(source).toContain("fetch(resolve('/api/card/[key]/knowledge', { key }), {");
  // And the server sides read the card of the request, not a fixed one.
  expect(readFileSync(new URL('./+page.server.ts', import.meta.url), 'utf8')).toContain('cardKnowledge(database(), params.key)');
  expect(readFileSync(new URL('../../../api/card/[key]/pr/+server.ts', import.meta.url), 'utf8')).toContain('cardPulls(database(), params.key,');
});

// A pull changes the checkout whatever git answers, and a conflict shows only in the Changes the page
// loads, so the pull reads the card again before it answers the panel.
it('reads the card again after a pull', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
  const pull = source.slice(source.indexOf('async function pull('), source.indexOf('async function copyOutput('));

  // `reread` reads the card again and waits for the new Changes, which stream.
  expect(pull).toMatch(/await answer\.json\(\)[^\n]*\n\s*await reread\(\);/);
});

// A typed message, an open patch or a commit note belongs to one card, so the groups are drawn anew
// for the next card. The page cannot be mounted here, so this reads its source.
it('draws the groups anew for each card', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toMatch(/\{#key page\.params\.key\}\s*<ChangeGroups /);
});

// A closed card offers to remove its checkouts, on any board, and an open card does not.
it('marks a card closed only on its board archive stage', async () => {
  const flow = getSetting(db, 'deliveryFlow');
  const lastOf = (board: BoardKind) => boardFor(board, flow).stages.find((stage) => stage.role === 'archive')?.id ?? '';
  const closedOn = async (key: string, board: BoardKind, stage: string) =>
    (
      (await page({
        params: { key, tab: 'overview' },
        parent: async () => ({ tabs: tabsFor(board), ticket: { key, board, stage } as { key: string; board: string } }),
        request: new Request(`http://localhost/t/${key}/overview`),
        url: new URL(`http://localhost/t/${key}/overview`),
      })) as unknown as { closed: boolean }
    ).closed;

  expect(await closedOn('APP-1', 'delivery', lastOf('delivery'))).toBe(true);
  expect(await closedOn('APP-1', 'delivery', 'qa')).toBe(false);
  expect(await closedOn('APP-2', 'epics', lastOf('epics'))).toBe(true);
  expect(await closedOn('APP-2', 'epics', 'inbox')).toBe(false);
});

// The pull request state is read on a closed Delivery card only, because no other board's card has a
// pull request to wait on.
it('reads the pull request state on a closed Delivery card only', async () => {
  const flow = getSetting(db, 'deliveryFlow');
  const lastOf = (board: BoardKind) => boardFor(board, flow).stages.find((stage) => stage.role === 'archive')?.id ?? '';
  const pullsOn = async (key: string, board: BoardKind, stage: string) =>
    (
      (await page({
        params: { key, tab: 'overview' },
        parent: async () => ({ tabs: tabsFor(board), ticket: { key, board, stage } as { key: string; board: string } }),
        request: new Request(`http://localhost/t/${key}/overview`),
        url: new URL(`http://localhost/t/${key}/overview`),
      })) as unknown as { pulls: boolean }
    ).pulls;

  expect(await pullsOn('APP-1', 'delivery', lastOf('delivery'))).toBe(true);
  expect(await pullsOn('APP-1', 'delivery', 'qa')).toBe(false);
  expect(await pullsOn('APP-2', 'epics', lastOf('epics'))).toBe(false);
});

// The button is wired in page code, which no test can render. Read as source: it posts to the card's
// checkouts route.
it('asks the checkouts route to remove the checkouts', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toContain("fetch(resolve('/api/card/[key]/checkouts', { key }), { method: 'POST' })");
  expect(source).toContain('{#if data.closed}');
});

// QA FAIL: the overview opens with the QA FAIL only while the card waits in QA on it. A card moved
// back keeps its newest QA run, and a FAIL there is history.
it('marks a QA FAIL for the overview only while the card waits in QA on it', async () => {
  createCard(db, { key: 'APP-6', board: 'delivery', stage: 'qa', title: 'APP-6 title' });
  const id = startRun(db, { cardKey: 'APP-6', phase: 'qa', engine: 'fake', model: 'sonnet', effort: 'medium', sessionId: null, logPath: '', lane: 'stack' });
  db.prepare("UPDATE runs SET state = 'complete' WHERE id = ?").run(id);
  saveVerdict(db, id, { verdict: 'FAIL', reason: 'The list stays empty.' });
  const failedAt = async (stage: string, state: string) =>
    (
      (await page({
        params: { key: 'APP-6', tab: 'overview' },
        parent: async () => ({ tabs: tabsFor('delivery'), ticket: { key: 'APP-6', board: 'delivery', stage, state } as { key: string; board: string } }),
        request: new Request('http://localhost/t/APP-6/overview'),
        url: new URL('http://localhost/t/APP-6/overview'),
      })) as unknown as { qaFailed: boolean }
    ).qaFailed;

  expect(await failedAt('qa', 'ready')).toBe(true);
  expect(await failedAt('implement', 'ready')).toBe(false);
  expect(await failedAt('qa', 'queued')).toBe(false);
});

// Every streamed part is held per card, so the answer of one card never shows on the next. The
// page cannot change its address under a test, so the scope is read as source: each part takes the key
// in the address, and none a fixed one.
it('scopes every streamed part to the card in the address', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  for (const part of ['data.qaStatus', 'data.knowledgePatches', 'data.discussionTools']) {
    expect(source).toContain(`    () => ${part},\n    () => page.params.key,`);
  }
  expect(source).toContain('<Streamed promise={data.groups} scope={page.params.key}');
  expect(source).not.toMatch(/scope=\{['"]|\(\) => ['"]/);
});

it('sends the descriptions and the steps of the epic tasks with their titles and keys', () => {
  const source = readFileSync(join(import.meta.dirname, '+page.svelte'), 'utf8');
  expect(source).toContain('JSON.stringify({ titles, keys, descriptions, steps, refs, notes })');
  // An add that took with notes it could not write hands the note to the status line.
  expect(source).toContain("return typeof body.note === 'string' ? { note: body.note } : null;");
  expect(source).toContain('`${resolve(\'/api/tickets/read\')}?ref=${encodeURIComponent(ref)}`');
});

// The file links are page code too. A shown file goes by the path route, so a design screen's link to
// tokens.css lands beside it; a download keeps the query route.
it('shows a file by its path route and downloads it by the query route', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  expect(source).toContain("resolve('/api/card/[key]/files/[...path]', { key, path: path.split('/').map(encodeURIComponent).join('/') })");
  expect(source).toContain("`${resolve('/api/card/[key]/file', { key })}?${new URLSearchParams({ path, download: '1' })}`");
  expect(source).toContain("download = false) =>\n    download\n      ? `${resolve('/api/card/[key]/file', { key })}");
  expect(source).toContain('{fileUrl} onread={readFile}');
});
