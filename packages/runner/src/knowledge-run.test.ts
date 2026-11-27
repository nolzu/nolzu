import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunGit } from './git/base.ts';
import { PATCH_CAP_BYTES } from './git/diff.ts';
import { git } from './git/exec.ts';
import {
  applyKnowledge,
  commitKnowledge,
  type HeldKnowledge,
  holdKnowledge,
  knowledgeChanges,
  knowledgeCommitMessage,
  knowledgeDiffs,
  knowledgeRevertMessage,
  knowledgeState,
  revertKnowledgeFile,
} from './knowledge-run.ts';

// Signing on with no signer there is how git refuses a commit in these tests. A hook would not do,
// because the knowledge commits run no hooks.
const refuseCommits = (cli: (...args: string[]) => string, repo: string): void => {
  cli('config', 'commit.gpgsign', 'true');
  cli('config', 'gpg.program', join(repo, 'no-such-gpg'));
};

describe('knowledgeChanges', () => {
  it('names the files this run added, corrected and removed', () => {
    const after = ['?? .nolzu/knowledge/importer.md', ' M .nolzu/knowledge/stack.md', ' D .nolzu/knowledge/old.md'];

    expect(knowledgeChanges([], after)).toEqual([
      { path: '.nolzu/knowledge/importer.md', kind: 'added' },
      { path: '.nolzu/knowledge/old.md', kind: 'removed' },
      { path: '.nolzu/knowledge/stack.md', kind: 'corrected' },
    ]);
  });

  // The other side. A file that was already changed when the run started belongs to the person
  // working in the same repository, or to an earlier run, and committing it would take their work.
  it('leaves out a file that was already changed before the run', () => {
    const before = [' M .nolzu/knowledge/stack.md'];
    const after = [' M .nolzu/knowledge/stack.md', '?? .nolzu/knowledge/importer.md'];

    expect(knowledgeChanges(before, after)).toEqual([{ path: '.nolzu/knowledge/importer.md', kind: 'added' }]);
  });

  // git runs with `core.quotepath=false` here, so a non-ASCII name arrives as it is. A name holding
  // a double quote is still quoted and escaped, which is the case this has to read back.
  it('reads back a path git quoted because of the name', () => {
    expect(knowledgeChanges([], ['?? "knowledge/a\\"b.md"'])).toEqual([{ path: 'knowledge/a"b.md', kind: 'added' }]);
  });

  it('finds nothing when the run changed nothing', () => {
    expect(knowledgeChanges([' M knowledge/stack.md'], [' M knowledge/stack.md'])).toEqual([]);
  });
});

it('names the card and the run in the commit message', () => {
  expect(knowledgeCommitMessage('APP-1', 12)).toBe('knowledge: APP-1 run 12');
});

