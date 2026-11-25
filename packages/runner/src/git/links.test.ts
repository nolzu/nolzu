import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { commitCard } from './commit.ts';
import { git } from './exec.ts';
import { gitLinkIn, linkBeforeWrite } from './links.ts';
import { pullBranch } from './pull.ts';

// A run that may write a card's git folders leaves a link where git writes by name; Nolzu's own git,
// outside the wall, must then refuse instead of writing the file the link points to.

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.remove();
  repo = null;
});

// The person's clone, a bare remote, and the card's checkout as a worktree that tracks its branch there.
function setUp() {
  const made = tempRepo('nolzu-links-');
  repo = made;
  made.write('list.ts', 'export const list = [];\n');
  made.commit('first commit');
  const bare = join(made.dir, '..', 'remote.git');
  made.run('init', '-q', '--bare', bare);
  made.run('remote', 'add', 'origin', bare);
  made.run('push', '-q', 'origin', 'main');
  // Real paths, as git and the check name them: the temp folder sits behind a link on macOS.
  const card = join(realpathSync(made.dir), '..', 'card');
  made.run('worktree', 'add', '-q', '-b', 'APP-1-work', card);
  made.run('-C', card, 'push', '-q', '-u', 'origin', 'APP-1-work');
  made.run('pack-refs', '--all');
  const common = join(realpathSync(made.dir), '.git');
  const own = join(common, 'worktrees', 'card');
  // A file of the person's, outside every repository, that a link points at.
  const canary = join(made.dir, '..', 'canary');
  writeFileSync(canary, 'export IMPORTANT=1\n');
  return { made, card, common, own, canary };
}

const commit = (made: TempRepo, card: string) => {
  writeFileSync(join(card, 'more.ts'), 'export const more = 1;\n');
  return commitCard({ worktreePath: card, message: 'add more', include: ['more.ts'], env: made.env });
};
const pull = (made: TempRepo, card: string) => pullBranch({ worktreePath: card, branch: 'APP-1-work', remote: 'origin', env: made.env });
const fetch = (made: TempRepo, card: string) => git(['fetch', '-q', 'origin'], { cwd: card, env: made.env });

// A socket at `path`, made at a short path first, because a socket's path has a short length limit.
async function socketAt(path: string): Promise<void> {
  const short = join(tmpdir(), `nolzu-${process.pid}-${Date.now()}.sock`);
  const server = createServer();
  await new Promise<void>((done) => server.listen(short, done));
  renameSync(short, path);
  await new Promise<void>((done) => server.close(() => done()));
}

