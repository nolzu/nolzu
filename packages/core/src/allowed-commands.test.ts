import { describe, expect, it } from 'vitest';
import { allowedCommandProblem, DEEP_FILES, needsContainerDaemon, parseAllowedCommands, proposeAllowedCommands } from './allowed-commands.ts';
import { readSetting, validateSetting } from './settings.ts';

describe('proposeAllowedCommands', () => {
  it('names the package manager the lockfile shows', () => {
    const scripts = { test: 'vitest', lint: 'eslint .', build: 'vite build', dev: 'vite' };

    expect(proposeAllowedCommands(scripts, ['pnpm-lock.yaml'])).toEqual(['pnpm install', 'pnpm test', 'pnpm run lint', 'pnpm run build']);
    expect(proposeAllowedCommands(scripts, ['package-lock.json'])).toEqual(['npm install', 'npm test', 'npm run lint', 'npm run build']);
    expect(proposeAllowedCommands(scripts, ['yarn.lock'])[0]).toBe('yarn install');
    // `bun test` would start bun's own test runner, so the run recipe and the list both say `bun run test`.
    expect(proposeAllowedCommands(scripts, ['bun.lock'])).toEqual(['bun install', 'bun run test', 'bun run lint', 'bun run build']);
    // A project that moved to pnpm can still hold its old package-lock.json.
    expect(proposeAllowedCommands(scripts, ['package-lock.json', 'pnpm-lock.yaml'])[0]).toBe('pnpm install');
  });

  it('falls back to npm with no lockfile, and lists only the scripts the project has', () => {
    expect(proposeAllowedCommands({ test: 'jest' }, [])).toEqual(['npm install', 'npm test']);
  });

  it('proposes nothing for a project with no file it knows', () => {
    expect(proposeAllowedCommands(null, ['pnpm-lock.yaml'])).toEqual([]);
    expect(proposeAllowedCommands(null, ['README.md', 'src', 'bin/other', '.metadata'])).toEqual([]);
  });

  // One row per stack: its files give exactly these commands.
  it.each<[string, string[], string[]]>([
    ['Deno', ['deno.json'], ['deno test', 'deno lint', 'deno fmt --check']],
    ['Python with uv', ['pyproject.toml', 'uv.lock'], ['uv sync', 'uv run pytest']],
    ['Python with poetry', ['pyproject.toml', 'poetry.lock'], ['poetry install', 'poetry run pytest']],
    ['Python with pip', ['requirements.txt'], ['pip install -r requirements.txt', 'python -m pytest']],
    ['Python with pip and no requirements file', ['pyproject.toml'], ['pip install -e .', 'python -m pytest']],
    ['ruff with uv', ['uv.lock', 'ruff.toml'], ['uv sync', 'uv run pytest', 'uv run ruff check', 'uv run ruff format --check']],
    ['Django with poetry', ['poetry.lock', 'manage.py'], ['poetry install', 'poetry run pytest', 'poetry run python manage.py test']],
    ['Django with pip', ['requirements.txt', 'manage.py'], ['pip install -r requirements.txt', 'python -m pytest', 'python manage.py test']],
    ['Rust', ['Cargo.toml'], ['cargo build', 'cargo test', 'cargo clippy', 'cargo fmt --check']],
    ['Go', ['go.mod'], ['go mod download', 'go build ./...', 'go test ./...', 'go vet ./...']],
    ['golangci-lint', ['.golangci.yml'], ['golangci-lint run']],
    ['the Gradle wrapper', ['gradlew', 'build.gradle.kts'], ['./gradlew build', './gradlew test']],
    ['Gradle', ['build.gradle'], ['gradle build', 'gradle test']],
    ['the Maven wrapper', ['mvnw', 'pom.xml'], ['./mvnw test', './mvnw package']],
    ['Maven', ['pom.xml'], ['mvn test', 'mvn package']],
    ['.NET', ['App.sln'], ['dotnet restore', 'dotnet build', 'dotnet test', 'dotnet format --verify-no-changes']],
    ['.NET by project file', ['App.csproj'], ['dotnet restore', 'dotnet build', 'dotnet test', 'dotnet format --verify-no-changes']],
    ['Ruby', ['Gemfile'], ['bundle install']],
    ['Rails', ['Gemfile', 'bin/rails', '.rubocop.yml'], ['bundle install', 'bin/rails test', 'bundle exec rubocop']],
    ['RSpec', ['.rspec'], ['bundle exec rspec']],
    ['PHP', ['composer.json'], ['composer install']],
    ['Symfony', ['composer.json', 'bin/console', 'phpunit.xml.dist'], ['composer install', 'vendor/bin/phpunit', 'bin/console lint:container', 'bin/console lint:yaml config', 'bin/console lint:twig templates']],
    ['Symfony with its own phpunit', ['bin/phpunit', 'phpunit.xml.dist'], ['bin/phpunit']],
    ['Laravel', ['composer.json', 'artisan'], ['composer install', 'php artisan test']],
    ['PHPStan and PHP CS Fixer', ['phpstan.neon.dist', '.php-cs-fixer.dist.php'], ['vendor/bin/phpstan analyse', 'vendor/bin/php-cs-fixer fix --dry-run --diff']],
    ['Elixir', ['mix.exs'], ['mix deps.get', 'mix compile', 'mix test', 'mix format --check-formatted']],
    ['Swift', ['Package.swift'], ['swift build', 'swift test']],
    ['Flutter', ['pubspec.yaml', '.metadata'], ['flutter pub get', 'flutter test', 'flutter analyze']],
    ['Dart', ['pubspec.yaml'], ['dart pub get', 'dart test', 'dart analyze']],
    ['CMake', ['CMakeLists.txt'], ['cmake -B build', 'cmake --build build', 'ctest --test-dir build']],
    ['Make', ['Makefile'], ['make test']],
    ['just', ['justfile'], ['just test']],
    ['Task', ['Taskfile.yml'], ['task test']],
  ])('proposes the %s commands', (_name, files, commands) => {
    expect(proposeAllowedCommands(null, files)).toEqual(commands);
  });

  it('adds every other stack to the package.json commands', () => {
    expect(proposeAllowedCommands({ test: 'vitest' }, ['pnpm-lock.yaml', 'Makefile'])).toEqual(['pnpm install', 'pnpm test', 'make test']);
  });

  it('asks for the files below the top that a row looks for', () => {
    expect([...DEEP_FILES].sort()).toEqual(['bin/console', 'bin/phpunit', 'bin/rails', 'public/index.php', 'vendor/bin/phpunit']);
  });

  // Every file any row knows, all at once: each command must be one the list would take by hand.
  it('proposes only commands the list takes, and no wildcard', () => {
    const everything = ['package.json', 'deno.json', 'uv.lock', 'ruff.toml', 'manage.py', 'Cargo.toml', 'go.mod', '.golangci.yml', 'gradlew', 'mvnw', 'App.sln', 'Gemfile', 'bin/rails', '.rubocop.yml', '.rspec', 'composer.json', 'bin/phpunit', 'bin/console', 'artisan', 'phpstan.neon', '.php-cs-fixer.php', 'mix.exs', 'Package.swift', 'pubspec.yaml', '.metadata', 'CMakeLists.txt', 'Makefile', 'justfile', 'Taskfile.yml'];
    const proposed = proposeAllowedCommands({ test: 'x', lint: 'x', build: 'x' }, everything);
    expect(proposed.length).toBeGreaterThan(50);
    for (const command of proposed) {
      expect(allowedCommandProblem(command), command).toBeNull();
      expect(command, command).not.toMatch(/[*?]|\b(migrat|deploy|publish|cache|db|database)/i);
    }
  });
});