describe('commitKnowledge in a real repository', () => {
  let repo = '';
  let knowledge = '';
  // No config of the person's own, so the test runs the same on every machine.
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  } as Record<string, string>;

  const cli = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  const run = (args: readonly string[]) => git(args, { cwd: knowledge, env, repo: { project: repo, workTree: repo } });
  const write = (name: string, text: string) => writeFileSync(join(knowledge, name), text);

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-repo-'));
    // The default place: a folder inside the project's own repository, so every path git prints
    // starts at the repository root and not at the folder git ran in.
    knowledge = join(repo, '.nolzu', 'knowledge');
    mkdirSync(knowledge, { recursive: true });
    cli('init', '-q', '-b', 'main');
    cli('commit', '-q', '--allow-empty', '-m', 'first');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const record: { commits: string[]; files: string[][] } = { commits: [], files: [] };
  const keep = (made: { commit: string; changes: readonly { path: string }[] }) => {
    record.commits.push(made.commit);
    record.files.push(made.changes.map((change) => change.path));
  };

  beforeEach(() => {
    record.commits = [];
    record.files = [];
  });

  it('commits what the run wrote, with the card and the run in the message', async () => {
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');

    const made = await commitKnowledge({ run, cardKey: 'APP-1', runId: 7, before, after: await knowledgeState(run), record: keep });

    expect(made?.changes).toEqual([{ path: '.nolzu/knowledge/importer.md', kind: 'added' }]);
    expect(cli('log', '-1', '--pretty=%s')).toContain('knowledge: APP-1 run 7');
    expect(cli('show', '--name-only', '--pretty=', 'HEAD').trim()).toBe('.nolzu/knowledge/importer.md');
    expect(record.commits).toEqual([made?.commit]);
  });

  // A pointer in the person's repository makes their own git status run inside the run's repository.
  it('commits no pointer to a repository the run made in a subfolder', async () => {
    const before = await knowledgeState(run);
    const tips = join(knowledge, 'tips');
    mkdirSync(tips);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tips, env });
    writeFileSync(join(tips, 'a.md'), 'a\n');
    execFileSync('git', ['add', 'a.md'], { cwd: tips, env });
    execFileSync('git', ['commit', '-q', '-m', 'a'], { cwd: tips, env });

    await expect(commitKnowledge({ run, cardKey: 'APP-1', runId: 7, before, after: await knowledgeState(run), record: keep })).rejects.toThrow('has its own .git folder');
    expect(cli('ls-files', '--stage').includes('160000')).toBe(false);
    expect(cli('log', '-1', '--pretty=%s').trim()).toBe('first');
  });

  // Nobody is asked before this commit, so a hook a run wrote would run outside the wall.
  it('runs no hook of the repository', async () => {
    const mark = join(repo, '.git', 'hook-ran');
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${mark}"\nexit 1\n`, { mode: 0o755 });
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');

    const made = await commitKnowledge({ run, cardKey: 'APP-1', runId: 7, before, after: await knowledgeState(run), record: keep });

    expect(made?.changes).toHaveLength(1);
    expect(existsSync(mark)).toBe(false);
  });

  // One run is one commit, and one row per file in it. With one file only, a commit holding the
  // first path alone would look the same as a commit holding them all.
  it('puts every file the run touched in the one commit', async () => {
    write('stack.md', 'The stack is TypeScript.\n');
    cli('add', '--', '.nolzu/knowledge/stack.md');
    cli('commit', '-q', '-m', 'a knowledge file that was already there');
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');
    write('stack.md', 'The stack is TypeScript, and sqlite through node:sqlite.\n');

    const made = await commitKnowledge({ run, cardKey: 'APP-1', runId: 7, before, after: await knowledgeState(run), record: keep });

    expect(cli('show', '--name-only', '--pretty=', 'HEAD').trim().split('\n').sort()).toEqual([
      '.nolzu/knowledge/importer.md',
      '.nolzu/knowledge/stack.md',
    ]);
    expect(made?.changes).toEqual([
      { path: '.nolzu/knowledge/importer.md', kind: 'added' },
      { path: '.nolzu/knowledge/stack.md', kind: 'corrected' },
    ]);
    expect(record.files).toEqual([['.nolzu/knowledge/importer.md', '.nolzu/knowledge/stack.md']]);
    expect(cli('status', '--porcelain', '-uall').trim()).toBe('');
  });

  // The knowledge folder sits inside the project's own repository, and a person keeps working in it
  // while a wrap-up runs. Their file is not the run's to commit.
  it('leaves a file changed outside the knowledge folder out of the commit', async () => {
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');
    writeFileSync(join(repo, 'README.md'), 'the project, not the knowledge\n');

    await commitKnowledge({ run, cardKey: 'APP-1', runId: 7, before, after: await knowledgeState(run), record: keep });

    expect(cli('show', '--name-only', '--pretty=', 'HEAD').trim()).toBe('.nolzu/knowledge/importer.md');
    expect(cli('status', '--porcelain', '-uall').trim()).toBe('?? README.md');
  });

  it('writes no commit and no row when the run changed nothing', async () => {
    const head = cli('rev-parse', 'HEAD').trim();
    const before = await knowledgeState(run);

    const made = await commitKnowledge({ run, cardKey: 'APP-1', runId: 7, before, after: await knowledgeState(run), record: keep });

    expect(made).toBeNull();
    expect(record.commits).toEqual([]);
    expect(cli('rev-parse', 'HEAD').trim()).toBe(head);
  });

  // The person's own work sits in the same repository. A wrap-up that swept it into its commit
  // would put their half-finished file into the knowledge history under a card's name.
  it('leaves a file the person edited before the run out of the commit', async () => {
    write('mine.md', 'my own note\n');
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');

    await commitKnowledge({ run, cardKey: 'APP-1', runId: 7, before, after: await knowledgeState(run), record: keep });

    expect(cli('show', '--name-only', '--pretty=', 'HEAD').trim()).toBe('.nolzu/knowledge/importer.md');
    expect(cli('status', '--porcelain', '-uall').trim()).toBe('?? .nolzu/knowledge/mine.md');
  });

  // The row and the commit have to agree. A commit no row names is invisible to the Knowledge
  // screen, so nobody can read it or revert it.
  it('takes the commit back when the row write fails', async () => {
    const head = cli('rev-parse', 'HEAD').trim();
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');

    await expect(
      commitKnowledge({
        run,
        cardKey: 'APP-1',
        runId: 7,
        before,
        after: await knowledgeState(run),
        record: () => {
          throw new Error('the database is gone');
        },
      }),
    ).rejects.toThrow('the database is gone');

    expect(cli('rev-parse', 'HEAD').trim()).toBe(head);
    // What the run wrote is still there, unstaged, so the person sees it and nothing is lost.
    expect(cli('status', '--porcelain', '-uall').trim()).toBe('?? .nolzu/knowledge/importer.md');
    expect(existsSync(join(knowledge, 'importer.md'))).toBe(true);
  });

  it('leaves the person their staged work when it takes a commit back', async () => {
    write('mine.md', 'my own note\n');
    cli('add', '--', '.nolzu/knowledge/mine.md');
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');

    await expect(
      commitKnowledge({
        run,
        cardKey: 'APP-1',
        runId: 7,
        before,
        after: await knowledgeState(run),
        record: () => {
          throw new Error('the database is gone');
        },
      }),
    ).rejects.toThrow('the database is gone');

    expect(cli('status', '--porcelain', '-uall').trim().split('\n').sort()).toEqual([
      '?? .nolzu/knowledge/importer.md',
      'A  .nolzu/knowledge/mine.md',
    ]);
  });

  // The other direction: git refuses the commit, so no row may be written either.
  it('writes no row when git refuses the commit', async () => {
    refuseCommits(cli, repo);
    const head = cli('rev-parse', 'HEAD').trim();
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');

    await expect(
      commitKnowledge({ run, cardKey: 'APP-1', runId: 7, before, after: await knowledgeState(run), record: keep }),
    ).rejects.toThrow(/gpg|sign/i);

    expect(record.commits).toEqual([]);
    expect(cli('rev-parse', 'HEAD').trim()).toBe(head);
    // Nothing of the run stays staged, or the person's next commit carries it.
    expect(cli('status', '--porcelain', '-uall').trim()).toBe('?? .nolzu/knowledge/importer.md');
  });

  // Somebody committed in the same repository between our commit and the failing row write. Their
  // commit is not ours to reset, so ours stays, and no row names it. The one case where the commit
  // and the rows do not agree, and it is written down rather than hidden.
  it('keeps its commit when somebody committed on top of it', async () => {
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');

    await expect(
      commitKnowledge({
        run,
        cardKey: 'APP-1',
        runId: 7,
        before,
        after: await knowledgeState(run),
        record: () => {
          writeFileSync(join(repo, 'theirs.md'), 'their own work\n');
          cli('add', '--', 'theirs.md');
          cli('commit', '-q', '-m', 'their commit');
          throw new Error('the database is gone');
        },
      }),
    ).rejects.toThrow('the database is gone');

    expect(cli('log', '--pretty=%s').trim().split('\n')).toEqual(['their commit', 'knowledge: APP-1 run 7', 'first']);
  });

  describe('a knowledge repository with no commit yet', () => {
    beforeEach(() => {
      // The outer setup already made one, and only the newest is removed at the end.
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      repo = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-empty-'));
      knowledge = join(repo, 'knowledge');
      mkdirSync(knowledge, { recursive: true });
      cli('init', '-q', '-b', 'main');
    });

    it('makes the first commit of the repository', async () => {
      const before = await knowledgeState(run);
      write('importer.md', 'The importer skips a row it cannot parse.\n');

      const made = await commitKnowledge({ run, cardKey: 'APP-1', runId: 1, before, after: await knowledgeState(run), record: keep });

      expect(made?.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(cli('log', '-1', '--pretty=%s')).toContain('knowledge: APP-1 run 1');
    });

    it('takes that first commit back when the row write fails', async () => {
      const before = await knowledgeState(run);
      write('importer.md', 'The importer skips a row it cannot parse.\n');

      await expect(
        commitKnowledge({
          run,
          cardKey: 'APP-1',
          runId: 1,
          before,
          after: await knowledgeState(run),
          record: () => {
            throw new Error('the database is gone');
          },
        }),
      ).rejects.toThrow('the database is gone');

      // No commit at all, which is where the repository was.
      expect((await git(['rev-parse', 'HEAD'], { cwd: knowledge, env })).code).not.toBe(0);
      expect(existsSync(join(knowledge, 'importer.md'))).toBe(true);
    });
  });
});

