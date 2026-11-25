import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { recordPackages } from './notices.ts';
import { readBuild } from './src/lib/app-version.ts';
import { quietProbe } from './src/lib/devtools-probe.ts';

// The dev server serves a file outside the app only from an allowed folder, and SvelteKit's list
// leaves out the workspace packages. Without this entry `vite dev` answers 403 for the fonts and the
// page falls back to the system stack. The build is not affected.
const fonts = join(dirname(createRequire(import.meta.url).resolve('@nolzu/ui/tokens.css')), 'fonts');

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

// The version line beside the logo, decided here so the running app needs no git.
const { version } = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')) as { version: string };
const build = readBuild(version, git, new Date().toISOString().slice(0, 10));
// vite.bin.config.ts takes the same line, so `nolzu --version` prints what the rail shows.
export const buildDefine = { __NOLZU_BUILD__: JSON.stringify(build) };

export default defineConfig({
  // Before sveltekit(), so the dev server answers Chrome's DevTools probe empty and SvelteKit never sees it.
  plugins: [{ name: 'nolzu-quiet-devtools-probe', configureServer: (server) => void server.middlewares.use(quietProbe) }, sveltekit(), recordPackages()],
  define: buildDefine,
  server: { fs: { allow: [fonts] } },
});