describe('allowedCommandProblem', () => {
  it('takes a command with spaces and flags', () => {
    expect(allowedCommandProblem('npm test -- --run src/app.test.ts')).toBeNull();
    expect(allowedCommandProblem('ng test *')).toBeNull();
  });

  // A fixed value is safe: the rest of the rule still names the command.
  it('takes a variable with a fixed value in front of a command', () => {
    expect(allowedCommandProblem('PORT=4320 npm *')).toBeNull();
    expect(allowedCommandProblem('PORT=4320 HOST=127.0.0.1 npm start')).toBeNull();
    expect(allowedCommandProblem('npm run build -- --base=/app/*')).toBeNull();
  });

  // The engine's `*` spans spaces, so each of these matches some command the person never named.
  it.each([['PORT=* npm *'], ['PORT=43?0 npm start'], ['HOST=x PORT=4[0-9] npm *'], ['PORT=4320 *'], ['PORT=4320'], ['PORT=4320 -x'], ['FOO="a b" *'], ['FOO=a\\ b *'], ["FOO='x y' rm"], ['FOO="x y*" npm']])('refuses %j', (command) => {
    expect(allowedCommandProblem(command)).not.toBeNull();
  });

  it('says why a wildcard in a variable is refused and what to write instead', () => {
    expect(allowedCommandProblem('PORT=* npm *')).toBe(
      'PORT=* npm * puts a wildcard in a variable, and the engine lets it match a whole other command, such as PORT=1 rm -rf ~ npm. Write the value out, such as PORT=4320 npm *.',
    );
    expect(allowedCommandProblem('PORT=4320 *')).toBe('PORT=4320 * names no command after its variables, so it would allow any command. Name the command, such as PORT=4320 npm *.');
  });

  // Each of these would let the agent run more than the person wrote, or break the pattern.
  it.each([[''], ['   '], ['*'], ['* --help'], ['-rf'], ['npm (x)'], ['npm test)'], ['npm test\nrm -rf .'], ['npm test\rrm -rf .']])('refuses %j', (command) => {
    expect(allowedCommandProblem(command)).not.toBeNull();
  });
});

