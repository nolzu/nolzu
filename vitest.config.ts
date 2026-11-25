import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { configDefaults, defineConfig } from 'vitest/config';

// Inline projects, because a project found by a folder glob inherits no root options, and
// every project needs the setup file that guards the live data directory. A project with its
// own config file would lose that setup the same way, so the Svelte plugin is added here
// instead of in a second config file.
const packages = readdirSync(join(import.meta.dirname, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

// configFile false, because the package holds components and not a SvelteKit app, so there is
// no svelte.config.js to find and searching for one would reach the app's Kit config.
const svelteProjects = new Set(['ui']);

const MOUNTED = 'src/**/*.mount.test.ts';

// What the app's own tests resolve. `$lib` is the alias SvelteKit gives the app, so a route file can
// be imported and its load and actions tested. `$app/*` exists only under the SvelteKit vite plugin,
// which these tests do not run, so without a stub a route `+page.svelte` cannot be imported at all
// and its headings, its links and its branches reach no test.
//
// Only the modules a rendered or mounted page needs. `$app/state` and `$app/navigation` landed with
// the first test that mounts a page using them, the board page. A stub written before its test is a
// promise nobody checked. `$app/environment` is not imported anywhere in this repository.
const appAliases = {
  $lib: join(import.meta.dirname, 'apps', 'local', 'src', 'lib'),
  '$app/paths': join(import.meta.dirname, 'test', 'stubs', 'app-paths.ts'),
  '$app/forms': join(import.meta.dirname, 'test', 'stubs', 'app-forms.ts'),
  '$app/state': join(import.meta.dirname, 'test', 'stubs', 'app-state.ts'),
  '$app/navigation': join(import.meta.dirname, 'test', 'stubs', 'app-navigation.ts'),
};

export default defineConfig({
  test: {
    globalSetup: [join(import.meta.dirname, 'vitest.global-setup.ts')],
    setupFiles: [join(import.meta.dirname, 'vitest.setup.ts')],
    // Twenty seconds, not vitest's five. Many suites here spawn a real process: a stub engine, git
    // in a temp repository, a stack hook, the guard as a child. Alone each one takes well under a
    // second, and with every project running at once a process start can take several, which once made
    // several tests fail together while each passed on its own. A test that waits longer
    // costs seconds on a slow machine; a test that times out costs a red main and an hour of
    // reading. A test that really hangs still fails, just later.
    testTimeout: 20_000,
    projects: [
      ...packages.map((name) => ({
        plugins: svelteProjects.has(name) ? [svelte({ configFile: false })] : [],
        test: {
          name: `@nolzu/${name}`,
          root: join(import.meta.dirname, 'packages', name),
          // A mounted test needs a DOM and the browser build of Svelte, so it runs in the project below.
          exclude: [...configDefaults.exclude, MOUNTED],
        },
      })),
      // Components mounted for real, for what a server render cannot reach: a click, an effect, a
      // focus. The browser condition is what makes `svelte` resolve to the build where mount and
      // flushSync do something. Under the server build both are silent no-ops, so a mounted test
      // there passes while testing nothing.
      {
        plugins: [svelte({ configFile: false })],
        resolve: { conditions: ['browser'] },
        test: {
          name: '@nolzu/ui-mounted',
          root: join(import.meta.dirname, 'packages', 'ui'),
          include: [MOUNTED],
          environment: 'jsdom',
        },
      },
      // The root, the root scripts, and the `$app` stubs under test/, which belong to no app and no package.
      { test: { name: 'workspace', include: ['*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'] } },
      // The app was in no project, so a test written there ran nowhere. The include list is
      // explicit, so the build output and the Kit cache are never scanned.
      {
        // The app's tests may import @nolzu/ui, whose barrel carries components. configFile false
        // for the same reason as above: these tests compile the package's components, not the app.
        plugins: [svelte({ configFile: false })],
        resolve: { alias: appAliases },
        test: {
          name: '@nolzu/local',
          root: join(import.meta.dirname, 'apps', 'local'),
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [...configDefaults.exclude, MOUNTED],
        },
      },
      // The app's own components mounted for real. A <svelte:boundary> is what a server render
      // cannot show: on the server it rethrows, so only a mounted test proves a feature that
      // throws while it draws leaves the app up.
      {
        plugins: [svelte({ configFile: false })],
        resolve: { alias: appAliases, conditions: ['browser'] },
        test: {
          name: '@nolzu/local-mounted',
          root: join(import.meta.dirname, 'apps', 'local'),
          include: [MOUNTED],
          environment: 'jsdom',
        },
      },
    ],
  },
});
