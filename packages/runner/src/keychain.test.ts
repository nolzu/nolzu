import { resolveDataDir } from '@nolzu/core/node';
import { describe, expect, it } from 'vitest';
import { DEVICE_TOKEN_NAME } from './hub.ts';
import { createKeychain, keychainAccount, type KeychainRun, keychainCommand, runKeychain } from './keychain.ts';

// Not the default data folder, so these tests make no call on a name from before the folder tag.
const FOLDER = '/data/one';

// A stub for one call, so no test touches the real keychain of the machine it runs on.
const answers = (answer: Partial<Awaited<ReturnType<KeychainRun>>>) => {
  const calls: { command: string; args: readonly string[]; input: string }[] = [];
  const run: KeychainRun = async (command, args, input) => {
    calls.push({ command, args, input });
    return { code: 0, stdout: '', stderr: '', ...answer };
  };
  return { calls, run };
};

describe('keychainCommand on macOS', () => {
  it('reads with find-generic-password, which prints the secret', () => {
    expect(keychainCommand('darwin', 'read', 'device-token')).toMatchObject({
      command: 'security',
      args: ['find-generic-password', '-a', 'device-token', '-s', 'nolzu', '-w'],
      input: '',
      missingCode: 44,
    });
  });

  // The secret on argv would sit in the process list for as long as the command runs.
  it('writes through the interactive command, so the secret is never on argv', () => {
    const plan = keychainCommand('darwin', 'write', 'device-token', 'abc123');

    // Never the `-w` prompt. `security` asks for a password with `readpassphrase`, which reads
    // /dev/tty whenever the process has a controlling terminal and only falls back to stdin when
    // it has none. From a terminal it ignored the pipe and stored what the terminal gave it.
    expect(plan.args).toEqual(['-i']);
    expect(plan.args).not.toContain('abc123');
    expect(plan.input).toBe('add-generic-password -a device-token -s nolzu -U -w "abc123"\n');
  });

  it('updates an entry that is already there instead of failing on it', () => {
    expect(keychainCommand('darwin', 'write', 'device-token', 'abc123').input).toContain(' -U ');
  });

  // Every one of these was measured against the real tool, not guessed.
  it('refuses a secret the keychain would not give back unchanged', () => {
    const bad = {
      'a quote, which closes the quoting early': 'a"b',
      'a backslash, for the same reason': 'a\\b',
      'a line break, which ends the command': 'a\nb',
      // find-generic-password prints hex instead of the secret for any of these, so a correct
      // write would read back as wrong and a read would hand out hex.
      'a tab': 'a\tb',
      'a control character': 'a\u0001b',
      'a character outside ASCII': 'aéb',
      // security -i reads a line into a 4096 byte buffer and runs the overflow as its next
      // command, so a long secret is cut short and partly executed.
      'a secret too long for the line the tool reads': 'a'.repeat(5000),
    };

    for (const [why, secret] of Object.entries(bad)) {
      expect(() => keychainCommand('darwin', 'write', 'device-token', secret), why).toThrow(
        /printable ASCII/,
      );
    }
  });

  it('takes everything a token is made of', () => {
    // base64url, and the punctuation a Jira or GitHub token can carry.
    for (const fine of ['aB3-_x', 'a$b`c;d#e!f%g', "a'b", '-leading-dash', 'a'.repeat(1024)]) {
      expect(() => keychainCommand('darwin', 'write', 'device-token', fine)).not.toThrow();
    }
  });

  it('deletes with delete-generic-password', () => {
    expect(keychainCommand('darwin', 'delete', 'device-token').args).toEqual(['delete-generic-password', '-a', 'device-token', '-s', 'nolzu']);
  });
});