describe('parseAllowedCommands', () => {
  it('reads one command per line, trimmed, and drops blank lines and repeats', () => {
    expect(parseAllowedCommands(' npm install \n\nnpm test\nnpm install\n')).toEqual({ ok: true, value: ['npm install', 'npm test'] });
  });

  it('reads an empty box as an empty list, which allows no command', () => {
    expect(parseAllowedCommands('  \n ')).toEqual({ ok: true, value: [] });
  });

  it('names the line it refuses', () => {
    const parsed = parseAllowedCommands('npm test\n*');

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toMatch(/^Line 2: /);
  });
});

describe('the allowedCommands setting', () => {
  it('takes null, an empty list and a list of commands, and never keeps a bare wildcard', () => {
    expect(validateSetting('allowedCommands', null).ok).toBe(true);
    expect(validateSetting('allowedCommands', []).ok).toBe(true);
    expect(validateSetting('allowedCommands', ['npm test']).ok).toBe(true);
    expect(validateSetting('allowedCommands', ['*', 'npm test'])).toEqual({ ok: true, value: ['npm test'] });
    expect(validateSetting('allowedCommands', 'npm test').ok).toBe(false);
  });
});

// A list stored before a rule tightened keeps every entry that still holds. Dropping the whole list
// would run with no commands and invite a new proposal over the person's own list.
it('drops only the stored entries a later rule refuses', () => {
  expect(readSetting('allowedCommands', JSON.stringify(['npm test', 'PORT=* npm *', 'PORT=3000 npm *']))).toEqual({ value: ['npm test', 'PORT=3000 npm *'], fellBack: false });
});

// The wall closes the Docker and Podman sockets, so Settings, Project says so under such a command.
describe('needsContainerDaemon', () => {
  it.each(['docker *', 'docker-compose *', 'podman ps', 'nerdctl run *', 'DOCKER_HOST=x docker *', '  docker compose up'])('finds the container tool in %j', (command) => {
    expect(needsContainerDaemon(command)).toBe(true);
  });

  it.each(['npm test', 'dockerize *', 'npm run docker', 'make docker', 'PORT=4320 npm *', ''])('finds none in %j', (command) => {
    expect(needsContainerDaemon(command)).toBe(false);
  });
});
