import { frontmatterPaths } from '@nolzu/protocol';
import { lockfileOf, scriptCommand, stackCommands } from './allowed-commands.ts';
import { START_SCRIPTS } from './onboarding.ts';
import { isFolderName, type Settings } from './settings.ts';

/**
 * Where this project's knowledge lives.
 *
 * The folder the person picked, else `.nolzu/knowledge` in the project. The default has
 * that shape so knowledge is versioned with the project and a teammate who
 * clones it has it too. The default is worked out here and never stored: a stored copy would stay
 * behind when the project moves.
 *
 * Null when there is no project path, because there is then nothing to be relative to. A caller
 * that gets null says the project folder is missing, which is the thing the person can fix.
 *
 * Nothing is made here, and nothing is checked. The code that writes knowledge makes the folder
 * before the first wrap-up writes into it, and `checkKnowledgeDir` in the runner holds the rules for
 * a path a person typed.
 */
export function resolveKnowledgeDir(settings: Pick<Settings, 'knowledgeDir' | 'projectPath'>): string | null {
  if (settings.knowledgeDir !== null) return settings.knowledgeDir;
  if (settings.projectPath === null) return null;
  // A forward slash, never guessed from the string: a POSIX folder can hold a backslash in its name.
  return `${settings.projectPath}/.nolzu/knowledge`;
}

// The file of what a repository is for, in that repository's folder of the knowledge folder.
export const REPO_FILE = 'repository.md';

/**
 * The folder of the knowledge folder that holds one repository's file and notes, with a trailing
 * slash, or empty for the project folder's repository, which uses the knowledge folder itself. So a
 * project of one repository at its root stays flat. Anything else must be one folder name, because
 * a slash would put the files in another folder.
 */
export function repoKnowledgeFolder(path: string): string {
  if (path === '.') return '';
  if (!isFolderName(path)) throw new Error(`The repository folder ${JSON.stringify(path)} is not one folder name, so it has no knowledge folder.`);
  return `${path}/`;
}

/** Where a repository's own knowledge file sits, relative to the knowledge folder. */
export const repoKnowledgePath = (path: string): string => `${repoKnowledgeFolder(path)}${REPO_FILE}`;

// The folder of the notes whose paths span more than one repository.
// Limit: a repository named shared would share this folder; rename the folder if one ever is.
export const SHARED_FOLDER = 'shared';