// The review setting's own path: what the run wrote is kept aside, the folder goes back to what it
// was, and the kept copy is what Approve writes and commits.
describe('holdKnowledge and applyKnowledge in a real repository', () => {
  let repo = '';
  let knowledge = '';
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  } as Record<string, string>;

  const cli = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  const run = (args: readonly string[]) => git(args, { cwd: knowledge, env, repo: { project: repo, workTree: repo } });
  const write = (name: string, text: string) => writeFileSync(join(knowledge, name), text);
  const read = (name: string) => readFileSync(join(knowledge, name), 'utf8');
  const status = () => cli('status', '--porcelain', '-uall').trim();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-review-'));
    knowledge = join(repo, '.nolzu', 'knowledge');
    mkdirSync(knowledge, { recursive: true });
    cli('init', '-q', '-b', 'main');
    write('stack.md', 'The stack is TypeScript.\n');
    cli('add', '--', '.nolzu/knowledge/stack.md');
    cli('commit', '-q', '-m', 'a knowledge file that was already there');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const held: HeldKnowledge[] = [];
  const keep = (one: HeldKnowledge) => held.push(one);
  beforeEach(() => {
    held.length = 0;
  });

  const hold = async (act: () => void) => {
    const before = await knowledgeState(run);
    act();
    return holdKnowledge({ run, cardKey: 'APP-1', runId: 7, before, after: await knowledgeState(run), keep });
  };

  it('takes a new file back out of the folder and keeps what it said', async () => {
    const answer = await hold(() => write('importer.md', 'The importer skips a row it cannot parse.\n'));

    expect(existsSync(join(knowledge, 'importer.md'))).toBe(false);
    expect(status()).toBe('');
    expect(answer?.files).toEqual([
      { path: '.nolzu/knowledge/importer.md', kind: 'added', content: 'The importer skips a row it cannot parse.\n' },
    ]);
    expect(held).toEqual([answer]);
  });

  it('puts a corrected file back to the committed text and keeps the correction', async () => {
    const answer = await hold(() => write('stack.md', 'The stack is TypeScript, and sqlite through node:sqlite.\n'));

    expect(read('stack.md')).toBe('The stack is TypeScript.\n');
    expect(status()).toBe('');
    expect(answer?.files[0]?.content).toBe('The stack is TypeScript, and sqlite through node:sqlite.\n');
  });

  it('brings a file the run removed back, and remembers that it was removed', async () => {
    const answer = await hold(() => rmSync(join(knowledge, 'stack.md')));

    expect(read('stack.md')).toBe('The stack is TypeScript.\n');
    expect(answer?.files).toEqual([{ path: '.nolzu/knowledge/stack.md', kind: 'removed', content: null }]);
  });

  it('holds nothing when the run wrote nothing', async () => {
    const answer = await hold(() => undefined);

    expect(answer).toBeNull();
    expect(held).toEqual([]);
  });

  // The person keeps working in the same repository while a wrap-up runs. Their file is not the
  // run's, so putting the folder back must not touch it.
  it('leaves a file the person changed before the run alone', async () => {
    write('mine.md', 'my own note\n');
    const answer = await hold(() => write('importer.md', 'The importer skips a row it cannot parse.\n'));

    expect(answer?.files.map((file) => file.path)).toEqual(['.nolzu/knowledge/importer.md']);
    expect(status()).toBe('?? .nolzu/knowledge/mine.md');
    expect(read('mine.md')).toBe('my own note\n');
  });

  // The kept copy is stored before the folder is touched. A store that failed and a folder already
  // put back would lose what the run wrote, with nothing to apply later.
  it('leaves the run its files when the kept copy cannot be stored', async () => {
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');

    await expect(
      holdKnowledge({
        run,
        cardKey: 'APP-1',
        runId: 7,
        before,
        after: await knowledgeState(run),
        keep: () => {
          throw new Error('the database is gone');
        },
      }),
    ).rejects.toThrow('the database is gone');

    expect(read('importer.md')).toBe('The importer skips a row it cannot parse.\n');
  });

  it('writes an approved change back and commits it under the card and the run', async () => {
    const answer = await hold(() => write('importer.md', 'The importer skips a row it cannot parse.\n'));
    const commits: string[] = [];

    const sha = await applyKnowledge({ run, held: answer!, record: (commit) => commits.push(commit) });

    expect(read('importer.md')).toBe('The importer skips a row it cannot parse.\n');
    expect(cli('log', '-1', '--pretty=%s').trim()).toBe('knowledge: APP-1 run 7');
    expect(cli('show', '--name-only', '--pretty=', 'HEAD').trim()).toBe('.nolzu/knowledge/importer.md');
    expect(commits).toEqual([sha]);
    expect(status()).toBe('');
  });

  it('commits the removal of a file the run took out', async () => {
    const answer = await hold(() => rmSync(join(knowledge, 'stack.md')));

    await applyKnowledge({ run, held: answer!, record: () => undefined });

    expect(existsSync(join(knowledge, 'stack.md'))).toBe(false);
    expect(cli('show', '--name-status', '--pretty=', 'HEAD').trim()).toBe('D\t.nolzu/knowledge/stack.md');
    expect(status()).toBe('');
  });

  it('commits every file of the run in one commit', async () => {
    const answer = await hold(() => {
      write('importer.md', 'The importer skips a row it cannot parse.\n');
      write('stack.md', 'The stack is TypeScript, and sqlite through node:sqlite.\n');
    });

    await applyKnowledge({ run, held: answer!, record: () => undefined });

    expect(cli('show', '--name-only', '--pretty=', 'HEAD').trim().split('\n').sort()).toEqual([
      '.nolzu/knowledge/importer.md',
      '.nolzu/knowledge/stack.md',
    ]);
  });

  // The same rule an applied run follows: a commit no row names is invisible to the screen.
  it('takes the approved commit back when the row write fails', async () => {
    const answer = await hold(() => write('importer.md', 'The importer skips a row it cannot parse.\n'));
    const head = cli('rev-parse', 'HEAD').trim();

    await expect(
      applyKnowledge({
        run,
        held: answer!,
        record: () => {
          throw new Error('the database is gone');
        },
      }),
    ).rejects.toThrow('the database is gone');

    expect(cli('rev-parse', 'HEAD').trim()).toBe(head);
    // Put back, not left written. Content nobody approved and no row names is what this setting
    // exists to keep out of the folder.
    expect(existsSync(join(knowledge, 'importer.md'))).toBe(false);
    expect(status()).toBe('');
  });

  // A person reads on the screen that the change waits, opens the file and writes their own line in
  // it. That edit was never committed, so nothing could bring it back.
  it('refuses to write over a file the person changed while the change waited, and names it', async () => {
    const answer = await hold(() => write('stack.md', 'The stack is TypeScript, and sqlite through node:sqlite.\n'));
    write('stack.md', 'The stack is TypeScript. We deploy on Friday.\n');

    await expect(applyKnowledge({ run, held: answer!, record: () => undefined })).rejects.toThrow('.nolzu/knowledge/stack.md changed since');

    expect(read('stack.md')).toBe('The stack is TypeScript. We deploy on Friday.\n');
    expect(cli('log', '-1', '--pretty=%s').trim()).toBe('a knowledge file that was already there');
  });

  it('puts the folder back when git refuses the approved commit', async () => {
    const answer = await hold(() => write('importer.md', 'The importer skips a row it cannot parse.\n'));
    refuseCommits(cli, repo);

    await expect(applyKnowledge({ run, held: answer!, record: () => undefined })).rejects.toThrow(/gpg|sign/i);

    expect(existsSync(join(knowledge, 'importer.md'))).toBe(false);
    expect(status()).toBe('');
  });

  it('puts a corrected file back to the committed text when the approved commit is refused', async () => {
    const answer = await hold(() => write('stack.md', 'The stack is TypeScript, and sqlite through node:sqlite.\n'));
    refuseCommits(cli, repo);

    await expect(applyKnowledge({ run, held: answer!, record: () => undefined })).rejects.toThrow(/put back/);

    expect(read('stack.md')).toBe('The stack is TypeScript.\n');
    expect(status()).toBe('');
  });

  // git can refuse a checkout for its own reasons, such as another git holding the index. Reading
  // that as "HEAD never had this file" and deleting it would lose the committed knowledge too.
  it('keeps a tracked file when git cannot check it out, and says what git said', async () => {
    const answer = await hold(() => write('stack.md', 'The stack is TypeScript, and sqlite through node:sqlite.\n'));
    refuseCommits(cli, repo);
    const stubborn = async (args: readonly string[]) =>
      args[0] === 'checkout' ? { code: 1, stdout: '', stderr: 'fatal: Unable to create index.lock: File exists' } : run(args);

    await expect(applyKnowledge({ run: stubborn, held: answer!, record: () => undefined })).rejects.toThrow('Unable to create index.lock');

    expect(existsSync(join(knowledge, 'stack.md'))).toBe(true);
  });
});

