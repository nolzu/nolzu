import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { compareGit, gitAfter, gitBefore, type GitSnapshot, parseStatusZ, recordedRepos } from './read-only-check.ts';

// The repositories loop.ts names for a run that starts in `cwd`, on a project of one repository.
const onRecord = (made: TempRepo, cwd: string) => recordedRepos({ project: made.dir, repos: ['.'], key: basename(cwd), cardRepos: ['.'], cwd });

const snap = (over: Partial<GitSnapshot> = {}): GitSnapshot => ({
  root: '/work/recipes',
  head: 'refs/heads/main',
  commit: 'a'.repeat(40),
  refs: { 'refs/heads/main': 'a'.repeat(40) },
  skip: [],
  files: {},
  exclude: [],
  ignored: true,
  ...over,
});

describe('parseStatusZ', () => {
  it('reads changed, untracked and ignored entries, and both sides of a rename', () => {
    const text = [' M src/list.ts', '?? notes.txt', '!! dist/app.js', 'R  new.ts', 'old.ts', ''].join('\0');
    expect(parseStatusZ(text)).toEqual({
      'src/list.ts': ' M',
      'notes.txt': '??',
      'dist/app.js': '!!',
      'new.ts': 'R ',
      'old.ts': 'R  from',
    });
  });

  it('keeps a path with spaces whole', () => {
    expect(parseStatusZ('?? my notes.txt\0')).toEqual({ 'my notes.txt': '??' });
  });
});

describe('compareGit', () => {
  it('finds nothing when the two states match', () => {
    expect(compareGit(snap({ files: { 'a.ts': ' M x' } }), snap({ files: { 'a.ts': ' M x' } }))).toBeNull();
  });

  it('names a moved HEAD, a moved, a new and a deleted ref, and each changed file', () => {
    const before = snap({ refs: { 'refs/heads/main': 'a'.repeat(40), 'refs/tags/v1': 'c'.repeat(40) }, files: { 'kept.ts': ' M 1', 'edited.ts': ' M 1' } });
    const after = snap({
      head: 'refs/heads/other',
      refs: { 'refs/heads/main': 'b'.repeat(40), 'refs/heads/other': 'b'.repeat(40) },
      files: { 'kept.ts': ' M 1', 'edited.ts': ' M 2', 'new.txt': '?? 3' },
    });
    expect(compareGit(before, after)).toEqual({
      head: { from: 'refs/heads/main', to: 'refs/heads/other' },
      refs: [
        { ref: 'refs/heads/main', from: 'a'.repeat(40), to: 'b'.repeat(40) },
        { ref: 'refs/heads/other', from: null, to: 'b'.repeat(40) },
        { ref: 'refs/tags/v1', from: 'c'.repeat(40), to: null },
      ],
      files: [
        { path: 'edited.ts', from: ' M 1', to: ' M 2' },
        { path: 'new.txt', from: null, to: '?? 3' },
      ],
    });
  });

  it('leaves out a ref another checkout holds on either side', () => {
    const before = snap({ refs: { 'refs/heads/APP-2': 'a'.repeat(40) }, skip: ['refs/heads/APP-2'] });
    const after = snap({ refs: { 'refs/heads/APP-2': 'b'.repeat(40) } });
    expect(compareGit(before, after)).toBeNull();
  });
});