// The repository a path from the project folder is in: the listed repository named by its first
// folder, else the project folder's own repository when it is listed. Null when no listed one holds it.
export function repoOfPath(path: string, repos: readonly string[]): string | null {
  const first = path.replace(/^\.\//, '').split('/')[0] ?? '';
  if (first !== '.' && repos.includes(first)) return first;
  return repos.includes('.') ? '.' : null;
}

/**
 * The folder a note belongs in, from the paths its frontmatter names: the folder of their one
 * repository, `shared/` when they span several, or null when it names none or one outside every
 * listed repository, which leaves the note where it is.
 */
export function noteFolder(paths: readonly string[], repos: readonly string[]): string | null {
  const owners = new Set(paths.map((path) => repoOfPath(path, repos)));
  if (owners.size === 0 || owners.has(null)) return null;
  const [one] = owners;
  return owners.size > 1 ? `${SHARED_FOLDER}/` : repoKnowledgeFolder(one ?? '.');
}

export interface KnowledgeMoves {
  moves: { from: string; to: string }[];
  // Notes at the top whose paths name no repository, or none at all, so they stay where they are.
  left: string[];
  // Files that stay because their place in the new layout holds a file already, which is never overwritten.
  taken: string[];
}

/**
 * How a knowledge folder of the older layout moves into the one grouped by repository:
 * `repositories/<repo>.md` to `<repo>/repository.md` (`project-root.md` to the top), and each note at
 * the top to the folder its paths name. Empty when the folder has the new layout already.
 *
 * `files` is the whole folder, with the text of each note at the top, which the paths are read from.
 */
export function planKnowledgeMoves(files: readonly { path: string; text: string }[], repos: readonly string[]): KnowledgeMoves {
  const plan: KnowledgeMoves = { moves: [], left: [], taken: [] };
  const there = new Set(files.map((file) => file.path));
  for (const { path, text } of files) {
    const old = /^repositories\/([^/]+)\.md$/.exec(path)?.[1];
    let to: string | null = null;
    if (old === 'project-root') to = REPO_FILE;
    else if (old !== undefined && isFolderName(old)) to = `${old}/${REPO_FILE}`;
    else if (!path.includes('/') && path.endsWith('.md') && path !== RUN_RECIPE_FILE && path !== REPO_FILE) {
      const folder = noteFolder(frontmatterPaths(text), repos);
      if (folder === null) plan.left.push(path);
      else if (folder !== '') to = `${folder}${path}`;
    }
    if (to === null) continue;
    if (there.has(to)) plan.taken.push(path);
    else {
      plan.moves.push({ from: path, to });
      there.add(to);
    }
  }
  return plan;
}

// The line a repository file has until a run learns what the repository is for.
export const REPO_STUB_LINE = 'Nobody has written what this repository is for yet. A run that learns it writes it here.';

// A repository file with only the lines Nolzu wrote, which Learn your repositories offers to fill.
export const isRepoStub = (text: string): boolean => text.includes(REPO_STUB_LINE);

export interface RepoFacts {
  path: string;
  base: string;
}

// The lines of a repository file that name where it sits: the description, the heading and the folder.
function placeLines(path: string): [string, string, string] {
  const root = path === '.';
  return [
    `description: Read before you change ${root ? 'the project folder' : `the ${path} repository`}. Where it sits, the branch it starts from and what it is for.`,
    `# ${root ? 'The project folder' : `The ${path} repository`}`,
    `- Folder: ${root ? 'the project folder itself' : `\`${path}\` in the project folder`}.`,
  ];
}

/**
 * The first knowledge file of one repository: where it sits and the branch it starts from.
 *
 * No stack and no top folders: an agent reads those live, and a copy here goes stale. A guess at
 * what the repository is for would read as knowledge, so that line is left for a run that learns it.
 */
export function repoKnowledge(facts: RepoFacts): string {
  const [description, heading, folder] = placeLines(facts.path);
  return [
    '---',
    description,
    '---',
    '',
    heading,
    '',
    folder,
    `- Base branch: \`${facts.base}\`.`,
    '',
    REPO_STUB_LINE,
    '',
  ].join('\n');
}

// The project folder's repository file, for the folder Make this a workspace moves the repository
// into. Only the lines Nolzu wrote change, so what a run added, such as the purpose line, stays.
export function repoMoved(text: string, folder: string): string {
  const was = placeLines('.');
  const now = placeLines(folder);
  return text
    .split('\n')
    .map((line) => now[was.indexOf(line)] ?? line)
    .join('\n');
}

// The knowledge file that says how to install, test and start each repository. Every card needs it,
// so the knowledge index lists it first.
export const RUN_RECIPE_FILE = 'run-recipe.md';

export interface RecipeFacts {
  path: string;
  // The `package.json` scripts, `{}` for a `package.json` with none, null when there is no `package.json`.
  scripts: Readonly<Record<string, string>> | null;
  // The file names at the repository's top, for the lockfile and the other stacks, with the few
  // `DEEP_FILES` below it that are there.
  files: readonly string[];
}

export const recipeHeading = (path: string): string => (path === '.' ? '## The project folder' : `## The ${path} repository`);
const runIn = (path: string): string => (path === '.' ? 'Run these in the project folder.' : `Run these in the \`${path}\` folder of the project.`);

// Each command a card needs, with the script names it is read from, best first. Type-check has no
// row in the stack table, so only a `package.json` gives it a line.
const RECIPE_STEPS: readonly [string, readonly string[]][] = [
  ['Install', []],
  ['Test', ['test']],
  ['Lint', ['lint']],
  ['Type-check', ['typecheck', 'type-check']],
  ['Build', ['build']],
  ['Start', START_SCRIPTS],
];

