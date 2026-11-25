import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { wallSpecFor } from './engine-walls.ts';
import { checkWall, envFilesUnder, gitCommonDir, gitPointers, specOnDisk, starredPaths, wallHere, walledCommand, type WallProbeDeps } from './wall-detect.ts';

const deps = (over: Partial<WallProbeDeps>): WallProbeDeps => ({
  exists: () => true,
  which: () => '/usr/bin/bwrap',
  run: () => 0,
  ...over,
});

describe('checkWall', () => {
  it('starts on macOS when sandbox-exec is there and its probe passes', () => {
    expect(checkWall('darwin', deps({}))).toEqual({ ready: true, binary: '/usr/bin/sandbox-exec' });
  });

  it('says sandbox-exec is missing', () => {
    expect(checkWall('darwin', deps({ exists: () => false }))).toEqual({ ready: false, reason: expect.stringContaining('missing') });
  });

  it('names a nested sandbox when the macOS probe fails', () => {
    expect(checkWall('darwin', deps({ run: () => 1 }))).toEqual({ ready: false, reason: expect.stringContaining('inside a sandbox') });
  });

  it('tells a missing bubblewrap apart from blocked user namespaces', () => {
    expect(checkWall('linux', deps({ which: () => null }))).toEqual({ ready: false, reason: expect.stringContaining('install') });
    const blocked = checkWall('linux', deps({ run: () => 1 }));
    expect(blocked).toEqual({ ready: false, reason: expect.stringContaining('kernel.apparmor_restrict_unprivileged_userns') });
    expect(blocked).toEqual({ ready: false, reason: expect.stringContaining('kernel.unprivileged_userns_clone') });
    expect(checkWall('linux', deps({ run: () => null }))).toEqual({ ready: false, reason: expect.stringContaining('user namespaces') });
  });

  // Native Windows never gets here: the nolzu command stops at start there and points to WSL2.
  it('refuses any system other than macOS and Linux', () => {
    expect(checkWall('win32', deps({}))).toEqual({ ready: false, reason: expect.stringContaining('macOS and Linux') });
    expect(checkWall('aix', deps({}))).toEqual({ ready: false, reason: expect.stringContaining('aix') });
  });
});