describe('the compare in a real repository', () => {
  let repos: TempRepo[] = [];
  afterEach(() => {
    for (const repo of repos) repo.remove();
    repos = [];
  });

  // A project on main with a card checkout as a worktree, the way Nolzu makes one.
  function setUp() {
    const made = tempRepo('nolzu-readonly-');
    repos.push(made);
    made.write('list.ts', 'export const list = [];\n');
    made.write('recipe.ts', 'export const recipe = 1;\n');
    made.write('.gitignore', 'dist/\n');
    made.commit('first commit');
    made.run('branch', 'side');
    const worktrees = join(made.dir, 'worktrees');
    const card = join(worktrees, 'APP-1');
    made.write('.git/info/exclude', '/worktrees/\n/.tasks/\n');
    made.run('worktree', 'add', '-q', '-b', 'APP-1', card);
    return { made, card, worktrees };
  }

  it('puts back a changed file, a moved ref and a new untracked file in its own checkout, and leaves the rest alone', async () => {
    const { made, card, worktrees } = setUp();
    // There before the run, so not the run's: an untracked file and a file the card already changed.
    writeFileSync(join(card, 'draft.md'), 'my draft\n');
    writeFileSync(join(card, 'recipe.ts'), 'export const recipe = 2;\n');
    const before = await gitBefore([card], { exclude: [], ignored: true, env: made.env });
    const side = made.run('rev-parse', 'side').trim();

    // The run breaks the rule.
    writeFileSync(join(card, 'list.ts'), 'export const list = ["soup"];\n');
    writeFileSync(join(card, 'stray.txt'), 'left by the run\n');
    mkdirSync(join(card, 'dist'));
    writeFileSync(join(card, 'dist', 'app.js'), 'built\n');
    made.run('-C', card, 'commit', '-q', '--allow-empty', '-m', 'run commit');
    made.run('update-ref', 'refs/heads/side', made.run('-C', card, 'rev-parse', 'HEAD').trim());

    const found = await gitAfter(before, { ownFolder: worktrees, env: made.env });

    expect(found?.restored).toBe(true);
    // The card's own branch went back with the commit. Another branch is the project's.
    expect(found?.left).toEqual(["Nolzu left refs/heads/side as it is, because the project's own repository holds it.", 'dist/app.js is a file git ignores, so Nolzu left it.']);
    expect(found?.diff).toContain('list.ts');
    expect(found?.diff).toContain('refs/heads/side moved');
    expect(found?.diff).toContain('New file stray.txt.');
    expect(found?.diff).not.toContain('recipe.ts');
    expect(readFileSync(join(card, 'list.ts'), 'utf8')).toBe('export const list = [];\n');
    expect(existsSync(join(card, 'stray.txt'))).toBe(false);
    // Ignored, so it may be a running program's, such as a database journal.
    expect(existsSync(join(card, 'dist', 'app.js'))).toBe(true);
    expect(made.run('rev-parse', 'side').trim()).not.toBe(side);
    expect(made.run('-C', card, 'log', '--format=%s', '-1').trim()).toBe('first commit');
    // What did not change during the run is untouched.
    expect(readFileSync(join(card, 'draft.md'), 'utf8')).toBe('my draft\n');
    expect(readFileSync(join(card, 'recipe.ts'), 'utf8')).toBe('export const recipe = 2;\n');
    expect((await gitAfter(before, { ownFolder: worktrees, env: made.env }))?.diff).not.toContain('list.ts');
  });

  it('does not remove or revert a file that was untracked or changed before the run, even when the run edits it', async () => {
    const { made, card, worktrees } = setUp();
    writeFileSync(join(card, 'draft.md'), 'my draft\n');
    writeFileSync(join(card, 'recipe.ts'), 'export const recipe = 2;\n');
    const before = await gitBefore([card], { exclude: [], ignored: true, env: made.env });

    writeFileSync(join(card, 'draft.md'), 'my draft, edited by the run\n');
    writeFileSync(join(card, 'recipe.ts'), 'export const recipe = 3;\n');
    const found = await gitAfter(before, { ownFolder: worktrees, env: made.env });

    expect(found?.restored).toBe(true);
    expect(found?.undone).toEqual([]);
    expect(found?.left.join('\n')).toContain('draft.md was already changed before the run');
    expect(found?.left.join('\n')).toContain('recipe.ts was already changed before the run');
    expect(readFileSync(join(card, 'draft.md'), 'utf8')).toBe('my draft, edited by the run\n');
    expect(readFileSync(join(card, 'recipe.ts'), 'utf8')).toBe('export const recipe = 3;\n');
  });

  it('does not count a remote ref that moves while the run goes', async () => {
    const { made, card, worktrees } = setUp();
    const head = made.run('rev-parse', 'HEAD').trim();
    made.run('update-ref', 'refs/remotes/origin/main', head);
    const before = await gitBefore([card], { exclude: [], ignored: true, env: made.env });

    made.run('commit', '-q', '--allow-empty', '-m', 'second');
    made.run('update-ref', 'refs/remotes/origin/main', made.run('rev-parse', 'HEAD').trim());
    made.run('update-ref', 'refs/remotes/origin/new', head);

    expect(await gitAfter(before, { ownFolder: worktrees, env: made.env })).toBeNull();
  });

  it("keeps a branch, a tag and a stash the person makes in their own folder while the run goes", async () => {
    const { made, card, worktrees } = setUp();
    const before = await gitBefore([card], { exclude: [], ignored: true, env: made.env });

    made.run('branch', 'idea');
    made.run('tag', 'v1');
    writeFileSync(join(made.dir, 'list.ts'), 'export const list = ["tea"];\n');
    made.run('stash', '-q');

    const found = await gitAfter(before, { ownFolder: worktrees, env: made.env });

    expect(found?.undone).toEqual([]);
    expect(made.run('rev-parse', '-q', '--verify', 'refs/heads/idea').trim()).not.toBe('');
    expect(made.run('rev-parse', '-q', '--verify', 'refs/tags/v1').trim()).not.toBe('');
    expect(made.run('stash', 'list').trim()).not.toBe('');
  });

  it('never touches the person\'s own folder, and keeps the diff', async () => {
    const { made, worktrees } = setUp();
    const before = await gitBefore([made.dir], { exclude: [join(made.dir, '.tasks'), worktrees], ignored: false, env: made.env });
    writeFileSync(join(made.dir, 'list.ts'), 'export const list = ["soup"];\n');
    writeFileSync(join(made.dir, 'stray.txt'), 'left by the run\n');
    // The card folder is the run's to write, and is no change.
    mkdirSync(join(made.dir, '.tasks', 'APP-1'), { recursive: true });
    writeFileSync(join(made.dir, '.tasks', 'APP-1', 'notes.md'), 'notes\n');

    // A repository one level inside the project folder is named by its path there.
    const found = await gitAfter(before, { ownFolder: worktrees, project: join(made.dir, '..'), env: made.env });

    expect(found?.diff.split('\n')[0]).toBe(`In ${basename(made.dir)}:`);
    expect(found?.restored).toBe(false);
    expect(found?.undone).toEqual([]);
    expect(found?.diff).toContain('+export const list = ["soup"];');
    expect(found?.diff).toContain('stray.txt');
    expect(found?.diff).not.toContain('notes.md');
    expect(readFileSync(join(made.dir, 'list.ts'), 'utf8')).toBe('export const list = ["soup"];\n');
    expect(existsSync(join(made.dir, 'stray.txt'))).toBe(true);
  });

  // A workspace: a card's folder sits in the excluded worktrees folder, so ignored files count. Another
  // card's new checkout there is Nolzu's own work, and git lists it as ignored even under the exclude.
  it('takes no notice of another card\'s new checkout made while a read-only run goes', async () => {
    const { made, worktrees } = setUp();
    const own = join(worktrees, 'REC-2');
    mkdirSync(own, { recursive: true });
    const before = await gitBefore(onRecord(made, own), { exclude: [join(made.dir, '.tasks'), worktrees], ignored: true, env: made.env });
    const other = join(worktrees, 'REC-1', 'recipes');
    mkdirSync(other, { recursive: true });
    made.run('init', '-q', other);
    writeFileSync(join(other, 'list.ts'), 'export const list = [];\n');
    mkdirSync(join(made.dir, '.tasks', 'REC-1'), { recursive: true });
    writeFileSync(join(made.dir, '.tasks', 'REC-1', 'ticket.md'), '# REC-1\n');

    expect(await gitAfter(before, { ownFolder: worktrees, project: made.dir, env: made.env })).toBeNull();
  });

  // The same run, and a file of the project changes: that is still a change, named inside the project.
  it('still warns on a real edit in the project, and names the folder the way the person knows it', async () => {
    const { made, worktrees } = setUp();
    const own = join(worktrees, 'REC-2');
    mkdirSync(own, { recursive: true });
    const before = await gitBefore(onRecord(made, own), { exclude: [join(made.dir, '.tasks'), worktrees], ignored: true, env: made.env });
    mkdirSync(join(worktrees, 'REC-1'), { recursive: true });
    writeFileSync(join(made.dir, 'list.ts'), 'export const list = ["soup"];\n');

    const found = await gitAfter(before, { ownFolder: worktrees, project: made.dir, env: made.env });

    expect(found?.restored).toBe(false);
    expect(found?.diff.split('\n')[0]).toBe('In the project folder:');
    expect(found?.diff).toContain('+export const list = ["soup"];');
    expect(found?.diff).not.toContain('REC-1');
  });

  // A wrap-up of another card commits its knowledge to the project's own repository while a
  // read-only run goes. main moves, but only by Nolzu's commit in a folder the run may write.
  it('takes no notice of a knowledge commit in the same repository', async () => {
    const { made, worktrees } = setUp();
    const own = join(worktrees, 'REC-2');
    mkdirSync(own, { recursive: true });
    const knowledge = join(made.dir, '.nolzu', 'knowledge');
    const before = await gitBefore(onRecord(made, own), { exclude: [join(made.dir, '.tasks'), worktrees, knowledge], ignored: true, env: made.env });
    made.write('.nolzu/knowledge/rules.md', '# Rules\n');
    made.run('add', '.nolzu/knowledge');
    made.run('commit', '-q', '-m', 'knowledge: REC-1 run 3');

    expect(await gitAfter(before, { ownFolder: worktrees, project: made.dir, env: made.env })).toBeNull();
  });

  it('still warns on a commit that touches a file of the project, or a branch moved back', async () => {
    const { made, worktrees } = setUp();
    const own = join(worktrees, 'REC-2');
    mkdirSync(own, { recursive: true });
    const knowledge = join(made.dir, '.nolzu', 'knowledge');
    const exclude = [join(made.dir, '.tasks'), worktrees, knowledge];
    const before = await gitBefore(onRecord(made, own), { exclude, ignored: true, env: made.env });
    const first = made.run('rev-parse', 'HEAD').trim();
    made.write('.nolzu/knowledge/rules.md', '# Rules\n');
    made.write('list.ts', 'export const list = ["soup"];\n');
    made.run('add', '.');
    made.run('commit', '-q', '-m', 'knowledge and a change');

    const found = await gitAfter(before, { ownFolder: worktrees, project: made.dir, env: made.env });
    expect(found?.diff).toContain(`refs/heads/main moved from ${first.slice(0, 7)}`);
    expect(found?.diff).toContain('+export const list = ["soup"];');

    // A reset back over a knowledge commit moves no file outside the folder, and is still a change.
    const later = await gitBefore(onRecord(made, own), { exclude, ignored: true, env: made.env });
    made.run('reset', '-q', '--soft', first);
    made.run('reset', '-q', '--hard');
    expect((await gitAfter(later, { ownFolder: worktrees, project: made.dir, env: made.env }))?.diff).toContain('refs/heads/main moved');
  });

  // A workspace: the folder is a repository of its own, with two repositories in it. A card on both
  // starts in its folder under worktrees/, which holds a checkout of each.
  function workspace() {
    const made = tempRepo('nolzu-readonly-ws-');
    repos.push(made);
    made.write('.gitignore', '/api/\n/web/\n/worktrees/\n/.tasks/\n');
    made.commit('first commit');
    const root = join(made.dir, 'worktrees', 'APP-1');
    for (const repo of ['api', 'web']) {
      const at = join(made.dir, repo);
      mkdirSync(at);
      made.run('-C', at, 'init', '-q', '-b', 'main');
      writeFileSync(join(at, 'a.ts'), 'a\n');
      made.run('-C', at, 'add', 'a.ts');
      made.run('-C', at, 'commit', '-q', '-m', 'a');
      made.run('-C', at, 'worktree', 'add', '-q', '-b', 'APP-1', join(root, repo));
    }
    const records = { project: made.dir, repos: ['api', 'web'], key: 'APP-1', cardRepos: ['api', 'web'], cwd: root };
    return { made, root, records };
  }

  it('reads the checkouts of a workspace card from its folder, from the records', async () => {
    const { made, root, records } = workspace();
    const named = recordedRepos(records);
    expect(named).toEqual([realpathSync(made.dir), realpathSync(join(root, 'api')), realpathSync(join(root, 'web'))]);
    const before = await gitBefore(named, { exclude: [], ignored: false, env: made.env });

    writeFileSync(join(root, 'api', 'a.ts'), 'changed\n');

    expect((await gitAfter(before, { ownFolder: null, env: made.env }))?.diff).toContain('a.ts');
  });

  // An Implement run may write the card's folder. A repository it leaves there, with a filter in its own
  // config, is in no record: the check never runs git in it, even in the place of a checkout the card
  // has not made yet.
  it('never reads a repository a run left in the card folder', async () => {
    const { made, root, records } = workspace();
    const marker = join(made.dir, '..', 'planted-filter-ran');
    for (const name of ['tools', 'docs']) {
      const at = join(root, name);
      mkdirSync(at);
      made.run('-C', at, 'init', '-q', '-b', 'main');
      writeFileSync(join(at, 'f.txt'), 'x\n');
      made.run('-C', at, 'add', 'f.txt');
      made.run('-C', at, 'commit', '-q', '-m', 'x');
      made.run('-C', at, 'config', 'filter.x.clean', `sh -c 'touch ${marker}; cat'`);
      writeFileSync(join(at, '.git', 'info', 'attributes'), '* filter=x\n');
      made.run('-C', at, 'read-tree', 'HEAD');
    }
    // docs is a repository of the project with no checkout for this card yet, so its place holds the run's.
    mkdirSync(join(made.dir, 'docs'));
    made.run('-C', join(made.dir, 'docs'), 'init', '-q', '-b', 'main');

    const named = recordedRepos({ ...records, repos: ['api', 'web', 'docs'], cardRepos: ['api', 'web', 'docs'] });
    const before = await gitBefore(named, { exclude: [], ignored: true, env: made.env });
    await gitAfter(before, { ownFolder: null, env: made.env });

    expect(named).not.toContain(realpathSync(join(root, 'tools')));
    expect(named).not.toContain(realpathSync(join(root, 'docs')));
    expect(existsSync(marker)).toBe(false);
  });

  it('reads the recorded repository the run starts in, and only it', () => {
    const { made, card } = setUp();
    expect(recordedRepos({ project: made.dir, repos: ['.'], key: 'APP-1', cardRepos: ['.'], cwd: card })).toEqual([realpathSync(card)]);
    expect(recordedRepos({ project: made.dir, repos: ['.'], key: 'APP-1', cardRepos: ['.'], cwd: join(made.dir, '.tasks', 'APP-1') })).toEqual([realpathSync(made.dir)]);
    // A folder above every record reads only the card's checkouts in it, where the old scan read each
    // repository one level down.
    expect(recordedRepos({ project: made.dir, repos: ['.'], key: 'APP-1', cardRepos: ['.'], cwd: join(made.dir, '..') })).toEqual([realpathSync(card)]);
    expect(recordedRepos({ project: made.dir, repos: ['.'], key: 'APP-2', cardRepos: ['.'], cwd: join(made.dir, '..') })).toEqual([]);
  });

  // A person may keep the repository elsewhere and link `.git` to it. The folder is on record, so the
  // check follows the link instead of reading nothing.
  it('reads a recorded project whose .git is a link to its git folder, and the card checkout of it', () => {
    const made = tempRepo('nolzu-readonly-linked-');
    repos.push(made);
    made.write('list.ts', 'export const list = [];\n');
    made.commit('first commit');
    const store = join(made.dir, '..', 'store.git');
    renameSync(join(made.dir, '.git'), store);
    symlinkSync(store, join(made.dir, '.git'));
    const card = join(made.dir, 'worktrees', 'APP-1');
    made.run('worktree', 'add', '-q', '-b', 'APP-1', card);
    expect(recordedRepos({ project: made.dir, repos: ['.'], key: 'APP-1', cardRepos: ['.'], cwd: made.dir })).toEqual([realpathSync(made.dir), realpathSync(card)]);
    expect(recordedRepos({ project: made.dir, repos: ['.'], key: 'APP-1', cardRepos: ['.'], cwd: card })).toEqual([realpathSync(card)]);
  });

  // A run that may write the card's checkout can point its `.git` at an own folder of its making whose
  // `commondir` names the real shared folder, with a `config.worktree` of its own in it. Only an own
  // folder inside the shared folder's `worktrees` counts.
  it("passes over a checkout whose own git folder sits outside the shared folder's worktrees", () => {
    const { made, card } = setUp();
    const common = realpathSync(join(made.dir, '.git'));
    const fake = join(made.dir, '..', 'fake-own');
    mkdirSync(fake);
    writeFileSync(join(fake, 'commondir'), `${common}\n`);
    writeFileSync(join(fake, 'HEAD'), 'ref: refs/heads/APP-1\n');
    writeFileSync(join(card, '.git'), `gitdir: ${fake}\n`);
    // From inside it, the project folder that holds it is what the check reads, never the checkout.
    expect(recordedRepos({ project: made.dir, repos: ['.'], key: 'APP-1', cardRepos: ['.'], cwd: card })).toEqual([realpathSync(made.dir)]);
    expect(recordedRepos({ project: made.dir, repos: ['.'], key: 'APP-1', cardRepos: ['.'], cwd: join(made.dir, '..') })).toEqual([]);
  });
});