it('names the file, the card and the run in a revert commit message', () => {
  expect(knowledgeRevertMessage('APP-1', 12, '.nolzu/knowledge/stack.md')).toBe('knowledge revert: .nolzu/knowledge/stack.md from APP-1 run 12');
});

// One click on the Knowledge screen. The effect is what the file says afterwards, so every test
// here reads the file back out of a real repository.
describe('revertKnowledgeFile in a real repository', () => {
  let repo = '';
  let knowledge = '';
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  } as Record<string, string>;

  const cli = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  const run = (args: readonly string[]) => git(args, { cwd: knowledge, env, repo: { project: repo, workTree: repo } });
  const write = (name: string, text: string) => writeFileSync(join(knowledge, name), text);
  const read = (name: string) => readFileSync(join(knowledge, name), 'utf8');
  const status = () => cli('status', '--porcelain', '-uall').trim();
  const subjects = () => cli('log', '--pretty=%s').trim().split('\n');

  // The knowledge commit this revert takes back, as a wrap-up run would leave it.
  const taught = (name: string, text: string): string => {
    write(name, text);
    cli('add', '--', `.nolzu/knowledge/${name}`);
    cli('commit', '-q', '-m', knowledgeCommitMessage('APP-1', 7));
    return cli('rev-parse', 'HEAD').trim();
  };

  const revert = (sha: string, name: string, record: (commit: string) => void = () => undefined) =>
    revertKnowledgeFile({ run, sha, path: `.nolzu/knowledge/${name}`, cardKey: 'APP-1', runId: 7, record });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-revert-'));
    knowledge = join(repo, '.nolzu', 'knowledge');
    mkdirSync(knowledge, { recursive: true });
    cli('init', '-q', '-b', 'main');
    write('stack.md', 'The stack is TypeScript.\n');
    cli('add', '--', '.nolzu/knowledge/stack.md');
    cli('commit', '-q', '-m', 'a knowledge file that was already there');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('puts a corrected file back to the text it had before the change', async () => {
    const sha = taught('stack.md', 'The stack is TypeScript, and we deploy on Friday.\n');

    const commit = await revert(sha, 'stack.md');

    expect(read('stack.md')).toBe('The stack is TypeScript.\n');
    expect(cli('show', `${commit}:.nolzu/knowledge/stack.md`)).toBe('The stack is TypeScript.\n');
    expect(status()).toBe('');
  });

  // A revert is a commit. The commit it takes back stays in the history, because that history is
  // the person's.
  it('adds a revert commit and leaves the commit it takes back where it is', async () => {
    const sha = taught('stack.md', 'The stack is TypeScript, and we deploy on Friday.\n');

    await revert(sha, 'stack.md');

    expect(subjects()).toEqual([
      'knowledge revert: .nolzu/knowledge/stack.md from APP-1 run 7',
      'knowledge: APP-1 run 7',
      'a knowledge file that was already there',
    ]);
    expect(cli('cat-file', '-t', sha).trim()).toBe('commit');
  });

  it('takes a file the run added back out of the folder', async () => {
    const sha = taught('importer.md', 'The importer skips a row it cannot parse.\n');

    await revert(sha, 'importer.md');

    expect(existsSync(join(knowledge, 'importer.md'))).toBe(false);
    expect(status()).toBe('');
  });

  it('brings a file the run removed back', async () => {
    rmSync(join(knowledge, 'stack.md'));
    cli('commit', '-q', '-m', knowledgeCommitMessage('APP-1', 7), '--', '.nolzu/knowledge/stack.md');
    const sha = cli('rev-parse', 'HEAD').trim();

    await revert(sha, 'stack.md');

    expect(read('stack.md')).toBe('The stack is TypeScript.\n');
    expect(status()).toBe('');
  });

  // Somebody rewrote the history of their own repository. The row still names a commit that is
  // gone, and the sentence names it too.
  it('refuses a commit the folder does not have, and names it', async () => {
    const gone = 'b'.repeat(40);

    await expect(revert(gone, 'stack.md')).rejects.toThrow(`The knowledge folder has no commit ${gone.slice(0, 7)} any more`);

    expect(status()).toBe('');
    expect(subjects()).toEqual(['a knowledge file that was already there']);
  });

  // The file moved on after that commit, so taking the commit back on its own would drop what came
  // after it. Nothing is written and nothing is committed.
  it('leaves the folder as it was when a later commit changed the file', async () => {
    const sha = taught('stack.md', 'The stack is TypeScript, and we deploy on Friday.\n');
    const later = taught('stack.md', 'The stack is TypeScript, and we deploy on Tuesday.\n');

    await expect(revert(sha, 'stack.md')).rejects.toThrow(`.nolzu/knowledge/stack.md changed after commit ${sha.slice(0, 7)}`);

    expect(read('stack.md')).toBe('The stack is TypeScript, and we deploy on Tuesday.\n');
    expect(cli('rev-parse', 'HEAD').trim()).toBe(later);
    expect(status()).toBe('');
  });

  it('leaves the folder as it was when the file carries an edit nobody committed', async () => {
    const sha = taught('stack.md', 'The stack is TypeScript, and we deploy on Friday.\n');
    write('stack.md', 'The stack is TypeScript, and we deploy on Tuesday.\n');

    await expect(revert(sha, 'stack.md')).rejects.toThrow('.nolzu/knowledge/stack.md carries an edit nobody committed');

    expect(read('stack.md')).toBe('The stack is TypeScript, and we deploy on Tuesday.\n');
    expect(cli('rev-parse', 'HEAD').trim()).toBe(sha);
  });

  // A change that removed a note leaves that path free, and a person can write their own note
  // there. It is untracked, so `git diff` says nothing about it. Writing over it would drop work
  // git cannot bring back.
  it('leaves a note nobody committed alone at the path a change removed', async () => {
    rmSync(join(knowledge, 'stack.md'));
    cli('commit', '-q', '-m', knowledgeCommitMessage('APP-1', 7), '--', '.nolzu/knowledge/stack.md');
    const sha = cli('rev-parse', 'HEAD').trim();
    mkdirSync(knowledge, { recursive: true });
    write('stack.md', 'My own note, never committed.\n');

    await expect(revert(sha, 'stack.md')).rejects.toThrow('.nolzu/knowledge/stack.md carries an edit nobody committed');

    expect(read('stack.md')).toBe('My own note, never committed.\n');
    expect(cli('rev-parse', 'HEAD').trim()).toBe(sha);
  });

  // The knowledge folder can be its own repository, and then the first run to teach anything makes
  // the first commit. There is no commit before it, and every path in it is one it added.
  it('takes the first commit of a repository back by removing what it added', async () => {
    const own = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-own-'));
    const there = (args: readonly string[]) => git(args, { cwd: own, env, repo: { project: own, workTree: own } });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: own, env });
    writeFileSync(join(own, 'stack.md'), 'The stack is TypeScript.\n');
    execFileSync('git', ['add', '-A'], { cwd: own, env });
    execFileSync('git', ['commit', '-q', '-m', knowledgeCommitMessage('APP-1', 7)], { cwd: own, env });
    const first = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: own, env, encoding: 'utf8' }).trim();

    await revertKnowledgeFile({ run: there, sha: first, path: 'stack.md', cardKey: 'APP-1', runId: 7, record: () => undefined });

    expect(existsSync(join(own, 'stack.md'))).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: own, env, encoding: 'utf8' }).trim()).toBe('');
    rmSync(own, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // git answered neither "the same" nor "different". Reading that as clean would write over
  // whatever the folder holds.
  it('refuses when git cannot compare the file with the commit', async () => {
    const sha = taught('stack.md', 'The stack is TypeScript, and we deploy on Friday.\n');
    const broken: RunGit = (args) => (args[0] === 'diff' ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: bad object' }) : run(args));

    await expect(
      revertKnowledgeFile({ run: broken, sha, path: '.nolzu/knowledge/stack.md', cardKey: 'APP-1', runId: 7, record: () => undefined }),
    ).rejects.toThrow('fatal: bad object');

    expect(cli('rev-parse', 'HEAD').trim()).toBe(sha);
    expect(status()).toBe('');
  });

  // The sentence a person reads when the checkout fails. It says what the file was going back to,
  // in words, because a sha with a caret after it tells nobody anything.
  it('names in words what it could not put the file back to', async () => {
    const sha = taught('stack.md', 'The stack is TypeScript, and we deploy on Friday.\n');
    const broken: RunGit = (args) => (args[0] === 'checkout' ? Promise.resolve({ code: 1, stdout: '', stderr: '' }) : run(args));

    await expect(
      revertKnowledgeFile({ run: broken, sha, path: '.nolzu/knowledge/stack.md', cardKey: 'APP-1', runId: 7, record: () => undefined }),
    ).rejects.toThrow(`git could not put .nolzu/knowledge/stack.md back to what it was before commit ${sha.slice(0, 7)}.`);
  });

  // The row and the commit have to agree. A revert commit no row names would leave the screen
  // saying the change is still applied while the folder no longer holds it.
  it('takes the revert commit back when the row write fails', async () => {
    const sha = taught('stack.md', 'The stack is TypeScript, and we deploy on Friday.\n');

    await expect(
      revert(sha, 'stack.md', () => {
        throw new Error('the database is gone');
      }),
    ).rejects.toThrow('the database is gone');

    expect(cli('rev-parse', 'HEAD').trim()).toBe(sha);
    expect(read('stack.md')).toBe('The stack is TypeScript, and we deploy on Friday.\n');
    expect(status()).toBe('');
  });

  it('puts the file back when git refuses the revert commit', async () => {
    const sha = taught('stack.md', 'The stack is TypeScript, and we deploy on Friday.\n');
    refuseCommits(cli, repo);

    await expect(revert(sha, 'stack.md')).rejects.toThrow(/gpg|sign/i);

    expect(read('stack.md')).toBe('The stack is TypeScript, and we deploy on Friday.\n');
    expect(status()).toBe('');
  });
});

