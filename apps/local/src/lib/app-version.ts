// What the build knows about itself. vite.config.ts fills it in at build time from package.json and
// git, so the app never runs git. `commit` is null for a tagged release and when git was missing.
export type AppBuild = { version: string; commit: string | null; date: string };

// Replaced by the build. Tests run without the vite config, so they get the fallback below.
declare const __NOLZU_BUILD__: AppBuild | undefined;

export const APP_BUILD: AppBuild = typeof __NOLZU_BUILD__ === 'undefined' ? { version: '0.0.0', commit: null, date: '' } : __NOLZU_BUILD__;

// The rule the build applies, kept here so a test can hand it a fake git. `git` returns null when git
// fails or is missing. A commit on a release tag shows the plain version; any other commit shows
// its short hash. No git, no hash.
export function readBuild(version: string, git: (args: string[]) => string | null, date: string): AppBuild {
  const tagged = git(['describe', '--tags', '--exact-match']) !== null;
  return { version, commit: tagged ? null : git(['rev-parse', '--short', 'HEAD']), date };
}

// Nolzu is in beta until 1.0.0, and the rail says so beside the version. The site shows the same pill.
export const isBeta = (version: string): boolean => Number(version.split('.')[0]) < 1;

// The quiet text beside the logo, and the full line for the hover tip and screen readers.
export function versionLine(build: AppBuild): { short: string; full: string } {
  const short = build.commit === null ? build.version : `${build.version}-dev · ${build.commit}`;
  return { short, full: build.date === '' ? `Nolzu ${short}` : `Nolzu ${short}, built ${build.date}` };
}
