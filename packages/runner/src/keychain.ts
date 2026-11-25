import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveDataDir } from '@nolzu/core/node';
import { DEVICE_TOKEN_NAME } from './hub.ts';

// One secret per name and data folder in the OS keychain, through the tool the system already
// ships. The device token is the one exception, kept once per machine. There is no file fall back:
// a machine with no keychain gets a refusal, because a secret written to disk in plain text would be
// worse than no secret at all.

// What running one keychain command gave back. `missing` is the tool not being installed.
export type KeychainRun = (
  command: string,
  args: readonly string[],
  input: string,
) => Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }>;

export type KeychainAction = 'read' | 'write' | 'delete';

export interface KeychainCommand {
  command: string;
  args: string[];
  input: string;
  // The exit code the tool uses for "there is no such secret".
  missingCode: number;
  // True when the tool uses that code for real failures too, so only a silent run means "no secret".
  missingCodeIsShared: boolean;
}

export interface Keychain {
  // The secret, or null when this machine has none under that name.
  read(name: string): Promise<string | null>;
  write(name: string, secret: string): Promise<void>;
  // Removing a name that is not there is not an error, so logging out twice is harmless.
  remove(name: string): Promise<void>;
}

// One entry of ours per name, under one service, so a person can find them in their keychain app.
const SERVICE = 'nolzu';

// Generous for a token, and far under the 4096 byte line `security -i` reads.
const MAX_SECRET = 1024;

// A name reaches the `security -i` line, where quoting is the only thing between it and a command, and
// it reaches argv, where a leading dash reads as a flag. Restricting it beats escaping it twice.
const NAME = /^[a-z0-9][a-z0-9-]*$/;

