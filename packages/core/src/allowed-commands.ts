/**
 * The shell commands a project lets the agent run.
 *
 * Claude Code runs with `--permission-mode acceptEdits`, which refuses every shell command in a
 * background run, because nobody is there to approve one. Each command here reaches the engine as
 * one `Bash(<command>)` entry of `--allowedTools`. An empty list allows no command, as before.
 */

// Most specific first: a project that moved from npm to pnpm can still hold an old
// package-lock.json next to the new lockfile.
const LOCKFILES: readonly [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

// The lockfile at a repository's top and the tool it names, or undefined when there is none.
export const lockfileOf = (files: readonly string[]): readonly [string, string] | undefined => LOCKFILES.find(([file]) => files.includes(file));

// How a package manager runs one `package.json` script, the same text in the list and the run recipe,
// because the engine matches an allowed command by its text. `bun test` starts bun's own test runner
// and never the script.
export const scriptCommand = (manager: string, script: string): string => (script === 'test' && manager !== 'bun' ? `${manager} test` : `${manager} run ${script}`);

/**
 * One stack the files at a repository's top give away, and the commands it offers.
 *
 * `when` lists the files, any one of which is enough. A name with a `/` is looked up below the top,
 * and `*.sln` matches by ending. `also` is a file that must be there too. Of the rows that share a
 * `group`, only the first that matches counts, so a uv project is not offered pip as well. `{run}` is
 * how the Python row runs a tool, such as `uv run `, so ruff and Django use the same runner.
 *
 * The same table gives the allowed commands and the run recipe, so the two cannot drift. Each command
 * carries the recipe step it fills. A Start command goes only into the recipe, because a server that
 * never stops has no place in a background run. The rest are only install or sync, test, lint or
 * format check, and build: never a wildcard, and never a database, migration, cache, deploy or
 * publish command.
 */
export type StackStep = 'Install' | 'Test' | 'Lint' | 'Build' | 'Start';

interface Stack {
  when: readonly string[];
  also?: string;
  group?: string;
  run?: string;
  commands: readonly (readonly [StackStep, string])[];
}

const STACKS: readonly Stack[] = [
  { when: ['deno.json', 'deno.jsonc'], commands: [['Test', 'deno test'], ['Lint', 'deno lint'], ['Lint', 'deno fmt --check']] },
  { when: ['uv.lock'], group: 'python', run: 'uv run ', commands: [['Install', 'uv sync'], ['Test', 'uv run pytest']] },
  { when: ['poetry.lock'], group: 'python', run: 'poetry run ', commands: [['Install', 'poetry install'], ['Test', 'poetry run pytest']] },
  { when: ['requirements.txt'], group: 'python', run: '', commands: [['Install', 'pip install -r requirements.txt'], ['Test', 'python -m pytest']] },
  { when: ['pyproject.toml', 'setup.py'], group: 'python', run: '', commands: [['Install', 'pip install -e .'], ['Test', 'python -m pytest']] },
  { when: ['ruff.toml', '.ruff.toml'], commands: [['Lint', '{run}ruff check'], ['Lint', '{run}ruff format --check']] },
  { when: ['manage.py'], commands: [['Test', '{run}python manage.py test'], ['Start', '{run}python manage.py runserver']] },
  { when: ['Cargo.toml'], commands: [['Build', 'cargo build'], ['Test', 'cargo test'], ['Lint', 'cargo clippy'], ['Lint', 'cargo fmt --check'], ['Start', 'cargo run']] },
  { when: ['go.mod'], commands: [['Install', 'go mod download'], ['Build', 'go build ./...'], ['Test', 'go test ./...'], ['Lint', 'go vet ./...'], ['Start', 'go run .']] },
  { when: ['.golangci.yml', '.golangci.yaml'], commands: [['Lint', 'golangci-lint run']] },
  { when: ['gradlew'], group: 'gradle', commands: [['Build', './gradlew build'], ['Test', './gradlew test']] },
  { when: ['build.gradle', 'build.gradle.kts'], group: 'gradle', commands: [['Build', 'gradle build'], ['Test', 'gradle test']] },
  { when: ['mvnw'], group: 'maven', commands: [['Test', './mvnw test'], ['Build', './mvnw package']] },
  { when: ['pom.xml'], group: 'maven', commands: [['Test', 'mvn test'], ['Build', 'mvn package']] },
  {
    when: ['*.sln', '*.csproj', '*.fsproj'],
    commands: [['Install', 'dotnet restore'], ['Build', 'dotnet build'], ['Test', 'dotnet test'], ['Lint', 'dotnet format --verify-no-changes'], ['Start', 'dotnet run']],
  },
  { when: ['Gemfile'], commands: [['Install', 'bundle install']] },
  { when: ['bin/rails'], commands: [['Test', 'bin/rails test'], ['Start', 'bin/rails server']] },
  { when: ['.rubocop.yml'], commands: [['Lint', 'bundle exec rubocop']] },
  { when: ['.rspec'], commands: [['Test', 'bundle exec rspec']] },
  { when: ['composer.json'], commands: [['Install', 'composer install']] },
  { when: ['bin/phpunit'], group: 'phpunit', commands: [['Test', 'bin/phpunit']] },
  { when: ['phpunit.xml.dist', 'phpunit.xml', 'vendor/bin/phpunit'], group: 'phpunit', commands: [['Test', 'vendor/bin/phpunit']] },
  { when: ['bin/console'], commands: [['Lint', 'bin/console lint:container'], ['Lint', 'bin/console lint:yaml config'], ['Lint', 'bin/console lint:twig templates']] },
  // PHP's own server, because the symfony command is a separate install. Only with the folder it serves.
  { when: ['public/index.php'], commands: [['Start', 'php -S localhost:8000 -t public']] },
  { when: ['artisan'], commands: [['Test', 'php artisan test'], ['Start', 'php artisan serve']] },
  { when: ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon'], commands: [['Lint', 'vendor/bin/phpstan analyse']] },
  { when: ['.php-cs-fixer.php', '.php-cs-fixer.dist.php'], commands: [['Lint', 'vendor/bin/php-cs-fixer fix --dry-run --diff']] },
  { when: ['mix.exs'], commands: [['Install', 'mix deps.get'], ['Build', 'mix compile'], ['Test', 'mix test'], ['Lint', 'mix format --check-formatted']] },
  { when: ['Package.swift'], commands: [['Build', 'swift build'], ['Test', 'swift test'], ['Start', 'swift run']] },
  // `flutter create` writes `.metadata`, a plain Dart package has none.
  { when: ['.metadata'], also: 'pubspec.yaml', group: 'dart', commands: [['Install', 'flutter pub get'], ['Test', 'flutter test'], ['Lint', 'flutter analyze'], ['Start', 'flutter run']] },
  { when: ['pubspec.yaml'], group: 'dart', commands: [['Install', 'dart pub get'], ['Test', 'dart test'], ['Lint', 'dart analyze'], ['Start', 'dart run']] },
  { when: ['CMakeLists.txt'], commands: [['Build', 'cmake -B build'], ['Build', 'cmake --build build'], ['Test', 'ctest --test-dir build']] },
  // A task runner's targets are the project's own words, like package.json scripts. Only the usual
  // names, since the file is not read, and never a bare `make`, whose first target could be a deploy.
  { when: ['Makefile', 'makefile', 'GNUmakefile'], commands: [['Test', 'make test']] },
  { when: ['justfile', 'Justfile', '.justfile'], commands: [['Test', 'just test']] },
  { when: ['Taskfile.yml', 'Taskfile.yaml'], commands: [['Test', 'task test']] },
];

// The files below a repository's top that a row looks for. The caller adds each one it finds to the
// file list, written with its `/`.
export const DEEP_FILES: readonly string[] = [...new Set(STACKS.flatMap((stack) => stack.when.filter((file) => file.includes('/'))))];

// The file in the list a name matches, or undefined.
const found = (files: readonly string[], name: string): string | undefined => (name.startsWith('*.') ? files.find((file) => file.endsWith(name.slice(1))) : files.includes(name) ? name : undefined);

/** One command a stack offers, the recipe step it fills, and the file that gave it away. */
export interface StackCommand {
  step: StackStep;
  command: string;
  file: string;
}

/** Every command the rows of `STACKS` offer for these files, in the table's order. */
export function stackCommands(files: readonly string[]): StackCommand[] {
  const commands: StackCommand[] = [];
  const taken = new Set<string>();
  let run = '';
  for (const stack of STACKS) {
    if (stack.group !== undefined && taken.has(stack.group)) continue;
    const file = stack.when.map((name) => found(files, name)).find((one) => one !== undefined);
    if (file === undefined || (stack.also !== undefined && found(files, stack.also) === undefined)) continue;
    if (stack.group !== undefined) taken.add(stack.group);
    if (stack.run !== undefined) run = stack.run;
    for (const [step, command] of stack.commands) commands.push({ step, command: command.replace('{run}', run), file });
  }
  return commands;
}

/**
 * The first list for one repository, from its `package.json` scripts and the files at its top.
 *
 * For Node: install, test, lint and build, and only the scripts the project has. Each one runs
 * whatever `package.json` holds, and implement may edit that file, so the list trusts the project's
 * own scripts and no more. Every other stack comes from `STACKS`, all but its Start commands. A
 * repository with no file any row knows is offered nothing.
 */
export function proposeAllowedCommands(scripts: Readonly<Record<string, string>> | null | undefined, files: readonly string[]): string[] {
  const proposed: string[] = [];
  if (scripts !== null && scripts !== undefined) {
    const manager = lockfileOf(files)?.[1] ?? 'npm';
    const names = Object.keys(scripts);
    proposed.push(`${manager} install`, ...['test', 'lint', 'build'].filter((name) => names.includes(name)).map((name) => scriptCommand(manager, name)));
  }
  return [...proposed, ...stackCommands(files).filter(({ step }) => step !== 'Start').map(({ command }) => command)];
}

/**
 * Why a command cannot be allowed, or null when it can.
 *
 * The command has to start with a name. A leading `*` would be `Bash(*)`, which allows every
 * command, the one thing an empty list must never turn into. A parenthesis would close the pattern
 * early, and a new line would hide a second command behind the first.
 *
 * Variables set in front, as in `PORT=4320 npm *`, are fine with a fixed value and a command after
 * them. The engine matches a rule against the whole text and its `*` spans spaces, so `PORT=* npm *`
 * matches `PORT=1 rm -rf ~ npm`, and `PORT=4320 *` matches any command at all.
 */
// One `NAME=value` word in front of a command.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function allowedCommandProblem(command: string): string | null {
  const typed = command.trim();
  if (typed === '') return 'A command cannot be empty.';
  if (typed.startsWith('*')) return `${typed} names no command. Start with the command itself, such as npm test.`;
  if (typed.startsWith('-')) return `${typed} starts with a dash. Start with the command itself, such as npm test.`;
  if (/[()]/.test(typed)) return `${typed} holds a parenthesis, which the engine reads as the end of the pattern. Leave it out.`;
  if (/[\r\n]/.test(typed)) return 'A command is one line.';
  const words = typed.split(/\s+/);
  const first = words.findIndex((word) => !ASSIGNMENT.test(word));
  const variables = first === -1 ? words : words.slice(0, first);
  if (variables.some((word) => /[*?[]/.test(word))) {
    return `${typed} puts a wildcard in a variable, and the engine lets it match a whole other command, such as PORT=1 rm -rf ~ npm. Write the value out, such as PORT=4320 npm *.`;
  }
  // A quote or a backslash lets a value hold a space, so `FOO="a b" *` would read here as the command
  // `b"` while the engine reads `*` as the command.
  if (variables.some((word) => /["'\\]/.test(word))) {
    return `${typed} quotes or escapes a variable's value, which can hide what the command is. Use a value with no spaces, such as PORT=4320 npm *.`;
  }
  const named = first === -1 ? undefined : words[first];
  if (named === undefined || named.startsWith('*') || named.startsWith('-')) {
    return `${typed} names no command after its variables, so it would allow any command. Name the command, such as PORT=4320 npm *.`;
  }
  return null;
}

// The container tools that talk to a daemon over a socket. The wall closes those sockets on purpose,
// because the daemon writes anywhere on the machine, so an allowed command of these never works in a run.
const CONTAINER_TOOLS = ['docker', 'docker-compose', 'podman', 'nerdctl'];

/** Whether an allowed command starts a container tool, after any `NAME=value` words in front. */
export function needsContainerDaemon(command: string): boolean {
  const named = command
    .trim()
    .split(/\s+/)
    .find((word) => !ASSIGNMENT.test(word));
  return named !== undefined && CONTAINER_TOOLS.includes(named);
}

/** A list of commands, one per line, as a list or the first line it refuses. */
export function parseAllowedCommands(text: string): { ok: true; value: string[] } | { ok: false; message: string } {
  const lines = text.split(/\r?\n/);
  const value: string[] = [];
  for (const [index, line] of lines.entries()) {
    const typed = line.trim();
    if (typed === '') continue;
    const problem = allowedCommandProblem(typed);
    if (problem !== null) return { ok: false, message: `Line ${index + 1}: ${problem}` };
    if (!value.includes(typed)) value.push(typed);
  }
  return { ok: true, value };
}
