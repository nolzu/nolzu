import { resolve } from 'node:path';

// What a git command does to the disk. `read` writes nothing a link could redirect. `write` writes in
// the repository's work tree or git folders. `network` talks to a remote and writes here too (push
// moves the remote tracking refs, fetch writes FETCH_HEAD, clone makes a whole repository).
// `network-read` talks to a remote and writes nothing here.
export type GitKind = 'read' | 'write' | 'network' | 'network-read';

// The arguments after the subcommand that are not options. An option in `values` takes the next
// argument as its value, unless it is written with `=`, and everything after `--` is a word.
function words(rest: readonly string[], values: ReadonlySet<string> = new Set()): string[] {
  const found: string[] = [];
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at] ?? '';
    if (arg === '--') return [...found, ...rest.slice(at + 1)];
    if (!arg.startsWith('-') || arg === '-') found.push(arg);
    else if (values.has(arg)) at += 1;
  }
  return found;
}

// The options a read form of a command may carry: `flags` exactly as written, and `values` as
// `--name=value` or with the value as the next argument. An option in both takes a value only with `=`.
interface ReadRule {
  flags: ReadonlySet<string>;
  values: ReadonlySet<string>;
  // A count such as `-1`, as log takes it.
  numbers: boolean;
}
const rule = (flags: string, values = '', numbers = false): ReadRule => ({ flags: new Set(flags.split(' ')), values: new Set(values.split(' ')), numbers });

// The words of a read form, or null when any option is not on its rule. Only exact names pass: git
// takes an abbreviated long option (`--unset-a` for `--unset-all`), and `--output` writes a file, so
// an option the rule does not name makes the call a write.
function readWords(rest: readonly string[], read: ReadRule): string[] | null {
  const found: string[] = [];
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at] ?? '';
    if (arg === '--') return [...found, ...rest.slice(at + 1)];
    if (!arg.startsWith('-') || arg === '-') found.push(arg);
    else if (read.flags.has(arg) || (read.numbers && /^-\d+$/.test(arg))) continue;
    else {
      const eq = arg.indexOf('=');
      if (!read.values.has(eq === -1 ? arg : arg.slice(0, eq))) return null;
      if (eq === -1) at += 1;
    }
  }
  return found;
}

type Rule = (rest: readonly string[]) => GitKind;
const reads = (read: ReadRule): Rule => (rest) => (readWords(rest, read) === null ? 'write' : 'read');
const always = (kind: GitKind): Rule => () => kind;

