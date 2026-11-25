import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishRefusal } from './pack-rules.ts';

// `prepublishOnly` of the nolzu package, and run by hand before `npm publish` of the tarball, which
// runs no scripts (CONTRIBUTING.md, release steps): a publish of a placeholder or development version, a
// prerelease on latest, a build that prints another version, or one from CI, stops here with the reason.
const app = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { version: string };
const answer = spawnSync(process.execPath, [join(app, 'dist', 'nolzu.js'), '--version'], { encoding: 'utf8' });
// stdout only: Node prints its warnings, the SQLite one on Linux among them, on stderr. The last
// line, so nothing printed before the version line can pass for it.
const built = answer.status === 0 ? (answer.stdout.trim().split('\n').at(-1) ?? '') : `no answer (${answer.stderr.trim() || 'dist/nolzu.js did not run'})`;
const refused = publishRefusal(version, process.env, built);
if (refused !== null) {
  console.error(refused);
  process.exit(1);
}
