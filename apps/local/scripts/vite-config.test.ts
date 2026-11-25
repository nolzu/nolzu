import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { resolveConfig } from 'vite';
import { expect, it } from 'vitest';

// tokens.css loads the fonts from the ui package, which SvelteKit's list of folders the dev server may
// serve leaves out. Without the entry in vite.config.ts `vite dev` answers 403 and draws the system font.
const app = join(import.meta.dirname, '..');
const config = await resolveConfig({ root: app, configFile: join(app, 'vite.config.ts'), logLevel: 'silent' }, 'serve');
const fonts = join(dirname(createRequire(import.meta.url).resolve('@nolzu/ui/tokens.css')), 'fonts');
const served = (file: string) => config.server.fs.allow.some((folder) => !relative(folder, file).startsWith('..'));

it.each(['Geist-Variable.woff2', 'GeistMono-Variable.woff2'])('the dev server may serve %s', (file) => {
  expect(served(join(fonts, file))).toBe(true);
});
