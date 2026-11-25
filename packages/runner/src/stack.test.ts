import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUTPUT_TAIL, runStackHook, stackAddresses, stackCommand, stackEnv, stackNotes, stackStatusAfter, type StackHook } from './stack.ts';

let dir: string;
const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), 'nolzu-stack-')));

const hook = (load: string | null, unload: string | null = null, status: string | null = null): StackHook => ({ load, unload, status });

describe('stackCommand', () => {
  // The command runs in a shell, so a key that carries a shell character never goes in.
  it('refuses a key a shell would read as more than a name', () => {
    expect(() => stackCommand('docker compose -p {key} up -d', 'APP-1;touch x')).toThrow('holds a character a shell reads');
    expect(stackCommand('docker compose -p {key} up -d', 'me/recipes#12')).toBe('docker compose -p me/recipes#12 up -d');
    expect(stackCommand('make up', 'APP-1;x')).toBe('make up');
    expect(() => stackCommand('docker compose -p {key} up', '-rf')).toThrow('holds a character a shell reads');
    expect(() => stackCommand('docker compose -p {key} up', '#12')).toThrow('holds a character a shell reads');
    // A GitHub key of a repository named with a dot or an underscore first, which no rename fixes.
    expect(stackCommand('docker compose -p {key} up', '.github#3')).toBe('docker compose -p .github#3 up');
    expect(stackCommand('docker compose -p {key} up', '_infra#9')).toBe('docker compose -p _infra#9 up');
    for (const key of ['..', '../x', 'a/../b', './x', '..#1']) expect(() => stackCommand('cd worktrees/{key}', key)).toThrow('holds a character a shell reads');
    expect(() => stackCommand('up {key}', 'APP-1;x')).toThrow(/^(?!.*Rename)/);
  });
  it('puts the card key where the template asks for it', () => {
    expect(stackCommand('docker compose -f {key}.yml up -d', 'APP-1')).toBe('docker compose -f APP-1.yml up -d');
  });

  it('fills every place the key is named', () => {
    expect(stackCommand('start {key} && tag {key}', 'APP-12')).toBe('start APP-12 && tag APP-12');
  });

  // Onboarding warns about this one rather than refusing it, so the runner has to carry it through
  // as written instead of inventing a place for the key.
  it('leaves a template that names no card as it is', () => {
    expect(stackCommand('docker compose up -d', 'APP-1')).toBe('docker compose up -d');
  });

  it('trims the template, so a stray newline does not become part of the command', () => {
    expect(stackCommand('  up {key}\n', 'APP-1')).toBe('up APP-1');
  });
});

describe('stackEnv', () => {
  it('names the card, the project and the card repositories, one per line', () => {
    expect(stackEnv('APP-1', '/projects/recipes', ['.', 'api', 'web'])).toEqual({
      NOLZU_CARD_KEY: 'APP-1',
      NOLZU_PROJECT: '/projects/recipes',
      NOLZU_REPOS: '.\napi\nweb',
    });
  });

  it('reads a single repository card as the root alone', () => {
    expect(stackEnv('APP-1', '/projects/recipes', ['.']).NOLZU_REPOS).toBe('.');
  });

  // The root checkout is the folder the others sit in, so a script that walks the list meets it first.
  it('puts the root first, whatever order it was given', () => {
    expect(stackEnv('APP-1', '/p', ['api', '.', 'web']).NOLZU_REPOS).toBe('.\napi\nweb');
  });

  it('gives an empty list for a card with no repositories known', () => {
    expect(stackEnv('APP-1', '/p', []).NOLZU_REPOS).toBe('');
  });

  it('names the card it was given, not a fixed one', () => {
    expect(stackEnv('APP-2', '/p', ['.']).NOLZU_CARD_KEY).toBe('APP-2');
  });
});