describe('keychainCommand on Linux', () => {
  it('reads with secret-tool lookup on the service and the name', () => {
    expect(keychainCommand('linux', 'read', 'device-token')).toMatchObject({
      command: 'secret-tool',
      args: ['lookup', 'service', 'nolzu', 'account', 'device-token'],
      input: '',
    });
  });

  it('writes the secret over stdin, with a label a person can recognise', () => {
    const plan = keychainCommand('linux', 'write', 'device-token', 'abc123');

    expect(plan.args).toEqual(['store', '--label', 'Nolzu device-token', 'service', 'nolzu', 'account', 'device-token']);
    expect(plan.input).toBe('abc123');
  });

  it('deletes with secret-tool clear', () => {
    expect(keychainCommand('linux', 'delete', 'device-token').args).toEqual(['clear', 'service', 'nolzu', 'account', 'device-token']);
  });

  // secret-tool exits 1 for a secret that is not there and for a keyring it could not reach.
  it('says its exit code for a missing secret is shared with real failures', () => {
    expect(keychainCommand('linux', 'read', 'device-token')).toMatchObject({ missingCode: 1, missingCodeIsShared: true });
  });
});

describe('keychainCommand refusals', () => {
  // A silent file would be the wrong answer: a token in plain text on disk is worse than no token.
  it('refuses a platform it has no keychain for, and says why there is no file instead', () => {
    expect(() => keychainCommand('sunos', 'read', 'device-token')).toThrow(/sunos.*never in a file/s);
  });

  // Native Windows is not supported: Nolzu stops at start there, so it has no vault to reach.
  it('has no keychain on native Windows', () => {
    expect(() => keychainCommand('win32', 'read', 'device-token')).toThrow(/no keychain for win32/);
  });

  // The name reaches argv and the `security -i` line, so a quote or a leading dash would change the command.
  it.each(["a'; rm -rf /; #", 'Device-Token', '-w', 'token name', ''])('refuses %j as a name', (name) => {
    expect(() => keychainCommand('darwin', 'read', name)).toThrow(/keychain name/);
  });

  // A line break would end the command without saying so.
  it('refuses a secret with a line break in it', () => {
    expect(() => keychainCommand('darwin', 'write', 'device-token', 'abc\n123')).toThrow(/printable ASCII/);
  });
});