const BRANCH = rule(
  '--show-current --list -l -a --all -r --remotes -v -vv --verbose --no-color --color --ignore-case -i --omit-empty --column --no-column',
  '--sort --format --contains --no-contains --merged --no-merged --points-at --abbrev --color --column',
);
// With one of these a name is a pattern to list by; with none, a name makes a branch.
const BRANCH_LISTS = new Set(['--list', '-l', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at']);
const branch: Rule = (rest) => {
  const said = readWords(rest, BRANCH);
  if (said === null) return 'write';
  return said.length === 0 || rest.some((arg) => BRANCH_LISTS.has(arg.split('=')[0] ?? '')) ? 'read' : 'write';
};

const CONFIG = rule(
  '--get --get-all --get-regexp --get-urlmatch --list -l --local --global --system --worktree --null -z --name-only --show-origin --show-scope --bool --int --bool-or-int --path --expiry-date --includes --no-includes --all --regexp',
  '--file -f --blob --type --default --url',
);
const CONFIG_GETS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l']);
// git reads options of a plain `config` only before its first word, and so does `config set`: every
// argument from there on is a key or a value, `--get` and `-l` included (`config a.b --get` stores
// `--get`). So the options come from before the first word, and then `--get` or `--list` there,
// `config get` and `config list`, or one key alone read. Any other shape writes. A key always holds a
// dot, so a lone word without one is a subcommand such as `edit`.
const config: Rule = (rest) => {
  let at = 0;
  while (at < rest.length && rest[at]?.startsWith('-') === true && rest[at] !== '--') at += CONFIG.values.has(rest[at] ?? '') ? 2 : 1;
  const options = rest.slice(0, at);
  const tail = rest.slice(rest[at] === '--' ? at + 1 : at);
  if (readWords(options, CONFIG) === null) return 'write';
  if (options.some((arg) => CONFIG_GETS.has(arg))) return 'read';
  if (tail[0] === 'get' || tail[0] === 'list') return readWords(tail.slice(1), CONFIG) === null ? 'write' : 'read';
  return tail.length === 1 && tail[0]?.includes('.') === true ? 'read' : 'write';
};

// `remote` and `remote -v` list, `remote get-url <name>` reads. Every other form writes the config,
// and `remote show` and `remote update` also go to the network.
const REMOTE = rule('-v --verbose --push --all');
const remote: Rule = (rest) => {
  const said = readWords(rest, REMOTE);
  if (said === null) return 'write';
  return said.length === 0 || (said[0] === 'get-url' && said.length === 2) ? 'read' : 'write';
};

// One ref reads it; a ref and a target, or a delete, write.
const SYMBOLIC_REF = rule('-q --quiet --short --no-short --recurse --no-recurse');
const symbolicRef: Rule = (rest) => (readWords(rest, SYMBOLIC_REF)?.length === 1 ? 'read' : 'write');

const WORKTREE = rule('--porcelain -z -v --verbose', '--expire');
const worktree: Rule = (rest) => {
  const said = readWords(rest, WORKTREE);
  return said?.length === 1 && said[0] === 'list' ? 'read' : 'write';
};

// `--upload-pack` names a program to run, so ls-remote with it counts as a network write.
const LS_REMOTE = rule('--tags --heads --branches --refs -t -h -b --quiet -q --exit-code --symref --get-url');
const lsRemote: Rule = (rest) => (readWords(rest, LS_REMOTE) === null ? 'network' : 'network-read');

const DIFF_FLAGS = '--no-color --no-ext-diff --no-textconv --name-only --name-status --numstat --raw --stat --patch -p -z -M --no-renames --quiet --exit-code --relative --ignore-submodules';

/** Every git subcommand Nolzu's own code runs, and what it does to the disk. */
export const GIT_COMMANDS: Readonly<Record<string, Rule>> = {
  'cat-file': reads(rule('-e -t -s -p')),
  'check-ignore': reads(rule('-q --quiet -v --verbose --no-index -z -n --non-matching')),
  describe: reads(rule('--tags --exact-match --always --long --all', '--abbrev --match --exclude')),
  diff: reads(rule(`${DIFF_FLAGS} --cached --staged --no-index`, '--diff-filter --relative --ignore-submodules --find-renames')),
  'for-each-ref': reads(rule('--shell --perl --python --tcl', '--format --sort --count --contains --no-contains --merged --no-merged --points-at --exclude')),
  log: reads(
    rule(`${DIFF_FLAGS} --all --source --no-merges --merges --first-parent --reverse --oneline --no-decorate --follow --name-only`, '--format --pretty --since --until --after --before --max-count -n --skip --diff-merges --relative --author --grep --date --abbrev --ignore-submodules', true),
  ),
  'ls-files': reads(rule('-z --stage -s --full-name --others -o --exclude-standard --error-unmatch --unmerged -u --cached -c --deleted -d --modified -m --ignored -i --directory --no-empty-directory', '--exclude')),
  'ls-tree': reads(rule('-t -z -r -d -l --long --name-only --name-status --full-name --full-tree --object-only --end-of-options', '--format --abbrev')),
  'merge-base': reads(rule('--is-ancestor --all --fork-point --octopus --independent')),
  'rev-list': reads(rule('--all --count --left-right --not --remotes --branches --tags --first-parent --no-merges --reverse --quiet', '--max-count --exclude --since --until --remotes --branches --tags', true)),
  'rev-parse': reads(
    rule(
      '--abbrev-ref --absolute-git-dir --git-common-dir --git-dir --is-bare-repository --is-inside-work-tree --is-inside-git-dir --quiet -q --short --show-prefix --show-toplevel --show-cdup --symbolic --symbolic-full-name --verify --end-of-options',
      '--path-format --git-path --short --abbrev-ref --default',
    ),
  ),
  show: reads(rule(`${DIFF_FLAGS} --no-patch -s`, '--format --pretty --relative --ignore-submodules')),
  'show-ref': reads(rule('--tags -d --dereference --heads --branches --head --verify --exists --quiet -q --hash', '--hash --abbrev')),
  // A status can refresh the index, through a lock file and a rename that replace a link and never
  // write through one; `gitEnv` turns even that off with GIT_OPTIONAL_LOCKS.
  status: reads(
    rule(
      '--porcelain --branch -b -z --null -s --short --long -u -uall -uno -unormal --ignored --no-renames --ignore-submodules --ahead-behind --no-ahead-behind',
      '--porcelain --untracked-files --ignored --ignore-submodules',
    ),
  ),
  var: reads(rule('')),
  version: reads(rule('--build-options')),
  add: always('write'),
  checkout: always('write'),
  commit: always('write'),
  init: always('write'),
  merge: always('write'),
  reset: always('write'),
  restore: always('write'),
  rm: always('write'),
  submodule: always('write'),
  'update-ref': always('write'),
  branch,
  config,
  remote,
  'symbolic-ref': symbolicRef,
  worktree,
  clone: always('network'),
  fetch: always('network'),
  pull: always('network'),
  push: always('network'),
  'ls-remote': lsRemote,
};

export interface GitCall {
  // The folder git works in: the working folder, moved by each leading `-C`.
  folder: string;
  // Each leading `-C` value, as written.
  moves: readonly string[];
  // The subcommand, or undefined when an option Nolzu never passes comes before it.
  command: string | undefined;
  rest: readonly string[];
}

/** The subcommand of a git argument list, past any leading `-C <folder>` and `-c <setting>`. */
export function gitCall(args: readonly string[], cwd: string): GitCall {
  let at = 0;
  let folder = cwd;
  const moves: string[] = [];
  while (args[at] === '-C' || args[at] === '-c') {
    if (args[at] === '-C') {
      moves.push(args[at + 1] ?? '');
      folder = resolve(folder, args[at + 1] ?? '');
    }
    at += 2;
  }
  // `git --version` is `git version`.
  const command = args[at] === '--version' ? 'version' : args[at];
  return { folder, moves, command: command === undefined || command.startsWith('-') ? undefined : command, rest: args.slice(at + 1) };
}

/**
 * What a git argument list does to the disk. A subcommand the table does not list counts as a write,
 * so a check that guards writes runs for it rather than being skipped.
 */
export function gitKind(args: readonly string[]): GitKind {
  const { command, rest } = gitCall(args, '.');
  return command !== undefined && Object.hasOwn(GIT_COMMANDS, command) ? (GIT_COMMANDS[command]?.(rest) ?? 'write') : 'write';
}

const INIT_VALUES = new Set(['-b', '--initial-branch', '--template', '--separate-git-dir', '--object-format', '--ref-format']);
const CLONE_VALUES = new Set(['-b', '--branch', '-o', '--origin', '-u', '--upload-pack', '--template', '--reference', '--reference-if-able', '--separate-git-dir', '--depth', '--shallow-since', '--shallow-exclude', '-c', '--config', '--server-option', '--filter', '--bundle-uri', '-j', '--jobs', '--ref-format']);
const WORKTREE_ADD_VALUES = new Set(['-b', '-B', '--reason']);

// The folder git names a clone after, as git does: the URL's last part, without a trailing slash,
// `/.git`, `.git` or `.bundle`, and with `.git` for a bare clone.
function cloneName(url: string, bare: boolean): string {
  const last = url.replace(/[/\\]+$/, '').replace(/[/\\]\.git$/, '').split(/[/\\:]/).at(-1) ?? '';
  const name = last.replace(/\.(git|bundle)$/, '');
  return bare ? `${name}.git` : name;
}

// The value of an option written as `--name value` or `--name=value`, or undefined.
function optionValue(rest: readonly string[], name: string): string | undefined {
  for (let at = 0; at < rest.length && rest[at] !== '--'; at += 1) {
    if (rest[at] === name) return rest[at + 1];
    if (rest[at]?.startsWith(`${name}=`) === true) return rest[at]?.slice(name.length + 1);
  }
  return undefined;
}

/**
 * The folders a command makes, as written, relative to the folder git works in: the new repository of
 * `init` and `clone` and a separate git folder either names, and the checkout of `worktree add`.
 * Empty for any other command.
 */
export function madeFolders(call: GitCall): string[] {
  const separate = optionValue(call.rest, '--separate-git-dir');
  const also = separate === undefined ? [] : [separate];
  if (call.command === 'init') return [words(call.rest, INIT_VALUES).at(-1) ?? '.', ...also];
  if (call.command === 'clone') {
    const [url = '', dir] = words(call.rest, CLONE_VALUES);
    const bare = call.rest.includes('--bare') || call.rest.includes('--mirror');
    return [dir ?? cloneName(url, bare), ...also];
  }
  if (call.command === 'worktree') {
    const [sub, path] = words(call.rest, WORKTREE_ADD_VALUES);
    return sub === 'add' && path !== undefined ? [path] : [];
  }
  return [];
}