function recipeSection(repo: RecipeFacts): string {
  const where = runIn(repo.path);
  // The stack table is the one the allowed commands come from, so the two say the same. Its lines
  // are a guess from file names alone, and say so.
  const stacks = stackCommands(repo.files);
  if (repo.scripts === null && stacks.length === 0) {
    return `${recipeHeading(repo.path)}\n\n${where} Not read: Nolzu found no \`package.json\` and no other file it knows at its top. Write how to install, test, lint, type-check, build and start it here, each with where it comes from, such as the CI file or the README.\n`;
  }
  const scripts = repo.scripts;
  const lock = lockfileOf(repo.files);
  const manager = lock?.[1] ?? 'npm';
  const names = Object.keys(scripts ?? {});
  const lines = RECIPE_STEPS.flatMap(([label, wanted]) => {
    const guessed = stacks.filter(({ step }) => step === label).map(({ command, file }) => `- ${label}: \`${command}\`, a first guess from \`${file}\`.`);
    const node: string[] = [];
    if (scripts !== null && label === 'Install') {
      node.push(`- Install: \`${manager} install\`, because ${lock === undefined ? '`package.json` is at its top and no lockfile names another tool' : `\`${lock[0]}\` is at its top`}.`);
    } else if (scripts !== null) {
      const script = wanted.find((name) => names.includes(name));
      if (script !== undefined) node.push(`- ${label}: \`${scriptCommand(manager, script)}\`, the \`${script}\` script in \`package.json\`.`);
      else if (guessed.length === 0) node.push(`- ${label}: Not read. \`package.json\` has no \`${wanted[0]}\` script. Write the command and where it comes from here.`);
    } else if (guessed.length === 0 && label !== 'Type-check') {
      node.push(`- ${label}: Not read. No file at its top names one. Write the command and where it comes from here.`);
    }
    return [...node, ...guessed];
  });
  lines.push('- Catches: None written yet. A run that finds one adds it here.');
  return `${recipeHeading(repo.path)}\n\n${where}\n\n${lines.join('\n')}\n`;
}

// Where one repository's section starts and ends in the run recipe: its heading up to the next
// section heading, or the end of the file. Null when the recipe has no heading for it.
function sectionBounds(lines: readonly string[], path: string): [number, number] | null {
  const start = lines.findIndex((line) => line.trim() === recipeHeading(path));
  if (start === -1) return null;
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return [start, next === -1 ? lines.length : next];
}

/** One repository's section of the run recipe, with no blank lines after it, or null. */
export function recipeSectionOf(text: string, path: string): string | null {
  const lines = text.split('\n');
  const bounds = sectionBounds(lines, path);
  return bounds === null ? null : lines.slice(bounds[0], bounds[1]).join('\n').trimEnd();
}

/**
 * The run recipe with one repository's section in place of the one it had, or added at the end.
 *
 * Learn your repositories writes one section per run, and each run's change waits for review on its
 * own, so Apply puts in that section alone. Writing the whole kept file would drop the section an
 * earlier run of another repository added.
 */
export function withRecipeSection(text: string, path: string, section: string): string {
  const lines = text.split('\n');
  const bounds = sectionBounds(lines, path);
  const body = section.trimEnd();
  if (bounds === null) return `${text.trimEnd()}\n\n${body}\n`;
  const before = bounds[0] === 0 ? '' : `${lines.slice(0, bounds[0]).join('\n')}\n`;
  const after = lines.slice(bounds[1]).join('\n');
  return `${before}${body}\n${after === '' ? '' : `\n${after}`}`;
}

// The section of the project folder renamed for the repository it became, when Make this a workspace
// moves it into a folder of its own. Every other line stays as it was.
export const recipeMoved = (text: string, folder: string): string =>
  text.replace(`${recipeHeading('.')}\n\nRun these in the project folder.`, `${recipeHeading(folder)}\n\n${runIn(folder)}`);

/**
 * The run recipe with a section for each repository, from its `package.json` and lockfile, and from
 * the stack table the allowed commands use for every other stack.
 *
 * A stack command is a first guess from a file name and its line says so. A step no file names
 * stays a line that says Not read, because a made-up command would run the wrong thing. A file
 * already there keeps every line it has, and gets a section only for a repository it names no
 * heading for. Null when there is nothing to add.
 */
export function runRecipe(repos: readonly RecipeFacts[], existing: string | null): string | null {
  const headings = new Set((existing ?? '').split('\n').map((line) => line.trim()));
  const added = repos.filter((repo) => !headings.has(recipeHeading(repo.path))).map(recipeSection);
  if (added.length === 0) return null;
  const top = [
    '---',
    'description: Read before you install, test, lint, type-check, build or start a repository. The command for each, where it comes from and its catch.',
    '---',
    '',
    '# How to run each repository',
    '',
    'Nolzu wrote the first lines from each `package.json` and the other files it knows at the top of each repository. Correct a command that is wrong, and add the catch a run met, such as a service it needs or a flag it takes.',
    '',
    '',
  ].join('\n');
  const before = existing === null ? top : existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${before}${existing === null ? '' : '\n'}${added.join('\n')}`;
}