describe('stackAddresses', () => {
  it('keeps name and address lines and drops the rest', () => {
    const stdout = [
      ' Container recipes-db-1  Started',
      '[+] Running 3/3',
      'web https://web.example.test',
      'api   http://localhost:8787/health',
      'web web.example.test',
      'web https://web.example.test extra',
      '',
    ].join('\n');

    expect(stackAddresses(stdout)).toEqual(['web https://web.example.test', 'api   http://localhost:8787/health']);
  });

  it('reads lines that end in a carriage return', () => {
    expect(stackAddresses('web https://web.example.test\r\n')).toEqual(['web https://web.example.test']);
  });

  it('drops the first line of a full tail, which the cut can leave as a wrong name', () => {
    const last = '\nweb https://web.example.test';
    const stdout = `eb http://localhost:8080\n${'x'.repeat(OUTPUT_TAIL - 25 - last.length)}${last}`;

    expect(stdout).toHaveLength(OUTPUT_TAIL);
    expect(stackAddresses(stdout)).toEqual(['web https://web.example.test']);
  });

  it('answers an empty list for output with no addresses', () => {
    expect(stackAddresses('done\n')).toEqual([]);
    expect(stackAddresses('')).toEqual([]);
  });
});

describe('stackNotes', () => {
  it('keeps what a load printed besides its addresses, without blank lines', () => {
    const output = [' Container recipes-db-1  Started', '', 'web is built into its image, so it still runs the old code.\r', 'web https://web.example.test', 'api http://localhost:8787', ''].join('\n');

    expect(stackNotes(output)).toBe(' Container recipes-db-1  Started\nweb is built into its image, so it still runs the old code.');
  });

  it('answers nothing for a load that printed only its addresses', () => {
    expect(stackNotes('web https://web.example.test\n')).toBe('');
    expect(stackNotes('')).toBe('');
  });
});