// The patch a team project sends up instead of committing. Real git, because the whole point of
// this helper is what git prints: a corrected file has to read as a change to the file under it and
// not as a file that is all new, and the paths in the patch header have to be the paths the
// proposal names.
describe('knowledgeDiffs in a real repository', () => {
  let repo = '';
  let knowledge = '';
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  } as Record<string, string>;

  const cli = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  // Capped the way the client caps it, so the one test below that asks for a patch over the cap
  // meets the same runner a run meets.
  const run = (args: readonly string[]) => git(args, { cwd: knowledge, env, maxStdout: PATCH_CAP_BYTES + 1, repo: { project: repo, workTree: repo } });
  const write = (name: string, text: string) => writeFileSync(join(knowledge, name), text);
  const diffs = async (before: readonly string[]) => knowledgeDiffs({ run, before, after: await knowledgeState(run) });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-diff-'));
    // The default place, a folder inside the project's own repository, so a path git prints starts
    // at the repository root and the prefix has to come off it.
    knowledge = join(repo, '.nolzu', 'knowledge');
    mkdirSync(knowledge, { recursive: true });
    cli('init', '-q', '-b', 'main');
    write('stack.md', 'The stack is TypeScript.\n');
    cli('add', '--', '.nolzu/knowledge/stack.md');
    cli('commit', '-q', '-m', 'a knowledge file that was already there');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // The normal case for a team that already has notes, and the one a new file cannot stand in for:
  // the patch has to carry the line the run added and not the whole file.
  it('reads a corrected file as a change to the file under it', async () => {
    const before = await knowledgeState(run);
    write('stack.md', 'The stack is TypeScript.\nThe database is sqlite.\n');

    const files = await diffs(before);

    expect(files.map((one) => one.path)).toEqual(['stack.md']);
    const diff = files[0]?.diff ?? '';
    // Folder relative on both sides of the header, which is the path the proposal names and the
    // path the apply writes. Repository relative here and the two would disagree.
    expect(diff).toContain('diff --git a/stack.md b/stack.md');
    expect(diff).toContain('+The database is sqlite.');
    expect(diff).not.toContain('new file mode');
    expect(diff).not.toContain('.nolzu/knowledge/stack.md');
  });

  // A run has no command, so it writes files. But nothing stops an engine from staging one, and
  // against the index alone a staged correction reads as no change at all, which sends the file up
  // as new.
  it('reads a correction the run staged against the last commit', async () => {
    const before = await knowledgeState(run);
    write('stack.md', 'The stack is TypeScript.\nThe database is sqlite.\n');
    cli('add', '--', '.nolzu/knowledge/stack.md');

    const files = await diffs(before);

    expect(files.map((one) => one.path)).toEqual(['stack.md']);
    expect(files[0]?.diff).toContain('+The database is sqlite.');
    expect(files[0]?.diff).not.toContain('new file mode');
  });

  it('reads a file the run removed as a deletion', async () => {
    const before = await knowledgeState(run);
    rmSync(join(knowledge, 'stack.md'));

    const files = await diffs(before);

    expect(files.map((one) => one.path)).toEqual(['stack.md']);
    expect(files[0]?.diff).toContain('deleted file mode');
    expect(files[0]?.diff).toContain('+++ /dev/null');
  });

  it('reads a new file as a new file, against nothing', async () => {
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');

    const files = await diffs(before);

    expect(files.map((one) => one.path)).toEqual(['importer.md']);
    expect(files[0]?.diff).toContain('diff --git a/importer.md b/importer.md');
    expect(files[0]?.diff).toContain('new file mode');
    expect(files[0]?.diff).toContain('+The importer skips a row it cannot parse.');
  });

  // A file the hold keeps has to be a file the proposal carries. An empty note used to be read as
  // a file with nothing to review, and a file left out of the frame is a file the team approves
  // without ever having seen it.
  it('carries a note the run left empty', async () => {
    const before = await knowledgeState(run);
    write('open-questions.md', '');

    const files = await diffs(before);

    expect(files.map((one) => one.path)).toEqual(['open-questions.md']);
    expect(files[0]?.diff).toContain('new file mode');
  });

  // git answers 1 both for a difference it found and for a path it could not read. Read as one, the
  // second of those was a file quietly dropped from the proposal while the hold still held it.
  it('fails with the sentence git printed for a file the run staged and then removed', async () => {
    const before = await knowledgeState(run);
    write('importer.md', 'The importer skips a row it cannot parse.\n');
    cli('add', '--', '.nolzu/knowledge/importer.md');
    rmSync(join(knowledge, 'importer.md'));

    await expect(diffs(before)).rejects.toThrow('Could not access');
  });

  // The runner stops reading past the cap and kills git, so what comes back is a cut patch. A cut
  // patch applies wrongly, so the run says the size rather than sending it.
  it('stops on a patch over the cap rather than sending a cut one', async () => {
    const before = await knowledgeState(run);
    write('generated.md', 'one more line of a note nobody wrote by hand\n'.repeat(9000));

    await expect(diffs(before)).rejects.toThrow('is over');
  });
});
