import { cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vite';
import { recordPackages, writeNotices } from './notices.ts';
import { buildDefine } from './vite.config.ts';

// The skills package as it is installed here, found the same way the server finds it in a clone.
const require = createRequire(import.meta.url);
const skills = dirname(require.resolve('@nolzu/skills/package.json'));
const fonts = join(dirname(require.resolve('@nolzu/ui/tokens.css')), 'fonts');

// The nolzu command as plain JavaScript in dist/, with every workspace package it uses inside it.
// Node strips no TypeScript under node_modules, so an installed copy cannot run bin/nolzu.js as it is.
// Run it after the app build: the app build empties build/, and this one empties dist/.
export default defineConfig({
  build: {
    ssr: 'bin/nolzu.js',
    outDir: 'dist',
    // The user floor, `engines` in package.json: the bundle may use nothing newer.
    target: 'node22.16',
    // Chunks beside the entry and not in assets/, because `start.js` finds package.json and build/ from
    // its own folder.
    rolldownOptions: { output: { entryFileNames: 'nolzu.js', chunkFileNames: '[name]-[hash].js' } },
  },
  ssr: { noExternal: true },
  define: buildDefine,
  plugins: [
    recordPackages(),
    {
      // The server reads these files at run time, and the installed copy has no skills package to read them from.
      // The app build emits the font files but not their license, which the OFL says travels with them.
      name: 'copy-files',
      closeBundle() {
        for (const folder of ['skills', 'shared']) cpSync(join(skills, folder), join(import.meta.dirname, 'dist', folder), { recursive: true });
        cpSync(join(fonts, 'OFL.txt'), join(import.meta.dirname, 'dist', 'fonts', 'OFL.txt'));
        writeNotices(join(import.meta.dirname, 'dist'));
      },
    },
  ],
});