describe('envFilesUnder', () => {
  it('finds .env files, skips node_modules and .git, and stops at the depth', () => {
    const root = mkdtempSync(join(tmpdir(), 'nolzu-env-'));
    for (const dir of ['a/b', 'node_modules/x', '.git', 'deep/1/2']) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ['.env', '.env.local', 'a/b/.env.test', '.envy', 'node_modules/x/.env', '.git/.env', 'deep/1/2/.env']) {
      writeFileSync(join(root, file), 'X=1');
    }
    expect(envFilesUnder(root, 2).sort()).toEqual([join(root, '.env'), join(root, '.env.local'), join(root, 'a/b/.env.test')]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('starredPaths', () => {
  it('turns a star into each folder there now, and keeps a plain path as it is', () => {
    const root = mkdtempSync(join(tmpdir(), 'nolzu-star-'));
    for (const dir of ['projects/a/memory', 'projects/b']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'projects/file'), 'x');
    expect(starredPaths([join(root, 'settings.json'), join(root, 'projects/*/memory'), join(root, 'gone/*/memory')]).sort()).toEqual(
      [join(root, 'projects/a/memory'), join(root, 'projects/b/memory'), join(root, 'settings.json')].sort(),
    );
    rmSync(root, { recursive: true, force: true });
  });
});

describe('specOnDisk', () => {
  it('drops a missing writable path and turns the stars of both write-denied lists into folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'nolzu-ondisk-'));
    mkdirSync(join(root, 'projects/a'), { recursive: true });
    const spec = specOnDisk({ writable: [join(root, 'projects'), join(root, 'gone')], hidden: [], writeDenied: [join(root, 'projects/*/memory')], writeDeniedLiteral: [join(root, 'projects/*')], envRoots: [], envExceptions: [] });
    expect(spec.writable).toEqual([join(root, 'projects')]);
    expect(spec.writeDenied).toEqual([join(root, 'projects/a/memory')]);
    expect(spec.writeDeniedLiteral).toEqual([join(root, 'projects/a')]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('gitCommonDir', () => {
  it('reads a plain .git folder, a worktree back to the shared folder, and no .git at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'nolzu-gitdir-'));
    try {
      mkdirSync(join(root, 'app/.git/worktrees/APP-1'), { recursive: true });
      writeFileSync(join(root, 'app/.git/worktrees/APP-1/commondir'), '../..\n');
      mkdirSync(join(root, 'app/worktrees/APP-1'), { recursive: true });
      writeFileSync(join(root, 'app/worktrees/APP-1/.git'), `gitdir: ${join(root, 'app/.git/worktrees/APP-1')}\n`);
      expect(gitCommonDir(join(root, 'app'))).toBe(join(root, 'app/.git'));
      expect(gitCommonDir(join(root, 'app/worktrees/APP-1'))).toBe(join(root, 'app/.git'));
      expect(gitCommonDir(join(root, 'plain'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gitPointers', () => {
  it('changes when a run rewrites the .git file, rewrites commondir, or swaps a .git folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'nolzu-pointers-'));
    try {
      const own = join(root, 'app/.git/worktrees/APP-1');
      const tree = join(root, 'app/worktrees/APP-1');
      mkdirSync(own, { recursive: true });
      mkdirSync(tree, { recursive: true });
      writeFileSync(join(own, 'commondir'), '../..\n');
      writeFileSync(join(tree, '.git'), `gitdir: ${own}\n`);
      const before = gitPointers(tree);
      expect(gitPointers(tree)).toBe(before);
      // A file written in the checkout is no pointer.
      writeFileSync(join(tree, 'recipe.ts'), 'new');
      expect(gitPointers(tree)).toBe(before);
      writeFileSync(join(own, 'commondir'), '/elsewhere\n');
      expect(gitPointers(tree)).not.toBe(before);
      writeFileSync(join(own, 'commondir'), '../..\n');
      writeFileSync(join(tree, '.git'), `gitdir: ${join(tree, '.evil')}\n`);
      expect(gitPointers(tree)).not.toBe(before);

      // A repository one folder down, as a card on several repositories holds it.
      writeFileSync(join(tree, '.git'), `gitdir: ${own}\n`);
      mkdirSync(join(tree, 'api'));
      expect(gitPointers(tree)).toBe(before);
      writeFileSync(join(tree, 'api/.git'), `gitdir: ${own}\n`);
      const withChild = gitPointers(tree);
      expect(withChild).not.toBe(before);
      writeFileSync(join(tree, 'api/.git'), `gitdir: ${join(tree, '.evil')}\n`);
      expect(gitPointers(tree)).not.toBe(withChild);

      const plain = join(root, 'app');
      // git reads a `commondir` in a plain `.git` too, and a rewrite in place keeps its inode.
      writeFileSync(join(plain, '.git/commondir'), 'worktrees\n');
      const first = gitPointers(plain);
      writeFileSync(join(plain, '.git/commondir'), '/elsewhere\n');
      expect(gitPointers(plain)).not.toBe(first);
      const was = gitPointers(plain);
      renameSync(join(plain, '.git'), join(plain, '.git-old'));
      mkdirSync(join(plain, '.git'));
      expect(gitPointers(plain)).not.toBe(was);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('walledCommand', () => {
  it('refuses when the caller says a sandbox is already there', () => {
    const spec = { writable: [], hidden: [], writeDenied: [], envRoots: [], envExceptions: [] };
    expect('refused' in walledCommand(spec, '/bin/sh', [], true)).toBe(true);
  });

  it('refuses the run with the reason when the wall cannot start here, and never hands back the bare command', () => {
    const spec = { writable: [], hidden: [], writeDenied: [], envRoots: [], envExceptions: [] };
    const reason = 'bubblewrap is not installed.';
    expect(walledCommand(spec, '/bin/sh', [], false, { ready: false, reason })).toEqual({ refused: reason });
  });

  it('counts the variable Codex sets as a sandbox that is already there', () => {
    const spec = { writable: [], hidden: [], writeDenied: [], envRoots: [], envExceptions: [] };
    const before = process.env.CODEX_SANDBOX;
    process.env.CODEX_SANDBOX = 'seatbelt';
    try {
      expect(walledCommand(spec, '/bin/sh', [], false, { ready: true, binary: '/usr/bin/bwrap' })).toEqual({ refused: expect.stringContaining('already') });
    } finally {
      if (before === undefined) delete process.env.CODEX_SANDBOX;
      else process.env.CODEX_SANDBOX = before;
    }
  });

  it('answers the detection once per process', () => {
    expect(wallHere()).toBe(wallHere());
  });

  // The platform is stubbed, so both builders run on any machine. Nothing is spawned.
  describe.each(['darwin', 'linux'])('resolves links in every path, as %s', (platform) => {
    const scratch = join(import.meta.dirname, '../../../.vitest');
    mkdirSync(scratch, { recursive: true });
    const base = realpathSync(mkdtempSync(join(scratch, 'links-')));
    afterAll(() => rmSync(base, { recursive: true, force: true }));
    const real = join(base, 'real');
    const link = join(base, 'link');
    for (const dir of ['work', 'hid', 'wd', 'proj']) mkdirSync(join(real, dir), { recursive: true });
    writeFileSync(join(real, 'secret.txt'), 'x');
    writeFileSync(join(real, 'docker.sock'), 'x');
    writeFileSync(join(real, 'proj/.env'), 'x');
    writeFileSync(join(real, 'proj/.env.test'), 'x');
    symlinkSync(real, link);

    it('hands the wall the real paths and the right kind of hiding', () => {
      const spec = {
        writable: [join(link, 'work')],
        hidden: [join(link, 'hid'), join(link, 'secret.txt')],
        writeDenied: [join(link, 'wd')],
        envRoots: [join(link, 'proj')],
        envExceptions: [join(link, 'proj/.env.test')],
        sockets: [join(link, 'docker.sock')],
      };
      const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        const out = walledCommand(spec, '/bin/sh', ['-c', 'true'], false, { ready: true, binary: '/opt/wall/bwrap' });
        if ('refused' in out) throw new Error(out.refused);
        const text = JSON.stringify(out.args);
        expect(text).not.toContain(link);
        for (const dir of ['work', 'hid', 'wd']) expect(text).toContain(join(real, dir));
        if (platform === 'darwin') {
          expect(out.command).toBe('/usr/bin/sandbox-exec');
          expect(text).toContain(join(real, 'proj'));
          expect(text).toContain(join(real, 'proj/.env.test'));
        } else {
          expect(out.command).toBe('/opt/wall/bwrap');
          expect(out.args).toContain(join(real, 'secret.txt'));
          expect(out.args.join(' ')).toContain(`--ro-bind /dev/null ${join(real, 'secret.txt')}`);
          expect(out.args.join(' ')).toContain(`--ro-bind /dev/null ${join(real, 'docker.sock')}`);
          expect(out.args.join(' ')).toContain(`--tmpfs ${join(real, 'hid')}`);
          // The found .env is hidden, and the exception stays readable.
          expect(out.args.join(' ')).toContain(`--ro-bind /dev/null ${join(real, 'proj/.env')}`);
          expect(out.args.join(' ')).not.toContain(`/dev/null ${join(real, 'proj/.env.test')}`);
        }
      } finally {
        Object.defineProperty(process, 'platform', original);
      }
    });
  });
});

// The wall run for real with /bin/sh. The fixture sits under the repository's ignored `.vitest`
// folder, not the system temp folder, because the macOS wall leaves every process the temp folders.
const ready = wallHere();
// macOS only for now. On Linux the spec names ~/.claude/projects, which this empty home lacks, and
// bubblewrap opens only a path that is there.
const live = process.platform === 'darwin' && ready.ready;
const skipReason = ready.ready ? '' : ` (skipped: ${ready.reason})`;

describe.skipIf(!live)(`the wall on this machine${skipReason}`, () => {
  const scratch = join(import.meta.dirname, '../../../.vitest');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'wall-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const card = join(project, '.tasks/APP-1');
  for (const dir of [join(home, '.ssh'), join(home, '.claude'), card, join(project, 'src'), join(root, 'tmp')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(home, '.ssh/id_ed25519'), 'secret');
  writeFileSync(join(home, '.claude.json'), '{}');
  writeFileSync(join(home, '.claude/settings.json'), '{}');
  writeFileSync(join(project, 'src/recipe.ts'), 'old');
  writeFileSync(join(project, '.env'), 'TOKEN=1');
  writeFileSync(join(project, '.env.test'), 'TOKEN=test');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const spec = wallSpecFor({
    policy: { readOnly: true },
    vendor: 'claude-code',
    cardDir: card,
    knowledgeDir: null,
    checkout: project,
    home,
    tmp: join(root, 'tmp'),
    exceptions: [join(project, '.env.test')],
  });

  const sh = (script: string) => {
    const out = walledCommand(spec, '/bin/sh', ['-c', script]);
    if ('refused' in out) throw new Error(out.refused);
    return spawnSync(out.command, out.args, { encoding: 'utf8' }).status;
  };

  it('refuses a write into the read-only project', () => {
    expect(sh(`echo new > '${project}/src/recipe.ts'`)).not.toBe(0);
    expect(readFileSync(join(project, 'src/recipe.ts'), 'utf8')).toBe('old');
  });

  it('allows a write into the card folder', () => {
    expect(sh(`echo done > '${card}/summary.md'`)).toBe(0);
    expect(readFileSync(join(card, 'summary.md'), 'utf8')).toBe('done\n');
  });

  it('refuses a read of a hidden file and a .env file, and allows the exception', () => {
    expect(sh(`cat '${home}/.ssh/id_ed25519' | grep -q secret`)).not.toBe(0);
    expect(sh(`cat '${project}/.env' | grep -q TOKEN`)).not.toBe(0);
    expect(sh(`cat '${project}/.env.test' | grep -q test`)).toBe(0);
  });

  it('hides only files named .env or .env.something, not my.env.ts or .environment', () => {
    writeFileSync(join(project, 'src/my.env.ts'), 'code');
    writeFileSync(join(project, '.environment'), 'code');
    writeFileSync(join(root, 'tmp/lib.env.ts'), 'code');
    expect(sh(`cat '${project}/src/my.env.ts' | grep -q code`)).toBe(0);
    expect(sh(`cat '${project}/.environment' | grep -q code`)).toBe(0);
    expect(sh(`cat '${root}/tmp/lib.env.ts' | grep -q code`)).toBe(0);
    writeFileSync(join(project, '.env.local'), 'TOKEN=3');
    expect(sh(`cat '${project}/.env.local' | grep -q TOKEN`)).not.toBe(0);
  });

  it('keeps a .env file hidden in implement, where the run could move it', () => {
    writeFileSync(join(project, 'src/.env'), 'TOKEN=2');
    const implement = wallSpecFor({ policy: { readOnly: false }, vendor: 'claude-code', cardDir: card, knowledgeDir: null, checkout: project, home, tmp: join(root, 'tmp'), exceptions: [] });
    const out = walledCommand(implement, '/bin/sh', ['-c', `mv '${project}/.env' '${project}/moved'; mv '${project}/src' '${root}/tmp/src'; cat '${project}/moved' '${root}/tmp/src/.env'`]);
    if ('refused' in out) throw new Error(out.refused);
    const run = spawnSync(out.command, out.args, { encoding: 'utf8' });
    expect(run.stdout).not.toContain('TOKEN');
    expect(readFileSync(join(project, '.env'), 'utf8')).toBe('TOKEN=1');
  });

  it('refuses a write into a write-denied file inside a writable folder', () => {
    expect(sh(`echo session > '${home}/.claude/history.jsonl'`)).toBe(0);
    expect(sh(`echo hook > '${home}/.claude/settings.json'`)).not.toBe(0);
    expect(readFileSync(join(home, '.claude/settings.json'), 'utf8')).toBe('{}');
  });

  // The network stays open by decision, and a test that reached out would fail offline, so it is
  // not run here. Neither builder adds a network rule: see wall.test.ts.
});
