import { SKILL_FOLDERS } from '@nolzu/runner';

// The rules pack-check.ts holds the tarball to. They live apart from the script so a test can hand
// them a bad file: the real tarball is clean, so the script alone never shows that a rule can fail.

// pnpm adds the license of the repository root, because the app folder has none of its own.
export const outsideTheApp = (file: string): boolean => !/^package\/(package\.json|README\.md|LICENSE|(build|dist)\/.+)$/.test(file);
export const isTestFile = (file: string): boolean => /\.(test|spec)\.[a-z]+$/.test(file);
// An engine folder such as `.claude` or `.agents` holds one machine's settings or skills. The build copies
// the skill folders whole, so one left beside a skill would ship.
const ENGINE_FOLDERS = new Set(SKILL_FOLDERS.map((folder) => folder.split('/')[0]));
export const inEngineFolder = (file: string): boolean => file.split('/').some((part) => ENGINE_FOLDERS.has(part));
export const isSourceMap = (file: string): boolean => file.endsWith('.map');

// A path of the machine that built the package would tell every reader where it was built. The
// attribution lines are caught by pattern, with no list of names.
export const tracesMachine = (text: string, paths: readonly string[]): boolean =>
  paths.some((path) => text.includes(path)) || /generated with|co-authored-by/i.test(text);

// Vite emits a file the CSS points at as `<source name>.<hash>.<extension>`.
export const isFont = (file: string, source: string): boolean => new RegExp(`/${source}\\.[\\w-]+\\.woff2$`).test(file);

// The fonts ship with the app. A page that asks another address for a stylesheet, a font or a
// connection means a font host came back. A URL in the text alone, such as a placeholder, loads nothing.
export const loadsFromAnotherHost = (text: string): boolean =>
  /url\(\s*["']?(https?:)?\/\/|@import\s+(url\()?\s*["']?(https?:)?\/\/|<link[^>]+href=["']?(https?:)?\/\/|(https?:)?\/\/[^\s"'()]+\.(woff2?|ttf|otf)\b/i.test(text);

// A release names a version people install. 0.0.0 is the placeholder of a tree that was never
// released, and -dev is what a build of any commit but a release tag prints.
export function releaseRefusal(version: string): string | null {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return `The version ${JSON.stringify(version)} is not one npm takes.`;
  if (version.startsWith('0.0.0')) return `The version is ${version}, the placeholder of a tree that is not released. Set the release version in apps/local/package.json first.`;
  if (version.includes('-dev')) return `The version ${version} is a development build. Tag the release commit and build from it, so the version is plain.`;
  return null;
}

// Any value a CI service sets for CI, which is true, 1 or the service's own name. Empty, false and 0
// are a CI turned off.
export const inCi = (env: Record<string, string | undefined>): boolean =>
  env.GITHUB_ACTIONS === 'true' || !['', 'false', '0', undefined].includes(env.CI?.trim().toLowerCase());

// CI publishes nothing: the maintainer publishes `nolzu` to npm by hand, from a tagged and checked
// tree (AGENTS.md rule 9).
//
// A prerelease such as 0.2.0-rc.1 goes out only under a dist tag of its own (`--tag next`), so
// `npx nolzu@latest` never picks it. `built` is what the built command prints for `--version`: a build
// made before the tag, or a stale dist, prints another line, and that is refused too.
export function publishRefusal(version: string, env: Record<string, string | undefined>, built: string | null = null): string | null {
  if (inCi(env)) return 'CI never publishes the nolzu package. The maintainer publishes it from a tagged tree, as the release steps in CONTRIBUTING.md say.';
  const refused = releaseRefusal(version);
  if (refused !== null) return refused;
  if (version.includes('-') && (env.npm_config_tag ?? 'latest') === 'latest') return `${version} is a prerelease. Publish it with --tag next, so latest stays on the last release.`;
  if (built !== null && built !== `nolzu ${version}`) return `The built command prints "${built}", not "nolzu ${version}". Tag the release commit, then build again before publishing.`;
  return null;
}

// The oldest Node 22 at or above the user floor (22.16.0, `engines` in apps/local/package.json) among
// the installed versions, such as nvm's folder names, so the pack check starts the command on the
// lowest Node a user may have. Null when none is installed.
export function floorNode(versions: readonly string[], floor = '22.16.0'): string | null {
  const parts = (version: string) => version.replace(/^v/, '').split('.').map(Number);
  const [major, minor, patch] = parts(floor);
  const fits = versions.filter((version) => {
    const [a = 0, b = 0, c = 0] = parts(version);
    return /^v?\d+\.\d+\.\d+$/.test(version) && a === major && (b > minor! || (b === minor && c >= patch!));
  });
  return fits.sort((x, y) => {
    const [, xb = 0, xc = 0] = parts(x);
    const [, yb = 0, yc = 0] = parts(y);
    return xb - yb || xc - yc;
  })[0] ?? null;
}