describe('runStackHook', () => {
  it('runs the load command in the card checkout and reports it finished', async () => {
    const cwd = fresh();

    const result = await runStackHook(hook(`echo loaded {key} > out.txt`), 'load', 'APP-1', { cwd });

    // The effect, not the call: the file the command wrote is in the checkout.
    expect(result?.code).toBe(0);
    expect(readFileSync(join(cwd, 'out.txt'), 'utf8').trim()).toBe('loaded APP-1');
  });

  // The pitfall this module exists for. docker compose resolves a relative path in a compose file
  // against PWD, not against the working directory, so a PWD left over from the parent process
  // loads somebody else's folder. Proved by reading what the child itself saw.
  it('sets PWD to the checkout, not whatever the parent had', async () => {
    const cwd = fresh();

    const result = await runStackHook(hook('printf %s "$PWD"'), 'load', 'APP-1', {
      cwd,
      env: { PATH: process.env.PATH, PWD: '/somewhere/else' },
    });

    expect(result?.stdout).toBe(cwd);
  });

  it('hands the hook the card key and its repositories', async () => {
    const cwd = fresh();

    const result = await runStackHook(hook(`printf '%s|%s' "$NOLZU_CARD_KEY" "$NOLZU_REPOS"`), 'load', 'APP-1', {
      cwd,
      env: { PATH: process.env.PATH, ...stackEnv('APP-1', cwd, ['.', 'api']) },
    });

    expect(result?.stdout).toBe('APP-1|.\napi');
  });

  // The variables are added to the environment and nothing else, so a template written for one
  // repository runs as it did before.
  it('runs a template with only the key as the same command in the same folder', async () => {
    const cwd = fresh();

    const result = await runStackHook(hook('echo {key} > out.txt; printf %s "$PWD"'), 'load', 'APP-1', {
      cwd,
      env: { PATH: process.env.PATH, ...stackEnv('APP-1', '/elsewhere', ['.']) },
    });

    expect(result?.command).toBe('echo APP-1 > out.txt; printf %s "$PWD"');
    expect(result?.stdout).toBe(cwd);
    expect(readFileSync(join(cwd, 'out.txt'), 'utf8').trim()).toBe('APP-1');
  });

  // Both sides of the same branch, because a project that can load and not unload leaves a stack
  // running after every QA run.
  it('runs the unload command, and answers null for a side with no command', async () => {
    const cwd = fresh();

    const unloaded = await runStackHook(hook('true', `echo gone > gone.txt`), 'unload', 'APP-1', { cwd });
    const missing = await runStackHook(hook('true', null), 'unload', 'APP-1', { cwd });

    expect(unloaded?.code).toBe(0);
    expect(readFileSync(join(cwd, 'gone.txt'), 'utf8').trim()).toBe('gone');
    expect(missing).toBeNull();
  });

  it('answers null for a project with no hook at all, rather than running a shell', async () => {
    expect(await runStackHook(hook(null), 'load', 'APP-1', { cwd: fresh() })).toBeNull();
    // A template of spaces is the same as none. A person who cleared the field left it blank.
    expect(await runStackHook(hook('   '), 'load', 'APP-1', { cwd: fresh() })).toBeNull();
  });

  it('hands back the exit code and the output of a command that failed', async () => {
    const result = await runStackHook(hook('echo "no compose file" >&2; exit 3'), 'load', 'APP-1', { cwd: fresh() });

    expect(result?.code).toBe(3);
    expect(result?.stderr.trim()).toBe('no compose file');
    expect(result?.timedOut).toBe(false);
  });

  // `sleep 30; true` and not `sleep 30`, because a shell given one simple command execs it in
  // place and the shell is then the only process. Two commands force it to fork, which is the
  // shape a real `docker compose up ... && echo ready` has, and the shape that hung on CI: killing
  // the shell alone left sleep holding the pipes and the close event never arrived.
  it('kills a command that outlives the timeout, including what the shell started', async () => {
    const started = Date.now();

    const result = await runStackHook(hook('sleep 30; true'), 'load', 'APP-1', { cwd: fresh(), timeoutMs: 150 });

    expect(result?.timedOut).toBe(true);
    // What the card says, and not the exit code. The kill reaches the shell's whole group, but a
    // shell whose child died can still run the next command in the line and exit 0, which happened
    // once under a full-suite load. `timedOut` is what the card reads, so that is what is pinned: a
    // stack that never came up must never read as one that is up.
    expect(stackStatusAfter('load', result)).toEqual({
      state: 'failed',
      reason: 'The start command was still running after the timeout, so it was stopped.',
    });
    // It came back on the timeout and not on the sleep, which is the whole point.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('kills a whole tree the command started', async () => {
    const started = Date.now();

    const result = await runStackHook(hook('sh -c "sleep 30" & wait'), 'load', 'APP-1', {
      cwd: fresh(),
      timeoutMs: 150,
    });

    expect(result?.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('stops when the run is aborted', async () => {
    const controller = new AbortController();
    const running = runStackHook(hook('sleep 30'), 'load', 'APP-1', { cwd: fresh(), signal: controller.signal });
    controller.abort();

    const result = await running.catch(() => 'threw');
    expect(result === 'threw' || (typeof result === 'object' && result !== null && result.code !== 0)).toBe(true);
  });

  it('refuses before spawning when the signal is already aborted', async () => {
    await expect(
      runStackHook(hook('echo hi'), 'load', 'APP-1', { cwd: fresh(), signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });

  // The third action. Its output goes on the ticket page as the project's own words, so what
  // matters is that the command ran in the checkout and that every line came back.
  it('runs the status command in the checkout and hands back everything it printed', async () => {
    const cwd = fresh();
    const script = join(cwd, 'status.sh');
    writeFileSync(script, 'echo "api  running"\necho "db   exited (1)" >&2\nprintf %s "$PWD" > seen.txt\n');

    const result = await runStackHook(hook(null, null, `sh ${script}`), 'status', 'APP-1', {
      cwd,
      env: { PATH: process.env.PATH, PWD: '/somewhere/else' },
    });

    expect(result?.code).toBe(0);
    expect(result?.stdout.trim()).toBe('api  running');
    expect(result?.stderr.trim()).toBe('db   exited (1)');
    // The command ran where the card's code is, which is the only folder its answer can be about.
    expect(readFileSync(join(cwd, 'seen.txt'), 'utf8')).toBe(cwd);
  });

  // The panel says "not reported" for this one, and nothing is run to find that out.
  it('answers null for a project with no status command, rather than running a shell', async () => {
    expect(await runStackHook(hook('up', 'down', null), 'status', 'APP-1', { cwd: fresh() })).toBeNull();
  });

  it('keeps the end of a command that prints more than the tail', async () => {
    const script = join(fresh(), 'noisy.sh');
    writeFileSync(script, 'for i in $(seq 1 3000); do echo "line $i"; done\n');

    const result = await runStackHook(hook(`sh ${script}`), 'load', 'APP-1', { cwd: dir });

    expect(result?.stdout.length).toBeLessThanOrEqual(OUTPUT_TAIL);
    expect(result?.stdout.trimEnd().endsWith('line 3000')).toBe(true);
  });
});

describe('stackStatusAfter', () => {
  const ran = (code: number, timedOut = false, stderr = '') => ({ command: 'up', code, stdout: '', stderr, timedOut });

  it('reads a project with no hook as off, not as failed', () => {
    expect(stackStatusAfter('load', null)).toEqual({ state: 'off', reason: null });
  });

  it('reads a finished load as up and a finished unload as off', () => {
    expect(stackStatusAfter('load', ran(0))).toEqual({ state: 'up', reason: null });
    // Off with a sentence, so the card can tell a stack that went down from a project that
    // never had one. Both are off, and the panel reads the two apart by the reason.
    expect(stackStatusAfter('unload', ran(0))).toEqual({ state: 'off', reason: 'The app was stopped after the run.' });
  });

  it('names the exit code and the last line a failed command printed', () => {
    const status = stackStatusAfter('load', ran(3, false, 'could not find APP-1.yml'));

    expect(status.state).toBe('failed');
    expect(status.reason).toContain('exited 3');
    expect(status.reason).toContain('could not find APP-1.yml');
  });

  // A timeout has its own sentence, because an exit code tells nobody the stack was still coming
  // up when the clock ran out.
  it('says a timeout was a timeout, not an exit code', () => {
    const status = stackStatusAfter('load', ran(128, true));

    expect(status.state).toBe('failed');
    expect(status.reason).toMatch(/still running after the timeout/);
    expect(status.reason).not.toMatch(/exited/);
  });

  // The case a full-suite load produced once, and the reason `timedOut` is read before the code: the
  // kill reached the shell's child, the shell ran the next command in the line and exited 0. The
  // stack never came up, and a status built from the code alone would have called it up.
  it('reads a timeout that exited zero as a stack that never came up', () => {
    expect(stackStatusAfter('load', ran(0, true))).toEqual({
      state: 'failed',
      reason: 'The start command was still running after the timeout, so it was stopped.',
    });
  });

  // The QA run is over by the time the unload runs, so a failure there is not the run's failure.
  // What is left to say is that the stack is still running and somebody has to take it down.
  it('reads a failed unload as a stack that is still up, with what the command said', () => {
    const status = stackStatusAfter('unload', ran(1, false, 'no such container'));

    expect(status.state).toBe('up');
    expect(status.reason).toContain('exited 1');
    expect(status.reason).toContain('no such container');
    expect(status.reason).toContain('still up');
  });

  it('reads an unload that timed out as a stack that is still up', () => {
    const status = stackStatusAfter('unload', ran(128, true));

    expect(status.state).toBe('up');
    expect(status.reason).toMatch(/still running after the timeout/);
    expect(status.reason).toContain('still up');
  });
});

it('cleans up its temp folders', () => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Own commands go without Nolzu's address and the GitHub and npm tokens, as the app QA starts does.
it('runs a command with no tokens, ORIGIN or HOST from the caller', async () => {
  const env = { ...process.env, GH_TOKEN: 'x', NPM_TOKEN: 'x', ORIGIN: 'http://127.0.0.1:4319', HOST: '127.0.0.1', KEPT: 'yes' };
  const result = await runStackHook({ load: null, unload: null, status: 'printf "%s|%s|%s|%s|%s" "$GH_TOKEN" "$NPM_TOKEN" "$ORIGIN" "$HOST" "$KEPT"' }, 'status', 'APP-1', { cwd: tmpdir(), env });

  expect(result?.stdout).toBe('||||yes');
});
