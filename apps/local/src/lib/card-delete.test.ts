import { describe, expect, it } from 'vitest';
import { branchGoes, changedSince, type DeleteFacts, deletePlan, type DeleteRepo, ignoredPaths, pickedUp, seenOf } from './card-delete.ts';

const facts = (over: Partial<DeleteFacts> = {}): DeleteFacts => ({ key: 'APP-3', running: null, appHeld: false, appState: false, source: null, tasks: [], epic: null, repos: [], ...over });
const branch = (ahead: number | null = 0, unpushed: number | null = 0) => ({ name: 'feature/app-3', ahead, unpushed });
const repo = (over: Partial<DeleteRepo> = {}): DeleteRepo => ({ repo: '.', base: 'main', checkout: true, changed: 0, ignored: [], unpushed: 0, branch: branch(), stuck: null, ...over });
const texts = (plan: ReturnType<typeof deletePlan>) => plan.warnings.map((one) => one.text);

describe('deletePlan', () => {
  it('refuses while a run is queued or going', () => {
    expect(deletePlan(facts({ running: 'running' })).refused).toBe('APP-3 has a run going. Stop the run first, then delete the card.');
    expect(deletePlan(facts({ running: 'queued' })).refused).toBe('APP-3 has a run in the queue. Stop the run first, then delete the card.');
    expect(deletePlan(facts()).refused).toBeNull();
  });

  it('refuses only while this process holds the app, and warns when only the stored state says it runs', () => {
    expect(deletePlan(facts({ appHeld: true, appState: true })).refused).toBe('APP-3 has its app started. Stop the app first, then delete the card.');
    const left = deletePlan(facts({ appState: true }));
    expect(left.refused).toBeNull();
    expect(left.warnings).toEqual([{ text: 'Its app may still be running from an earlier start. Nolzu holds no process for it, so stop it yourself if it is.', loses: true }]);
  });

  it('refuses with the reason when a checkout cannot be removed', () => {
    const stuck = 'The checkout of the project folder is on no branch, and 1 commit is held by nothing else. Put them on a branch first, with git switch -c inside the checkout, then delete the card.';
    const plan = deletePlan(facts({ repos: [repo({ branch: null, stuck })] }));
    expect(plan.refused).toBe(stuck);
    expect(texts(plan)).toEqual([]);
  });

  it('says what goes and that the time stays', () => {
    expect(deletePlan(facts()).goes).toBe('This deletes APP-3, its runs, its discussion and its history on the board. The time and cost of its runs stay in the timesheet.');
    expect(deletePlan(facts()).warnings).toEqual([]);
  });

  it('names the changed files and the commits not pushed, as a loss, and keeps the branch', () => {
    expect(deletePlan(facts({ repos: [repo({ changed: 3, unpushed: 2, branch: branch(2, 2) })] })).warnings).toEqual([
      { text: 'The checkout of the project folder is removed. It has 3 changed files and 2 commits not pushed. The changed files are lost.', loses: true },
      { text: 'The branch feature/app-3 stays, so its commits are not lost.', loses: false },
    ]);
  });

  it('names the files git ignores that go with the checkout, and softens a clean one', () => {
    expect(texts(deletePlan(facts({ repos: [repo({ ignored: ['.env'] })] })))[0]).toBe('The checkout of the project folder is removed. Files git ignores go with it: .env.');
    expect(texts(deletePlan(facts({ repos: [repo({ ignored: ['.env', 'data/local.db', 'secrets.json', 'a.key', 'b.key'] })] })))[0]).toBe(
      'The checkout of the project folder is removed. Files git ignores go with it: .env, data/local.db, secrets.json, and 2 more.',
    );
    expect(texts(deletePlan(facts({ repos: [repo({ ignored: null })] })))[0]).toBe('The checkout of the project folder is removed. git could not list the files it ignores, and any such file goes with it.');
    expect(texts(deletePlan(facts({ repos: [repo({ remade: 'dist/' })] })))[0]).toBe('The checkout of the project folder is removed. git shows nothing in it that is not committed, leaving out build folders such as dist/.');
    expect(deletePlan(facts({ repos: [repo()] })).warnings).toEqual([
      { text: 'The checkout of the project folder is removed. git shows nothing in it that is not committed.', loses: false },
      { text: 'The branch feature/app-3 is deleted, since it is merged into main.', loses: false },
    ]);
  });

  it('deletes a branch only once it is merged, and says why a pushed one stays', () => {
    expect(branchGoes(repo())).toBe(true);
    const pushed = repo({ branch: branch(2, 0) });
    expect(branchGoes(pushed)).toBe(false);
    expect(texts(deletePlan(facts({ repos: [pushed] })))[1]).toBe('The branch feature/app-3 stays. Its commits are on the remote as this clone last fetched it, but not in main.');
    expect(branchGoes(repo({ branch: branch(null, null) }))).toBe(false);
    expect(branchGoes(repo({ branch: null }))).toBe(false);
  });

  it('never deletes or names the base as the card branch', () => {
    const onBase = repo({ base: 'develop', branch: { name: 'develop', ahead: 0, unpushed: 0 } });
    expect(branchGoes(onBase)).toBe(false);
    expect(texts(deletePlan(facts({ repos: [onBase] })))).toEqual(['The checkout of the project folder is removed. git shows nothing in it that is not committed.']);
  });

  it('names a branch with no checkout too', () => {
    expect(texts(deletePlan(facts({ repos: [repo({ checkout: false, branch: branch(1, 1) })] })))).toEqual(['The branch feature/app-3 stays, so its commits are not lost.']);
  });

  it('says a ticket card is deleted in Nolzu only', () => {
    expect(texts(deletePlan(facts({ key: 'PROJ-123', source: 'jira' })))).toEqual(['PROJ-123 is deleted in Nolzu only, never in Jira. The next read of Jira does not bring it back.']);
    expect(texts(deletePlan(facts({ key: 'api#7', source: 'github-pr' })))[0]).toContain('never in GitHub');
    expect(texts(deletePlan(facts({ source: 'external' })))[0]).toContain('never in the ticket system');
  });

  it('says the tasks of an epic stay with no epic and stop reading its documents', () => {
    expect(texts(deletePlan(facts({ tasks: ['APP-4', 'APP-5'] })))).toEqual(["Its tasks APP-4 and APP-5 stay on the Delivery board as ordinary cards, with no epic, and stop reading the epic's documents."]);
    expect(texts(deletePlan(facts({ tasks: ['APP-4'] })))).toEqual(["Its task APP-4 stays on the Delivery board as an ordinary card, with no epic, and stops reading the epic's documents."]);
    expect(texts(deletePlan(facts({ epic: 'APP-1' })))).toEqual(['It leaves the epic APP-1.']);
  });
});

