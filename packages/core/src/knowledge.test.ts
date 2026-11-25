import { describe, expect, it } from 'vitest';
import { proposeAllowedCommands } from './allowed-commands.ts';
import { isRepoStub, noteFolder, planKnowledgeMoves, RUN_RECIPE_FILE, recipeMoved, recipeSectionOf, repoKnowledge, repoKnowledgePath, repoMoved, repoOfPath, resolveKnowledgeDir, runRecipe, withRecipeSection } from './knowledge.ts';

describe('resolveKnowledgeDir', () => {
  it('keeps the folder the person picked', () => {
    expect(resolveKnowledgeDir({ knowledgeDir: '/home/you/notes', projectPath: '/home/you/recipes' })).toBe('/home/you/notes');
  });

  // The default is not stored, so a project that moves takes its knowledge along.
  it('puts knowledge in the project when nobody picked a folder', () => {
    expect(resolveKnowledgeDir({ knowledgeDir: null, projectPath: '/home/you/recipes' })).toBe('/home/you/recipes/.nolzu/knowledge');
  });

  it('answers nothing when there is no project to be relative to', () => {
    expect(resolveKnowledgeDir({ knowledgeDir: null, projectPath: null })).toBeNull();
  });

  it('keeps a picked folder when there is no project', () => {
    expect(resolveKnowledgeDir({ knowledgeDir: '/home/you/notes', projectPath: null })).toBe('/home/you/notes');
  });

  // A backslash is part of the name on Linux and part of the path on Windows. Both keep the name
  // they came with, because the separator is never guessed from the string.
  it('leaves a backslash in the project path alone', () => {
    expect(resolveKnowledgeDir({ knowledgeDir: null, projectPath: '/home/you/my\\stuff' })).toBe('/home/you/my\\stuff/.nolzu/knowledge');
    expect(resolveKnowledgeDir({ knowledgeDir: null, projectPath: 'C:\\code\\recipes' })).toBe('C:\\code\\recipes/.nolzu/knowledge');
  });
});

describe('the folder a note belongs in', () => {
  it('reads the repository of a path from its first folder, else the project folder when it is listed', () => {
    expect(repoOfPath('api/src/a.ts', ['.', 'api'])).toBe('api');
    expect(repoOfPath('./api/src/a.ts', ['api'])).toBe('api');
    expect(repoOfPath('src/a.ts', ['.', 'api'])).toBe('.');
    expect(repoOfPath('src/a.ts', ['api', 'web'])).toBeNull();
  });

  it('gives the folder of the one repository, shared/ for several, and null for none or an unknown one', () => {
    expect(noteFolder(['api/a.ts', 'api/b.ts'], ['api', 'web'])).toBe('api/');
    expect(noteFolder(['src/a.ts'], ['.', 'api'])).toBe('');
    expect(noteFolder(['api/a.ts', 'web/b.ts'], ['api', 'web'])).toBe('shared/');
    expect(noteFolder(['api/a.ts', 'src/b.ts'], ['.', 'api'])).toBe('shared/');
    expect(noteFolder([], ['api'])).toBeNull();
    expect(noteFolder(['api/a.ts', 'docs/b.md'], ['api', 'web'])).toBeNull();
  });
});

describe('planKnowledgeMoves', () => {
  const note = (paths: string) => `---\ndescription: Read before changing search.\npaths: ${paths}\n---\n\nSearch lower cases both sides.\n`;
  const file = (path: string, text = '# x\n') => ({ path, text });

  it('moves the repository files and each note to the folder its paths name', () => {
    const plan = planKnowledgeMoves(
      [
        file('run-recipe.md'),
        file('repositories/project-root.md'),
        file('repositories/api.md'),
        file('search.md', note('api/src/search.ts')),
        file('lists.md', note('api/a.ts, web/b.ts')),
        file('build.md', note('Makefile')),
      ],
      ['.', 'api', 'web'],
    );
    expect(plan).toEqual({
      moves: [
        { from: 'repositories/project-root.md', to: 'repository.md' },
        { from: 'repositories/api.md', to: 'api/repository.md' },
        { from: 'search.md', to: 'api/search.md' },
        { from: 'lists.md', to: 'shared/lists.md' },
      ],
      // A note of the project folder's own repository is in its place already.
      left: [],
      taken: [],
    });
  });

  it('leaves a note with no paths or a path in no repository at the top, and lists it', () => {
    const plan = planKnowledgeMoves([file('words.md'), file('docs.md', note('docs/a.md')), file('testing/unit.md', note('api/a.ts'))], ['api', 'web']);
    expect(plan).toEqual({ moves: [], left: ['words.md', 'docs.md'], taken: [] });
  });

  it('never moves onto a file that is there, nor two files onto one place', () => {
    const plan = planKnowledgeMoves([file('repositories/api.md'), file('api/repository.md'), file('search.md', note('api/a.ts')), file('api/search.md'), file('repositories/web.md')], ['api', 'web']);
    expect(plan).toEqual({ moves: [{ from: 'repositories/web.md', to: 'web/repository.md' }], left: [], taken: ['repositories/api.md', 'search.md'] });
  });

  it('has nothing to move in a folder of the new layout', () => {
    expect(planKnowledgeMoves([file('run-recipe.md'), file('api/repository.md'), file('api/search.md', note('api/a.ts')), file('shared/lists.md')], ['api', 'web']).moves).toEqual([]);
  });
});