// The command that performs one action, without running it, so every platform's argv is testable on
// any platform.
export function keychainCommand(platform: string, action: KeychainAction, name: string, secret = ''): KeychainCommand {
  if (!NAME.test(name)) throw new Error(`A keychain name holds lower case letters, digits and dashes, and starts with a letter or a digit. ${name} does not.`);
  // Printable ASCII only, and not too long. Every one of these was measured rather than guessed:
  //
  // A line break ends the answer early on every platform here, and refusing it makes the trailing
  // newline the tools add safe to strip on read. A quote or a backslash breaks out of the quoting
  // `security -i` needs below. Any byte outside printable ASCII makes macOS
  // `find-generic-password -w` print hex instead of the secret, so a correct write would read
  // back as wrong and a read would hand out hex. And `security -i` reads a line into a 4096 byte
  // buffer, then dispatches whatever spills over as its next command, so a very long secret is
  // both cut short and partly executed.
  //
  // None of this appears in a token this product issues. Refusing loudly beats storing something
  // other than what was asked for.
  if (action === 'write' && (/[^\x20-\x7e]|["\\]/.test(secret) || secret.length > MAX_SECRET)) {
    throw new Error(
      `A secret goes into the keychain as printable ASCII with no quote or backslash, at most ${MAX_SECRET} characters. This one does not.`,
    );
  }

  if (platform === 'darwin') {
    const item = ['-a', name, '-s', SERVICE];
    if (action === 'read') return { command: 'security', args: ['find-generic-password', ...item, '-w'], input: '', missingCode: 44, missingCodeIsShared: false };
    // `security -i` takes its command on stdin, so the secret is never in argv and never in the
    // process list.
    //
    // Not the `-w` prompt, which is what this used to do. macOS asks for a password with
    // `readpassphrase`, which reads `/dev/tty` whenever the process has a controlling terminal
    // and only falls back to stdin when it has none. Run from a terminal it therefore ignored
    // the pipe and took whatever the terminal gave it: `nolzu login` said the machine was signed
    // in, stored a few characters of rubbish, and every call afterwards was refused. It passed
    // every test, because a test has no terminal.
    if (action === 'write') {
      return {
        command: 'security',
        args: ['-i'],
        input: `add-generic-password -a ${name} -s ${SERVICE} -U -w "${secret}"\n`,
        missingCode: 44,
        missingCodeIsShared: false,
      };
    }
    return { command: 'security', args: ['delete-generic-password', ...item], input: '', missingCode: 44, missingCodeIsShared: false };
  }

  if (platform === 'linux') {
    const item = ['service', SERVICE, 'account', name];
    // secret-tool exits 1 both for a secret that is not there and for a keyring it could not reach,
    // and only the second one says anything.
    if (action === 'read') return { command: 'secret-tool', args: ['lookup', ...item], input: '', missingCode: 1, missingCodeIsShared: true };
    if (action === 'write') return { command: 'secret-tool', args: ['store', '--label', `Nolzu ${name}`, ...item], input: secret, missingCode: 1, missingCodeIsShared: true };
    return { command: 'secret-tool', args: ['clear', ...item], input: '', missingCode: 1, missingCodeIsShared: true };
  }

  throw new Error(`Nolzu has no keychain for ${platform}. It keeps secrets in the OS keychain and never in a file.`);
}

// Why a command failed, in the tool's own words, so a locked or broken keychain can be told apart
// from a secret that is not there.
const said = (answer: { stdout: string; stderr: string; code: number | null }): string => answer.stderr.trim() || answer.stdout.trim() || `the command exited with ${answer.code}`;

// WSL2 runs no keyring by default, so a Linux keyring that cannot be reached is most often that.
// Limit: secret-tool and a keyring the person starts. A run of scripts/measure-walls.mjs on WSL2
// shows whether that holds or another store is needed; either way a secret never goes to a file.
const WSL2_KEYRING = 'On WSL2, install gnome-keyring and libsecret-tools, and start a keyring in the session.';

const notInstalled = (command: string): string =>
  command === 'secret-tool'
    ? `secret-tool is not installed, so Nolzu cannot reach the keyring. Install libsecret-tools. ${WSL2_KEYRING} Nolzu never writes a secret to a file.`
    : `${command} is missing, so Nolzu cannot reach the keychain. Nolzu never writes a secret to a file.`;

/**
 * The account an entry has in the keychain: the name, then a short hash of the data folder.
 *
 * Every tool here overwrites an entry of the same name without asking. Without the tag a second data
 * folder on the machine (a test copy, a second copy of a workspace) replaced the first one's token,
 * and removing a source there deleted the real one. A hash and not the path, because a name holds
 * lower case letters, digits and dashes only.
 */
export const keychainAccount = (name: string, dataDir: string): string => `${name}-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`;

// The cloud keeps one device per machine and account, and a login replaces its token. A device token
// per folder would leave the first folder holding a revoked one after a second folder signs in to the
// same account, so it stays one per machine, under its bare name.
const MACHINE_WIDE = new Set([DEVICE_TOKEN_NAME]);

/**
 * The keychain of one data folder. Callers pass the plain name, such as `scout-7`, and every call
 * reaches that folder's own account.
 *
 * The default folder also reads a bare name once, moves it to its own account and removes it, so an
 * install from before the tag keeps its tokens. Any other folder never reads, writes or removes a
 * bare name, because a bare entry cannot say which folder wrote it and a test copy taking it is the
 * very bug the tag fixes. The device token is bare for every folder. Messages say the plain name,
 * which is the one the caller knows.
 */
export function createKeychain(platform: string, run: KeychainRun, dataDir: string): Keychain {
  const unreachable = (message: string) => new Error(platform === 'linux' ? `${message} ${WSL2_KEYRING}` : message);
  const call = async (action: KeychainAction, account: string, secret?: string) => {
    const plan = keychainCommand(platform, action, account, secret);
    const answer = await run(plan.command, plan.args, plan.input);
    if (answer.missing === true) throw new Error(notInstalled(plan.command));
    return { plan, answer };
  };

  const read = async (name: string, account: string): Promise<string | null> => {
    const { plan, answer } = await call('read', account);
    const absent = answer.code === plan.missingCode && (!plan.missingCodeIsShared || answer.stderr.trim() === '');
    if (absent) return null;
    if (answer.code !== 0) throw unreachable(`The keychain could not read ${name}: ${said(answer)}.`);
    // Every tool here adds at most one newline, and a secret cannot hold one.
    return answer.stdout.replace(/\n$/, '');
  };

  /**
   * Store a secret, and prove it is there.
   *
   * The read back is not belt and braces. `add-generic-password` writes the default keychain
   * while `find-generic-password` searches the whole list, so another keychain ahead of the
   * login one can answer with an older `nolzu` item, and everything afterwards would read that
   * instead. The comparison catches it, and a login is rare enough to pay for one extra call.
   *
   * What it does not catch: an item in that other keychain holding exactly this secret. Naming
   * one keychain on both sides would close it, at the cost of choosing a keychain for the
   * person, which is not this module's to decide.
   */
  const write = async (name: string, account: string, secret: string): Promise<void> => {
    const { answer } = await call('write', account, secret);
    // Not `said(answer)`: a tool that refuses a command often echoes the command back, and the
    // command here carries the secret. This message reaches a log.
    if (answer.code !== 0) throw unreachable(`The keychain could not store ${name}.`);

    const { plan, answer: back } = await call('read', account);
    const absent = back.code === plan.missingCode && (!plan.missingCodeIsShared || back.stderr.trim() === '');
    if (absent) throw new Error(`The keychain accepted ${name} and does not have it.`);
    if (back.code !== 0) throw unreachable(`The keychain could not store ${name}: ${said(back)}.`);
    // Never the secret itself, on either side of the comparison: this message reaches a log.
    if (back.stdout.replace(/\n$/, '') !== secret) {
      throw new Error(`The keychain stored something other than the secret for ${name}.`);
    }
  };

  const remove = async (name: string, account: string): Promise<void> => {
    const { plan, answer } = await call('delete', account);
    if (answer.code !== 0 && answer.code !== plan.missingCode) throw unreachable(`The keychain could not remove ${name}: ${said(answer)}.`);
  };

  const own = (name: string) => (MACHINE_WIDE.has(name) ? name : keychainAccount(name, dataDir));
  // What `resolveDataDir` gives with nothing set is the only folder that owns a bare entry.
  const isDefault = dataDir === resolveDataDir({});
  const ownsBare = (name: string) => isDefault && !MACHINE_WIDE.has(name);

  return {
    async read(name) {
      const held = await read(name, own(name));
      // Limit: the default folder with no token asks for the bare name on every read, two more
      // calls for a source with no token. A marker in settings would stop it.
      if (held !== null || !ownsBare(name)) return held;
      const old = await read(name, name);
      // A load racing this one may have moved the entry between the two reads.
      if (old === null) return read(name, own(name));
      // Write first, so a failed move leaves the old entry where it was. One window stays open, once
      // per entry: a save landing between the bare read and this write is replaced by the old token.
      await write(name, own(name), old);
      await remove(name, name);
      return old;
    },
    async write(name, secret) {
      await write(name, own(name), secret);
      // A token saved again before the first read leaves the older one under the bare name. The save
      // worked, so a keychain that will not remove that one does not fail it.
      if (ownsBare(name)) await remove(name, name).catch(() => undefined);
    },
    async remove(name) {
      await remove(name, own(name));
      if (ownsBare(name)) await remove(name, name);
    },
  };
}

/**
 * The real runner. No timeout: a locked keychain asks the person to unlock it, and that is a dialog
 * they may take a minute to answer.
 *
 * What travels on stdin is a command for `security -i`, never a password for a prompt. See
 * `keychainCommand` for why.
 */
export const runKeychain: KeychainRun = (command, args, input) =>
  new Promise((resolve) => {
    const child = execFile(command, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        missing: error !== null && error.code === 'ENOENT',
      });
    });
    // A command that ends before it reads its input fails this write with EPIPE. The exit code above
    // already says what happened, and unheard the error would end the whole app.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