describe('createKeychain', () => {
  it('gives back the secret the tool printed, without its trailing newline', async () => {
    const { run } = answers({ stdout: 'abc123\n' });

    await expect(createKeychain('darwin', run, FOLDER).read('device-token')).resolves.toBe('abc123');
  });

  it('gives back null when there is no secret under that name', async () => {
    const { run } = answers({ code: 44, stderr: 'security: The specified item could not be found in the keychain.' });

    await expect(createKeychain('darwin', run, FOLDER).read('device-token')).resolves.toBeNull();
  });

  // The whole point of the shared exit code: a keyring that is not running must not read as "no token".
  it('refuses a Linux failure that shares the exit code of a missing secret', async () => {
    const { run } = answers({ code: 1, stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY' });

    await expect(createKeychain('linux', run, FOLDER).read('device-token')).rejects.toThrow(/D-Bus/);
  });

  // WSL2 runs no keyring by default. The refusal names the fix, and nothing falls back to a file.
  it('names the WSL2 keyring fix when the Linux keyring cannot be reached', async () => {
    const { calls, run } = answers({ code: 1, stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY' });
    const keychain = createKeychain('linux', run, FOLDER);

    await expect(keychain.read('device-token')).rejects.toThrow(/On WSL2, install gnome-keyring and libsecret-tools, and start a keyring in the session/);
    await expect(keychain.write('device-token', 'abc123')).rejects.toThrow(/gnome-keyring/);
    expect(calls.every((call) => call.command === 'secret-tool')).toBe(true);
  });

  it('gives back null on Linux when the same code comes with nothing said', async () => {
    const { run } = answers({ code: 1 });

    await expect(createKeychain('linux', run, FOLDER).read('device-token')).resolves.toBeNull();
  });

  it('names the tool and the problem when reading fails for another reason', async () => {
    const { run } = answers({ code: 51, stderr: 'security: SecKeychainUnlock: User interaction is not allowed.' });

    await expect(createKeychain('darwin', run, FOLDER).read('device-token')).rejects.toThrow(/could not read device-token.*User interaction/s);
  });

  it('says the command exited when the tool failed and printed nothing', async () => {
    const { run } = answers({ code: 2 });

    await expect(createKeychain('darwin', run, FOLDER).read('device-token')).rejects.toThrow(/exited with 2/);
  });

  it('passes the secret to the tool on write, then reads it back', async () => {
    // The read back is what makes a write mean anything: `security -i` exits 0 whether the
    // command inside it worked or not.
    const { calls, run } = answers({ stdout: 'abc123\n' });

    await createKeychain('linux', run, FOLDER).write('device-token', 'abc123');

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ command: 'secret-tool', input: 'abc123' });
    expect(calls[1]?.args).toContain('lookup');
  });

  it('refuses a write the keychain took and did not keep', async () => {
    // The failure this exists for: the tool answers 0 and the secret is not what was asked for,
    // which is what a terminal-stolen password looked like.
    const { run } = answers({ stdout: 'something-else\n' });

    await expect(createKeychain('darwin', run, FOLDER).write('device-token', 'abc123')).rejects.toThrow(
      /stored something other than the secret/,
    );
  });

  it('refuses a write the keychain took and has nothing for', async () => {
    // The write answers 0 and the read back finds nothing, which is exactly what `security -i`
    // does with a command that failed inside it.
    let call = 0;
    const run = async () =>
      (call += 1) === 1
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 44, stdout: '', stderr: '' };

    await expect(createKeychain('darwin', run, FOLDER).write('device-token', 'abc123')).rejects.toThrow(
      /accepted device-token and does not have it/,
    );
  });

  it('never puts the secret in the message when the read back disagrees', async () => {
    const { run } = answers({ stdout: 'something-else\n' });

    const failure = await createKeychain('darwin', run, FOLDER)
      .write('device-token', 'abc123')
      .catch((error: Error) => error.message);

    expect(failure).not.toContain('abc123');
    expect(failure).not.toContain('something-else');
  });

  it('never puts the secret in the message when the tool refuses the write', async () => {
    // A tool that refuses a command often echoes it back, and on macOS that command carries the
    // secret. This message goes to a log.
    const { run } = answers({ code: 1, stderr: 'security: unknown command "abc123"' });

    const failure = await createKeychain('darwin', run, FOLDER)
      .write('device-token', 'abc123')
      .catch((error: Error) => error.message);

    expect(failure).toContain('could not store device-token');
    expect(failure).not.toContain('abc123');
  });

  it('refuses a write the tool rejected instead of reporting a secret that was never stored', async () => {
    const { run } = answers({ code: 1, stderr: 'secret-tool: no such collection' });

    await expect(createKeychain('linux', run, FOLDER).write('device-token', 'abc123')).rejects.toThrow(/could not store device-token/);
  });

  // Logging out twice, or logging out on a machine that never logged in.
  it('removes a name that is not there without complaining', async () => {
    const { run } = answers({ code: 44, stderr: 'security: The specified item could not be found in the keychain.' });

    await expect(createKeychain('darwin', run, FOLDER).remove('device-token')).resolves.toBeUndefined();
  });

  it('refuses a remove that failed for a real reason', async () => {
    const { run } = answers({ code: 51, stderr: 'security: User interaction is not allowed.' });

    await expect(createKeychain('darwin', run, FOLDER).remove('device-token')).rejects.toThrow(/could not remove device-token/);
  });

  // Without this the person is told there is no token, and no install step is ever named.
  it('names the package to install when the Linux tool is missing', async () => {
    const { run } = answers({ code: null, missing: true });

    await expect(createKeychain('linux', run, FOLDER).read('device-token')).rejects.toThrow(/secret-tool is not installed.*libsecret.*On WSL2, install gnome-keyring/s);
  });

  it('names the tool when it is missing on macOS', async () => {
    const { run } = answers({ code: null, missing: true });

    await expect(createKeychain('darwin', run, FOLDER).read('device-token')).rejects.toThrow(/security is missing.*never writes a secret to a file/s);
  });
});

// One keychain for the whole machine, the way a real one is shared by every data folder on it. Linux,
// because `secret-tool` names the account in argv and takes the secret on stdin, so a Map can play it.
// `refused` holds calls such as `store scout-7` the keychain fails, and `before` runs ahead of each call,
// so a test can play a second load acting in between.
const machine = ({ refused = [], before }: { refused?: string[]; before?: (call: string, entries: Map<string, string>) => void } = {}) => {
  const entries = new Map<string, string>();
  const calls: string[] = [];
  const run: KeychainRun = async (_command, args, input) => {
    const account = args[args.indexOf('account') + 1] ?? '';
    const call = `${args[0]} ${account}`;
    calls.push(call);
    before?.(call, entries);
    if (refused.includes(call)) return { code: 51, stdout: '', stderr: 'The keychain is locked.' };
    if (args[0] === 'store') entries.set(account, input);
    if (args[0] === 'clear') entries.delete(account);
    if (args[0] === 'lookup') {
      const held = entries.get(account);
      return held === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: held, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { entries, calls, run };
};

describe('keychain names per data folder', () => {
  const other = '/data/two';
  // The default folder, which the test setup puts under a temp HOME.
  const home = () => resolveDataDir({});

  it('tags a name with a short hash of the folder, the same every time', () => {
    expect(keychainAccount('scout-7', FOLDER)).toMatch(/^scout-7-[0-9a-f]{12}$/);
    expect(keychainAccount('scout-7', FOLDER)).toBe(keychainAccount('scout-7', FOLDER));
    expect(keychainAccount('scout-7', other)).not.toBe(keychainAccount('scout-7', FOLDER));
  });

  // The bug: a test copy saved a source with the same id and replaced the real token.
  it.each(['scout-7', 'export-toggl'])('keeps one %s per folder on one keychain', async (name) => {
    const { entries, run } = machine();
    const one = createKeychain('linux', run, FOLDER);
    const two = createKeychain('linux', run, other);

    await one.write(name, 'token-one');
    await two.write(name, 'token-two');

    await expect(one.read(name)).resolves.toBe('token-one');
    await expect(two.read(name)).resolves.toBe('token-two');
    expect(entries.size).toBe(2);
  });

  it.each(['scout-7', 'export-toggl'])('removes %s in one folder and leaves the other', async (name) => {
    const { run } = machine();
    const one = createKeychain('linux', run, FOLDER);
    const two = createKeychain('linux', run, other);
    await one.write(name, 'token-one');
    await two.write(name, 'token-two');

    await one.remove(name);

    await expect(one.read(name)).resolves.toBeNull();
    await expect(two.read(name)).resolves.toBe('token-two');
  });

  // An install from before the tag keeps its tokens. The default folder is the only one that owns
  // them, so it moves the entry to its own name on the first read, and the old name is gone.
  it.each(['scout-7', 'export-toggl'])('moves an old %s to the default folder name on the first read', async (name) => {
    const { entries, calls, run } = machine();
    entries.set(name, 'old-token');
    const keychain = createKeychain('linux', run, home());

    await expect(keychain.read(name)).resolves.toBe('old-token');

    expect(entries.get(keychainAccount(name, home()))).toBe('old-token');
    expect(entries.has(name)).toBe(false);

    calls.length = 0;
    await expect(keychain.read(name)).resolves.toBe('old-token');
    expect(calls).toEqual([`lookup ${keychainAccount(name, home())}`]);
  });

  // A load racing this one moved the entry between its two reads.
  it('finds an old entry another load moved a moment before', async () => {
    const own = keychainAccount('scout-7', home());
    const { entries, run } = machine({
      before: (call, held) => {
        if (call !== 'lookup scout-7' || !held.has('scout-7')) return;
        held.set(own, held.get('scout-7') ?? '');
        held.delete('scout-7');
      },
    });
    entries.set('scout-7', 'old-token');

    await expect(createKeychain('linux', run, home()).read('scout-7')).resolves.toBe('old-token');
  });

  // A move that cannot write the new name must not lose the only copy of the token.
  it('keeps the old entry when the default folder cannot store it under the new name', async () => {
    const { entries, run } = machine({ refused: [`store ${keychainAccount('scout-7', home())}`] });
    entries.set('scout-7', 'old-token');

    await expect(createKeychain('linux', run, home()).read('scout-7')).rejects.toThrow(/could not store scout-7/);
    expect(entries.get('scout-7')).toBe('old-token');
  });

  it('gives back null in the default folder when neither name has a token', async () => {
    const { entries, run } = machine();

    await expect(createKeychain('linux', run, home()).read('scout-7')).resolves.toBeNull();
    expect(entries.size).toBe(0);
  });

  // A bare entry cannot say which folder wrote it. Another folder taking it is the bug again.
  it('never reads, writes or removes an old entry from another folder', async () => {
    const { entries, calls, run } = machine();
    entries.set('scout-7', 'real-token');
    const keychain = createKeychain('linux', run, FOLDER);

    await expect(keychain.read('scout-7')).resolves.toBeNull();
    await keychain.write('scout-7', 'test-token');
    await keychain.remove('scout-7');

    expect(entries.get('scout-7')).toBe('real-token');
    expect(calls.filter((call) => call.endsWith(' scout-7'))).toEqual([]);
  });

  it('never touches the default folder entry from another folder', async () => {
    const { entries, run } = machine();
    await createKeychain('linux', run, home()).write('scout-7', 'real-token');
    const keychain = createKeychain('linux', run, FOLDER);

    await keychain.write('scout-7', 'test-token');
    await keychain.remove('scout-7');

    await expect(createKeychain('linux', run, home()).read('scout-7')).resolves.toBe('real-token');
    expect(entries.size).toBe(1);
  });

  // Otherwise a source removed before its token was ever read would leave the old entry behind.
  it('removes the old entry with the own one in the default folder', async () => {
    const { entries, run } = machine();
    entries.set('scout-7', 'old-token');

    await createKeychain('linux', run, home()).remove('scout-7');

    expect(entries.size).toBe(0);
  });

  // A token saved again before any read must not leave the older token under the old name.
  it('clears the old entry when the default folder writes the name again', async () => {
    const { entries, run } = machine();
    entries.set('export-toggl', 'old-token');

    await createKeychain('linux', run, home()).write('export-toggl', 'new-token');

    expect([...entries]).toEqual([[keychainAccount('export-toggl', home()), 'new-token']]);
  });

  it('saves in the default folder when the old entry will not go', async () => {
    const { entries, run } = machine({ refused: ['clear export-toggl'] });
    entries.set('export-toggl', 'old-token');

    await createKeychain('linux', run, home()).write('export-toggl', 'new-token');

    expect(entries.get(keychainAccount('export-toggl', home()))).toBe('new-token');
  });

  // The cloud keeps one device per machine and account. Two folders signed in to one account share
  // the token the last login stored, as they did before the tag.
  it('keeps one device token for the whole machine', async () => {
    const { entries, run } = machine();
    entries.set(DEVICE_TOKEN_NAME, 'old-token');
    const one = createKeychain('linux', run, home());
    const two = createKeychain('linux', run, other);

    await expect(one.read(DEVICE_TOKEN_NAME)).resolves.toBe('old-token');
    await two.write(DEVICE_TOKEN_NAME, 'new-token');

    await expect(one.read(DEVICE_TOKEN_NAME)).resolves.toBe('new-token');
    expect([...entries]).toEqual([[DEVICE_TOKEN_NAME, 'new-token']]);
  });
});

describe('runKeychain', () => {
  // `true` reads nothing and exits at once, so a megabyte on its stdin fails with EPIPE. With no
  // listener that error is uncaught and ends the whole app, not only this call.
  it('answers with the exit code when the command ends before it reads its input', async () => {
    const answer = await runKeychain('true', [], 'x'.repeat(1 << 20));
    expect(answer.code).toBe(0);
  });
});