describe('changedSince', () => {
  it('finds more changed files, commits not pushed or ignored files than the confirm showed', () => {
    const seen = [{ repo: '.', changed: 2, unpushed: 1, ignored: 1 }];
    expect(changedSince([repo({ changed: 2, unpushed: 1, ignored: ['.env'] })], seen)).toBe(false);
    expect(changedSince([repo({ changed: 1, unpushed: 0 })], seen)).toBe(false);
    expect(changedSince([repo({ changed: 3, unpushed: 1 })], seen)).toBe(true);
    expect(changedSince([repo({ changed: 2, unpushed: 2 })], seen)).toBe(true);
    expect(changedSince([repo({ ignored: ['.env', 'local.db'] })], seen)).toBe(true);
    expect(changedSince([repo({ checkout: false, unpushed: 4 })], [])).toBe(false);
  });

  it('refuses a checkout the confirm did not show, even a clean one', () => {
    expect(changedSince([repo({ repo: 'api' })], [{ repo: '.', changed: 0, unpushed: 0, ignored: 0 }])).toBe(true);
    expect(changedSince([repo()], [])).toBe(true);
    expect(seenOf([repo({ changed: 1, ignored: ['.env'] }), repo({ repo: 'web', checkout: false })])).toEqual([{ repo: '.', changed: 1, unpushed: 0, ignored: 1 }]);
  });
});

describe('ignoredPaths', () => {
  it('names ignored files and leaves out folders tools make again, at any depth', () => {
    const porcelain = ['!! .env', '!! node_modules/', '!! web/node_modules/', '!! .svelte-kit/', '!! dist/', '!! api/target/', '!! .venv/', '!! build/', '!! data/local.db', '?? new.ts', ' M a.ts', '!! build', ''].join('\0');
    expect(ignoredPaths(porcelain)).toEqual({ named: ['.env', 'data/local.db', 'build'], remade: 'node_modules/' });
  });

  // vendor can hold the person's own code in a PHP or Go project, so it is named like any ignored file.
  it('names vendor, drops a .DS_Store, and keeps a space in a name as it is', () => {
    expect(ignoredPaths(['!! vendor/', '!! .DS_Store', '!! docs/.DS_Store', '!! my notes.txt', ''].join('\0'))).toEqual({ named: ['vendor/', 'my notes.txt'], remade: null });
  });

  // Python, Next.js and test caches come back with the next run of the tool, so they block no removal.
  it('leaves out the caches of the usual stacks, and still names a .env beside them', () => {
    const porcelain = ['!! __pycache__/', '!! app/__pycache__/', '!! .pytest_cache/', '!! .next/', '!! coverage/', '!! .eslintcache', '!! tsconfig.tsbuildinfo', '!! .env', ''].join('\0');
    expect(ignoredPaths(porcelain).named).toEqual(['.env']);
  });

  it('leaves out the other repositories of a workspace from its root', () => {
    expect(ignoredPaths(['!! api/', '!! web/', '!! .env', '!! apiary.txt', ''].join('\0'), ['api', 'web'])).toEqual({ named: ['.env', 'apiary.txt'], remade: null });
  });
});

it('says what a card added later on the key picks up', () => {
  expect(pickedUp(true, true)).toBe('A card added later on this key picks up this folder and its branch.');
  expect(pickedUp(true, false)).toBe('A card added later on this key picks up this folder.');
  expect(pickedUp(false, true)).toBe('A card added later on this key picks up its branch.');
  expect(pickedUp(false, false)).toBeNull();
});