describe("Nolzu's git over a link in a card's git folders", () => {
  // Each place git writes by name, for the checkout's own folder and the shared one.
  const places: [string, (s: ReturnType<typeof setUp>) => string][] = [
    ['COMMIT_EDITMSG in the own folder', (s) => join(s.own, 'COMMIT_EDITMSG')],
    ['FETCH_HEAD in the own folder', (s) => join(s.own, 'FETCH_HEAD')],
    ['a reflog under the shared logs/refs/heads', (s) => join(s.common, 'logs/refs/heads/APP-1-work')],
    ['packed-refs', (s) => join(s.common, 'packed-refs')],
    ['gc.log', (s) => join(s.common, 'gc.log')],
  ];

  for (const [name, place] of places) {
    it(`refuses a commit, a pull and a fetch over a symbolic link at ${name}, and leaves the file it points to alone`, async () => {
      const s = setUp();
      const path = place(s);
      mkdirSync(join(path, '..'), { recursive: true });
      rmSync(path, { force: true });
      symlinkSync(s.canary, path);
      const said = `${path} is a link, where git writes by name.`;
      // A commit reads the refs before it writes, and git itself refuses a packed-refs it cannot parse.
      expect((await commit(s.made, s.card)).ok).toBe(false);
      expect(linkBeforeWrite(['commit', '-m', 'x'], s.card, s.made.env)).toContain(said);
      const pulled = await pull(s.made, s.card);
      expect(pulled.ok ? '' : pulled.reason).toContain(said);
      const fetched = await fetch(s.made, s.card);
      expect(fetched.code).not.toBe(0);
      expect(fetched.stderr).toContain(said);
      expect(readFileSync(s.canary, 'utf8')).toBe('export IMPORTANT=1\n');
    });
  }

  it('refuses over a hard link to a file outside, and over a named pipe', async () => {
    const s = setUp();
    const head = join(s.own, 'FETCH_HEAD');
    linkSync(s.canary, head);
    expect((await fetch(s.made, s.card)).stderr).toContain(`${head} is a file with a second name`);
    expect((await commit(s.made, s.card)).ok).toBe(false);
    expect(readFileSync(s.canary, 'utf8')).toBe('export IMPORTANT=1\n');
    rmSync(head);
    spawnSync('mkfifo', [join(s.own, 'MERGE_MSG')]);
    expect((await pull(s.made, s.card)).ok).toBe(false);
  });

  it('refuses a link anywhere in the own folder, and a linked folder in the shared refs', async () => {
    const s = setUp();
    mkdirSync(join(s.own, 'rebase-merge'));
    symlinkSync(s.canary, join(s.own, 'rebase-merge', 'message'));
    expect(gitLinkIn({ own: s.own, common: s.common })?.path).toBe(join(s.own, 'rebase-merge', 'message'));
    rmSync(join(s.own, 'rebase-merge'), { recursive: true });
    const outside = join(s.card, '..', 'elsewhere');
    mkdirSync(outside);
    symlinkSync(outside, join(s.common, 'refs', 'tags', 'linked'));
    expect(gitLinkIn({ own: s.own, common: s.common })).toEqual({ path: join(s.common, 'refs', 'tags', 'linked'), kind: 'link' });
    rmSync(join(s.common, 'refs', 'tags', 'linked'));
    // A name skipped right inside a git folder is still looked at further down.
    symlinkSync(s.canary, join(s.common, 'refs', 'heads', 'objects'));
    expect(gitLinkIn({ own: s.own, common: s.common })?.path).toBe(join(s.common, 'refs', 'heads', 'objects'));
    // The same from the person's own folder, where the whole git folder is walked as one.
    expect(gitLinkIn({ own: s.common, common: s.common })?.path).toBe(join(s.common, 'refs', 'heads', 'objects'));
  });

  it('passes a clean checkout, a linked hook, and the objects, and lets a commit and a pull through', async () => {
    const s = setUp();
    // A person may link a hook, and git runs none for Nolzu. Objects are written through a rename.
    symlinkSync(s.canary, join(s.common, 'hooks', 'pre-commit'));
    linkSync(s.canary, join(s.common, 'objects', 'info', 'linked'));
    expect(gitLinkIn({ own: s.own, common: s.common })).toBeNull();
    expect((await commit(s.made, s.card)).ok).toBe(true);
    expect((await pull(s.made, s.card)).ok).toBe(true);
  });

  it('passes the sockets of git\'s fsmonitor daemon, and refuses a named pipe in either folder', async () => {
    const s = setUp();
    await socketAt(join(s.own, 'fsmonitor--daemon.ipc'));
    await socketAt(join(s.common, 'fsmonitor--daemon.ipc'));
    expect(gitLinkIn({ own: s.own, common: s.common })).toBeNull();
    expect(linkBeforeWrite(['branch', '-D', 'x'], s.made.dir, s.made.env)).toBeNull();
    expect((await commit(s.made, s.card)).ok).toBe(true);
    for (const pipe of [join(s.own, 'MERGE_MSG'), join(s.common, 'MERGE_RR')]) {
      spawnSync('mkfifo', [pipe]);
      expect(gitLinkIn({ own: s.own, common: s.common })).toEqual({ path: pipe, kind: 'pipe' });
      expect(linkBeforeWrite(['commit', '-m', 'x'], s.card, s.made.env)).toContain(`${pipe} is a named pipe`);
      rmSync(pipe);
    }
  });

  it('looks in the shared folder only where git writes by name', () => {
    const s = setUp();
    // A person's exclude file kept with their dotfiles, and a checkout with a link on its way out.
    rmSync(join(s.common, 'info', 'exclude'), { force: true });
    symlinkSync(s.canary, join(s.common, 'info', 'exclude'));
    mkdirSync(join(s.common, 'nolzu-removing', 'APP-9-x', 'node_modules', '.bin'), { recursive: true });
    symlinkSync('../x.js', join(s.common, 'nolzu-removing', 'APP-9-x', 'node_modules', '.bin', 'x'));
    for (const at of [s.made.dir, s.card]) expect(linkBeforeWrite(['branch', '-D', 'x'], at, s.made.env)).toBeNull();
    // A file at the top of the shared folder, and a folder below that git writes in, still refuse.
    for (const place of ['config', 'rr-cache/x/preimage', 'rebase-merge/message', 'rebase-apply/patch', 'sequencer/todo', 'worktrees/card/rebase-apply/msg', 'worktrees/other/HEAD']) {
      const path = join(s.common, place);
      mkdirSync(join(path, '..'), { recursive: true });
      rmSync(path, { force: true });
      symlinkSync(s.canary, path);
      expect(linkBeforeWrite(['branch', '-D', 'x'], s.made.dir, s.made.env)).toContain(`${path} is a link`);
      rmSync(path);
    }
  });

  it('finds a folder git writes in under the name git opens, whatever case or folded letter it holds', () => {
    const s = setUp();
    // `LOGS`, and `logſ` with a long s, are the folder `logs` on a file system that folds them, as
    // macOS does by default; there git writes through them, and so the check must look.
    for (const hidden of ['LOGS', 'logſ']) {
      renameSync(join(s.common, 'logs'), join(s.common, hidden));
      const folds = readdirSync(s.common).includes(hidden) && existsSync(join(s.common, 'logs'));
      const link = join(s.common, hidden, 'refs', 'heads', 'APP-1-work');
      rmSync(link, { force: true });
      symlinkSync(s.canary, link);
      const refused = linkBeforeWrite(['commit', '-m', 'x'], s.card, s.made.env);
      if (folds) expect(refused).toContain('is a link');
      else expect(refused).toBeNull();
      rmSync(link);
      renameSync(join(s.common, hidden), join(s.common, 'logs'));
    }
  });

  it('refuses a link at the top of the shared folder, a linked hooks folder aside', () => {
    const s = setUp();
    const elsewhere = join(s.made.dir, '..', 'elsewhere');
    mkdirSync(join(elsewhere, 'hooks'), { recursive: true });
    rmSync(join(s.common, 'hooks'), { recursive: true, force: true });
    symlinkSync(join(elsewhere, 'hooks'), join(s.common, 'hooks'));
    expect(linkBeforeWrite(['branch', '-D', 'x'], s.made.dir, s.made.env)).toBeNull();
    for (const name of ['objects', 'logs']) {
      renameSync(join(s.common, name), join(elsewhere, name));
      symlinkSync(join(elsewhere, name), join(s.common, name));
      expect(linkBeforeWrite(['branch', '-D', 'x'], s.made.dir, s.made.env)).toContain(`${join(s.common, name)} is a link`);
      rmSync(join(s.common, name));
      renameSync(join(elsewhere, name), join(s.common, name));
    }
  });

  it("reads a project whose .git is a link to its git folder elsewhere from the real folder", () => {
    const s = setUp();
    const moved = join(s.made.dir, '..', 'moved.git');
    renameSync(join(s.made.dir, '.git'), moved);
    symlinkSync(moved, join(s.made.dir, '.git'));
    expect(linkBeforeWrite(['branch', '-D', 'x'], s.made.dir, s.made.env)).toBeNull();
    symlinkSync(s.canary, join(moved, 'logs', 'refs', 'heads', 'x'));
    expect(linkBeforeWrite(['branch', '-D', 'x'], s.made.dir, s.made.env)).toContain(`${join(realpathSync(moved), 'logs', 'refs', 'heads', 'x')} is a link`);
  });

  it('checks only commands that write, in the folder a leading -C names, and the folders GIT_DIR names', () => {
    const s = setUp();
    symlinkSync(s.canary, join(s.own, 'SQUASH_MSG'));
    expect(linkBeforeWrite(['status'], s.card, s.made.env)).toBeNull();
    expect(linkBeforeWrite(['log', '-1'], s.card, s.made.env)).toBeNull();
    for (const read of [['branch', '--show-current'], ['branch', '--all', '--contains', 'HEAD'], ['worktree', 'list', '--porcelain'], ['symbolic-ref', '-q', 'HEAD']]) {
      expect(linkBeforeWrite(read, s.card, s.made.env)).toBeNull();
    }
    for (const write of [['branch', '-D', 'x'], ['worktree', 'remove', 'x'], ['symbolic-ref', 'HEAD', 'refs/heads/x'], ['pull'], ['push'], ['merge', 'x'], ['stash'], ['checkout', 'x'], ['switch', 'x'], ['rebase', 'x'], ['cherry-pick', 'x'], ['update-ref', 'x', 'y'], ['tag', 'x']]) {
      expect(linkBeforeWrite(write, s.card, s.made.env)).toContain('SQUASH_MSG is a link');
    }
    expect(linkBeforeWrite(['-c', 'x.y=z', 'reset', '--hard'], s.card, s.made.env)).toContain('SQUASH_MSG is a link');
    expect(linkBeforeWrite(['-C', s.card, 'commit', '-m', 'x'], s.made.dir, s.made.env)).toContain('SQUASH_MSG is a link');
    // From a folder in no repository, only the -C folder leads to the link.
    expect(linkBeforeWrite(['commit', '-m', 'x'], join(s.card, '..'), s.made.env)).toBeNull();
    expect(linkBeforeWrite(['-C', s.card, 'commit', '-m', 'x'], join(s.card, '..'), s.made.env)).toContain('SQUASH_MSG is a link');
    // The person's own folder holds every card's folder too, where its worktree commands write.
    expect(linkBeforeWrite(['worktree', 'lock', s.card], s.made.dir, s.made.env)).toContain('SQUASH_MSG is a link');
    expect(linkBeforeWrite(['commit', '-m', 'x'], join(s.card, '..'), { GIT_DIR: s.own, GIT_COMMON_DIR: s.common })).toContain('SQUASH_MSG is a link');
    // An own folder that is not one of the shared folder's worktrees is looked in too.
    const away = join(s.card, '..', 'away.git');
    mkdirSync(away);
    symlinkSync(s.canary, join(away, 'MERGE_MSG'));
    expect(linkBeforeWrite(['commit', '-m', 'x'], join(s.card, '..'), { GIT_DIR: away, GIT_COMMON_DIR: s.common })).toContain(`${realpathSync(away)}/MERGE_MSG is a link`);
    mkdirSync(join(s.card, 'src'));
    expect(linkBeforeWrite(['commit', '-m', 'x'], join(s.card, 'src'), s.made.env)).toContain('SQUASH_MSG is a link');
  });
});