describe('repoKnowledgePath', () => {
  it('puts the file in a folder named after the repository', () => {
    expect(repoKnowledgePath('api')).toBe('api/repository.md');
  });

  // A project of one repository at its root keeps a flat knowledge folder.
  it('puts the project folder\'s own file at the top of the knowledge folder', () => {
    expect(repoKnowledgePath('.')).toBe('repository.md');
  });

  // The name becomes a file inside the knowledge folder, so a slash would reach another folder.
  it.each(['web/api', '..', '', 'a\\b'])('refuses %j, which is not one folder name', (path) => {
    expect(() => repoKnowledgePath(path)).toThrow();
  });
});

describe('repoKnowledge', () => {
  const text = repoKnowledge({ path: 'api', base: 'main' });

  // The Knowledge screen and the index show the description, so it says when to read the file.
  it('starts with frontmatter carrying a description that says when to read it', () => {
    expect(text).toMatch(/^---\ndescription: Read before [^\n]+\.\n---\n/);
  });

  it('names the folder and the base branch', () => {
    expect(text).toContain('`api` in the project folder');
    expect(text).toContain('Base branch: `main`.');
  });

  // Agents read the stack and the folders live, and a copy here goes stale.
  it('names no stack and no top folders', () => {
    expect(text).not.toMatch(/Stack|Top folders/);
  });

  it('asks a later run to say what the repository is for', () => {
    expect(text).toMatch(/what this repository is for/i);
  });

  it('calls the repository at "." the project folder', () => {
    expect(repoKnowledge({ path: '.', base: 'develop' })).toMatch(/project folder itself/);
  });

  // Make this a workspace moves the project folder's repository into a folder of its own.
  it('becomes the file of the folder the project folder moved to, and keeps what a run added', () => {
    const learned = repoKnowledge({ path: '.', base: 'main' }).replace(/Nobody has written.*\n/, 'The app serves the recipe list.\n');
    expect(repoMoved(learned, 'app')).toBe(repoKnowledge({ path: 'app', base: 'main' }).replace(/Nobody has written.*\n/, 'The app serves the recipe list.\n'));
    expect(repoMoved(text, 'web')).toBe(text);
  });
});

describe('runRecipe', () => {
  const api = { path: 'api', scripts: { test: 'vitest run', lint: 'eslint .', build: 'vite build', dev: 'vite', typecheck: 'tsc' }, files: ['package.json', 'pnpm-lock.yaml'] };
  const text = runRecipe([api], null) ?? '';

  it('starts with a description that says when to read it, and is the file the index puts first', () => {
    expect(RUN_RECIPE_FILE).toBe('run-recipe.md');
    expect(text).toMatch(/^---\ndescription: Read before [^\n:]+\.\n---\n/);
  });

  it('gives each command with the file it was read from', () => {
    // A blank line sets the first section apart from the sentence above it.
    expect(text).toContain('a flag it takes.\n\n## The api repository');
    expect(text).toContain('- Install: `pnpm install`, because `pnpm-lock.yaml` is at its top.');
    expect(text).toContain('- Test: `pnpm test`, the `test` script in `package.json`.');
    expect(text).toContain('- Lint: `pnpm run lint`, the `lint` script in `package.json`.');
    expect(text).toContain('- Type-check: `pnpm run typecheck`, the `typecheck` script in `package.json`.');
    expect(text).toContain('- Build: `pnpm run build`, the `build` script in `package.json`.');
    expect(text).toContain('- Start: `pnpm run dev`, the `dev` script in `package.json`.');
  });

  // Nothing is guessed: a command Nolzu could not read stays a line that says so.
  it('says which commands it could not read, and that nobody wrote a catch yet', () => {
    const bare = runRecipe([{ path: '.', scripts: {}, files: ['package.json'] }], null) ?? '';
    expect(bare).toContain('## The project folder');
    expect(bare).toContain('- Install: `npm install`, because `package.json` is at its top and no lockfile names another tool.');
    expect(bare).toMatch(/- Test: Not read\. `package\.json` has no `test` script\./);
    expect(bare).toMatch(/- Start: Not read\./);
    expect(bare).toMatch(/- Catches: None written yet\./);
  });

  it('says in one line that a repository with no file Nolzu knows has nothing it can read', () => {
    const bare = runRecipe([{ path: 'svc', scripts: null, files: ['README.md', 'src'] }], null) ?? '';
    expect(bare).toContain('## The svc repository');
    // "Not read" is the mark the Implement and QA skills look for, as on a missing script.
    expect(bare).toMatch(/Not read: Nolzu found no `package\.json` and no other file it knows at its top\. Write how to install/);
    expect(bare).not.toMatch(/- Install/);
  });

  // The same stack table as the allowed commands: these files give these lines, each a first guess
  // with the file it came from, and Not read for a step no file names.
  const section = (files: string[]): string[] => (runRecipe([{ path: 'app', scripts: null, files }], null) ?? '').split('\n').filter((line) => line.startsWith('- ') && !line.startsWith('- Catches'));
  const guess = (step: string, command: string, file: string) => `- ${step}: \`${command}\`, a first guess from \`${file}\`.`;
  const none = (step: string) => `- ${step}: Not read. No file at its top names one. Write the command and where it comes from here.`;
  it.each<[string, string[], string[]]>([
    [
      'Symfony',
      ['composer.json', 'bin/console', 'phpunit.xml.dist'],
      [
        guess('Install', 'composer install', 'composer.json'),
        guess('Test', 'vendor/bin/phpunit', 'phpunit.xml.dist'),
        guess('Lint', 'bin/console lint:container', 'bin/console'),
        guess('Lint', 'bin/console lint:yaml config', 'bin/console'),
        guess('Lint', 'bin/console lint:twig templates', 'bin/console'),
        none('Build'),
        none('Start'),
      ],
    ],
    // PHP's own server needs the folder it serves.
    ['Symfony with a public folder', ['composer.json', 'bin/console', 'public/index.php'], [guess('Install', 'composer install', 'composer.json'), none('Test'), guess('Lint', 'bin/console lint:container', 'bin/console'), guess('Lint', 'bin/console lint:yaml config', 'bin/console'), guess('Lint', 'bin/console lint:twig templates', 'bin/console'), none('Build'), guess('Start', 'php -S localhost:8000 -t public', 'public/index.php')]],
    ['Laravel', ['composer.json', 'artisan'], [guess('Install', 'composer install', 'composer.json'), guess('Test', 'php artisan test', 'artisan'), none('Lint'), none('Build'), guess('Start', 'php artisan serve', 'artisan')]],
    [
      'Django with uv and ruff',
      ['pyproject.toml', 'uv.lock', 'ruff.toml', 'manage.py'],
      [
        guess('Install', 'uv sync', 'uv.lock'),
        guess('Test', 'uv run pytest', 'uv.lock'),
        guess('Test', 'uv run python manage.py test', 'manage.py'),
        guess('Lint', 'uv run ruff check', 'ruff.toml'),
        guess('Lint', 'uv run ruff format --check', 'ruff.toml'),
        none('Build'),
        guess('Start', 'uv run python manage.py runserver', 'manage.py'),
      ],
    ],
    ['poetry', ['poetry.lock'], [guess('Install', 'poetry install', 'poetry.lock'), guess('Test', 'poetry run pytest', 'poetry.lock'), none('Lint'), none('Build'), none('Start')]],
    ['pip', ['requirements.txt'], [guess('Install', 'pip install -r requirements.txt', 'requirements.txt'), guess('Test', 'python -m pytest', 'requirements.txt'), none('Lint'), none('Build'), none('Start')]],
    [
      'Rails',
      ['Gemfile', 'bin/rails', '.rubocop.yml'],
      [guess('Install', 'bundle install', 'Gemfile'), guess('Test', 'bin/rails test', 'bin/rails'), guess('Lint', 'bundle exec rubocop', '.rubocop.yml'), none('Build'), guess('Start', 'bin/rails server', 'bin/rails')],
    ],
    [
      'Go',
      ['go.mod'],
      [guess('Install', 'go mod download', 'go.mod'), guess('Test', 'go test ./...', 'go.mod'), guess('Lint', 'go vet ./...', 'go.mod'), guess('Build', 'go build ./...', 'go.mod'), guess('Start', 'go run .', 'go.mod')],
    ],
    [
      'Rust',
      ['Cargo.toml'],
      [none('Install'), guess('Test', 'cargo test', 'Cargo.toml'), guess('Lint', 'cargo clippy', 'Cargo.toml'), guess('Lint', 'cargo fmt --check', 'Cargo.toml'), guess('Build', 'cargo build', 'Cargo.toml'), guess('Start', 'cargo run', 'Cargo.toml')],
    ],
    ['the Gradle wrapper', ['gradlew', 'build.gradle.kts'], [none('Install'), guess('Test', './gradlew test', 'gradlew'), none('Lint'), guess('Build', './gradlew build', 'gradlew'), none('Start')]],
    ['Maven', ['pom.xml'], [none('Install'), guess('Test', 'mvn test', 'pom.xml'), none('Lint'), guess('Build', 'mvn package', 'pom.xml'), none('Start')]],
    [
      '.NET',
      ['Shop.sln'],
      [
        guess('Install', 'dotnet restore', 'Shop.sln'),
        guess('Test', 'dotnet test', 'Shop.sln'),
        guess('Lint', 'dotnet format --verify-no-changes', 'Shop.sln'),
        guess('Build', 'dotnet build', 'Shop.sln'),
        guess('Start', 'dotnet run', 'Shop.sln'),
      ],
    ],
    [
      'Elixir',
      ['mix.exs'],
      [guess('Install', 'mix deps.get', 'mix.exs'), guess('Test', 'mix test', 'mix.exs'), guess('Lint', 'mix format --check-formatted', 'mix.exs'), guess('Build', 'mix compile', 'mix.exs'), none('Start')],
    ],
    ['Swift', ['Package.swift'], [none('Install'), guess('Test', 'swift test', 'Package.swift'), none('Lint'), guess('Build', 'swift build', 'Package.swift'), guess('Start', 'swift run', 'Package.swift')]],
    [
      'Flutter',
      ['pubspec.yaml', '.metadata'],
      [guess('Install', 'flutter pub get', '.metadata'), guess('Test', 'flutter test', '.metadata'), guess('Lint', 'flutter analyze', '.metadata'), none('Build'), guess('Start', 'flutter run', '.metadata')],
    ],
    [
      'CMake',
      ['CMakeLists.txt'],
      [none('Install'), guess('Test', 'ctest --test-dir build', 'CMakeLists.txt'), none('Lint'), guess('Build', 'cmake -B build', 'CMakeLists.txt'), guess('Build', 'cmake --build build', 'CMakeLists.txt'), none('Start')],
    ],
    ['Make', ['Makefile'], [none('Install'), guess('Test', 'make test', 'Makefile'), none('Lint'), none('Build'), none('Start')]],
    ['just', ['justfile'], [none('Install'), guess('Test', 'just test', 'justfile'), none('Lint'), none('Build'), none('Start')]],
    ['Task', ['Taskfile.yml'], [none('Install'), guess('Test', 'task test', 'Taskfile.yml'), none('Lint'), none('Build'), none('Start')]],
  ])('reads the %s files into first guesses', (_name, files, lines) => {
    expect(section(files)).toEqual(lines);
  });

  // Each guess the recipe makes, but Start, is one the allowed commands offer, so they cannot drift.
  it('guesses the commands the allowed list proposes, and a start command only in the recipe', () => {
    const files = ['composer.json', 'bin/console', 'bin/phpunit', 'phpstan.neon', 'go.mod', 'uv.lock', 'manage.py', 'Makefile'];
    const guessed = section(files).flatMap((line) => (line.includes('a first guess') && !line.startsWith('- Start') ? [line.split('`')[1]] : []));
    expect(guessed.sort()).toEqual(proposeAllowedCommands(null, files).sort());
    expect(proposeAllowedCommands(null, files)).not.toContain('go run .');
  });

  // A Node repository that holds another stack too gets both, and no Not read where a stack has one.
  it('adds the other stacks to the package.json lines', () => {
    const both = runRecipe([{ path: '.', scripts: { build: 'vite build' }, files: ['package.json', 'composer.json', 'phpunit.xml'] }], null) ?? '';
    expect(both).toContain('- Install: `npm install`, because `package.json` is at its top and no lockfile names another tool.\n- Install: `composer install`, a first guess from `composer.json`.');
    expect(both).toContain('- Test: `vendor/bin/phpunit`, a first guess from `phpunit.xml`.');
    expect(both).not.toMatch(/- Test: Not read/);
    expect(both).toMatch(/- Lint: Not read\. `package\.json` has no `lint` script\./);
    expect(both).toContain('- Build: `npm run build`, the `build` script in `package.json`.');
  });

  it('reads a command from the other script names it goes by', () => {
    const other = runRecipe([{ path: 'web', scripts: { 'type-check': 'tsc', start: 'node server.js', serve: 'vite preview' }, files: ['package.json'] }], null) ?? '';
    expect(other).toContain('- Type-check: `npm run type-check`, the `type-check` script in `package.json`.');
    expect(other).toContain('- Start: `npm run start`, the `start` script in `package.json`.');
  });

  // `bun test` runs bun's own test runner, not the script.
  it('runs the test script through run on bun', () => {
    expect(runRecipe([{ ...api, files: ['package.json', 'bun.lock'] }], null)).toContain('`bun run test`');
  });

  // A file already there keeps every line a person or a run wrote, and only a new repository is added.
  it('adds a section only for a repository the file has none for', () => {
    const web = { path: 'web', scripts: { test: 'vitest' }, files: ['package.json'] };
    const edited = text.replace('- Catches: None written yet. A run that finds one adds it here.', '- Catches: the api tests need Docker.');
    const added = runRecipe([api, web], edited) ?? '';
    expect(added.startsWith(edited)).toBe(true);
    expect(added).toContain('the api tests need Docker');
    expect(added.match(/## The api repository/g)).toHaveLength(1);
    expect(added).toContain('## The web repository');
    expect(runRecipe([api], edited)).toBeNull();
  });

  // Make this a workspace moves the project folder's repository into a folder of its own.
  it('renames the project folder section for the folder it moved to, and keeps every other line', () => {
    const root = runRecipe([{ ...api, path: '.' }], null) ?? '';
    const moved = recipeMoved(root, 'app');
    expect(moved).toContain('## The app repository\n\nRun these in the `app` folder of the project.\n\n- Install: `pnpm install`');
    expect(moved).not.toContain('## The project folder');
    expect(runRecipe([{ ...api, path: 'app' }], moved)).toBeNull();
    const bare = runRecipe([{ path: '.', scripts: null, files: [] }], null) ?? '';
    expect(recipeMoved(bare, 'app')).toContain('## The app repository\n\nRun these in the `app` folder of the project. Not read: ');
  });

  it('writes nothing for no repository', () => {
    expect(runRecipe([], null)).toBeNull();
  });
});

// Learn your repositories runs once per repository, and each run's change waits for review on its own.
// The run recipe is one file for all of them, so Apply takes one repository's section and no more.
describe('one repository section of the run recipe', () => {
  const recipe = runRecipe(
    [
      { path: 'api', scripts: null, files: [] },
      { path: 'web', scripts: { test: 'vitest' }, files: ['package-lock.json'] },
    ],
    null,
  ) ?? '';

  it('reads a section from its heading to the next one', () => {
    expect(recipeSectionOf(recipe, 'api')).toMatch(/^## The api repository\n\nRun these in the `api` folder of the project\. Not read:/);
    expect(recipeSectionOf(recipe, 'api')).not.toContain('## The web repository');
    expect(recipeSectionOf(recipe, 'web')).toContain('`npm test`');
    expect(recipeSectionOf(recipe, 'docs')).toBeNull();
  });

  it('puts a new section in place of the old one and leaves the others as they were', () => {
    const written = withRecipeSection(recipe, 'api', '## The api repository\n\n- Test: `bin/phpunit`, from the CI file.\n');

    expect(recipeSectionOf(written, 'api')).toBe('## The api repository\n\n- Test: `bin/phpunit`, from the CI file.');
    expect(recipeSectionOf(written, 'web')).toBe(recipeSectionOf(recipe, 'web'));
    expect(written.startsWith(recipe.slice(0, recipe.indexOf('## The api repository')))).toBe(true);
  });

  it('adds a section the recipe has no heading for at the end', () => {
    const written = withRecipeSection(recipe, 'docs', '## The docs repository\n\n- Build: `make html`, from the README.');

    expect(written).toBe(`${recipe.trimEnd()}\n\n## The docs repository\n\n- Build: \`make html\`, from the README.\n`);
  });

  it('tells the first lines Nolzu wrote from a file a run filled', () => {
    expect(isRepoStub(repoKnowledge({ path: 'api', base: 'main' }))).toBe(true);
    expect(isRepoStub('# The api repository\n\nThe API the recipe app reads. (from README.md)\n')).toBe(false);
  });
});
