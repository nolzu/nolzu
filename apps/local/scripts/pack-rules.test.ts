import { expect, it } from 'vitest';
import { floorNode, inEngineFolder, isFont, isSourceMap, isTestFile, loadsFromAnotherHost, outsideTheApp, publishRefusal, releaseRefusal, tracesMachine } from './pack-rules.ts';

// The build copies the skill folders into dist/ whole, and the first rule lets anything under dist/
// through. So a test file or an engine folder such as .claude/ next to a skill is stopped by its own rule or by none.
it.each([
  ['package/dist/skills/nolzu-refine/refine.test.ts', isTestFile],
  ['package/build/server/chunks/board.spec.js', isTestFile],
  ['package/dist/skills/.claude/settings.json', inEngineFolder],
  ['package/dist/skills/.agents/skills/nolzu-refine/SKILL.md', inEngineFolder],
  ['package/build/index.js.map', isSourceMap],
  ['package/src/lib/bin.ts', outsideTheApp],
])('stops %s', (file, rule) => {
  expect(rule(file)).toBe(true);
});

// The app build emits each font under a hashed name, and the bin build copies the font license.
it.each(['package/build/client/_app/immutable/assets/Geist-Variable.Ab1-_x.woff2', 'package/dist/fonts/OFL.txt'])('lets %s through', (file) => {
  expect([outsideTheApp, isTestFile, inEngineFolder, isSourceMap].some((rule) => rule(file))).toBe(false);
});

// The hash can hold `-` and `_`, and one name must not stand in for the other.
it.each([
  ['package/build/client/_app/immutable/assets/Geist-Variable.Ab1-_x.woff2', 'Geist-Variable', true],
  ['http://localhost:5330/_app/immutable/assets/GeistMono-Variable.C9_d-e.woff2', 'GeistMono-Variable', true],
  ['package/build/client/_app/immutable/assets/GeistMono-Variable.C9_d-e.woff2', 'Geist-Variable', false],
  ['package/build/client/_app/immutable/assets/Geist-Variable.Ab1-_x.woff2', 'GeistMono-Variable', false],
  ['package/build/client/_app/immutable/assets/NotGeist-Variable.Ab1-_x.woff2', 'Geist-Variable', false],
])('isFont(%s, %s) is %s', (file, source, expected) => {
  expect(isFont(file, source)).toBe(expected);
});

it.each([
  '<link href="https://fonts.example.com/css2?family=Geist" rel="stylesheet">',
  '<link rel="preconnect" href="//fonts.example.com">',
  '<LINK REL="stylesheet" HREF="HTTPS://FONTS.EXAMPLE.COM/CSS2">',
  '@font-face{src:url(https://cdn.example.com/geist.woff2)format("woff2")}',
  '@import url("//cdn.example.com/fonts.css");',
  '@import "//cdn.example.com/fonts.css";',
  '<script>const font = "https://cdn.example.com/GeistMono.ttf";</script>',
])('flags a page that asks another host for a stylesheet, a font or a connection: %s', (text) => {
  expect(loadsFromAnotherHost(text)).toBe(true);
});

// The onboarding page shows a remote URL as a placeholder, and that loads nothing.
it.each([
  '@font-face{src:url(./Geist-Variable.Ab1-_x.woff2)format("woff2")}',
  '<link href="./_app/immutable/assets/0.gkeYphg-.css" rel="stylesheet">',
  '<input placeholder="https://example.com/team/api.git">',
])('lets a page through that loads only from itself: %s', (text) => {
  expect(loadsFromAnotherHost(text)).toBe(false);
});

// On this machine the repository is under the home, but a packed file can name either one alone: a
// cache under the home, or a repository cloned somewhere else.
it.each(['/home/dev/.npm/_cacache', '/work/nolzu/packages/core'])('flags a packed file that names %s', (path) => {
  expect(tracesMachine(`const from = "${path}/index.js";`, ['/work/nolzu', '/home/dev'])).toBe(true);
});

// Release mode of pack:check and the publish guard: a placeholder or a development build never ships.
it.each(['0.0.0', '0.0.0-1', '0.1.0-dev', '0.1.0-dev.3', '0.1', 'v0.1.0', ''])('refuses to release %s', (version) => {
  expect(releaseRefusal(version)).not.toBeNull();
});

it.each(['0.1.0', '1.2.3', '0.1.0-rc.1'])('releases %s', (version) => {
  expect(releaseRefusal(version)).toBeNull();
});

it('refuses every publish from CI, and a local one of a release version passes', () => {
  expect(publishRefusal('0.1.0', { GITHUB_ACTIONS: 'true' })).toMatch(/^CI never publishes the nolzu package/);
  // A CI service sets CI to true, to 1 or to its own name.
  for (const value of ['true', '1', 'woodpecker', 'TRUE']) expect(publishRefusal('0.1.0', { CI: value }), value).toMatch(/^CI never/);
  for (const value of ['', 'false', '0', 'False']) expect(publishRefusal('0.1.0', { CI: value }), value).toBeNull();
  expect(publishRefusal('0.0.0', {})).toMatch(/0\.0\.0/);
  expect(publishRefusal('0.1.0', {})).toBeNull();
});

// A prerelease never lands on latest, which `npx nolzu@latest` reads.
it('publishes a prerelease only under a dist tag of its own', () => {
  expect(publishRefusal('0.2.0-rc.1', {})).toMatch(/--tag next/);
  expect(publishRefusal('0.2.0-rc.1', { npm_config_tag: 'latest' })).toMatch(/--tag next/);
  expect(publishRefusal('0.2.0-rc.1', { npm_config_tag: 'next' })).toBeNull();
});

// A build made before the tag prints the -dev line, and a stale dist prints an older version.
it('refuses a build that prints another version than the one published', () => {
  expect(publishRefusal('0.1.0', {}, 'nolzu 0.1.0')).toBeNull();
  expect(publishRefusal('0.1.0', {}, 'nolzu 0.1.0-dev · 3f2a9c1')).toMatch(/^The built command prints "nolzu 0\.1\.0-dev · 3f2a9c1"/);
  expect(publishRefusal('0.1.0', {}, 'nolzu 0.0.9')).toMatch(/build again/);
});

// The pack check starts the command on the lowest Node a user may have.
it('picks the oldest Node 22 at or above the floor', () => {
  expect(floorNode(['v18.19.1', 'v20.11.0', 'v22.15.0', 'v22.17.0', 'v22.16.0', 'v24.21.0'])).toBe('v22.16.0');
  expect(floorNode(['v22.15.0', 'v22.17.0', 'v24.21.0'])).toBe('v22.17.0');
  expect(floorNode(['v22.18.2', 'v22.9.0'])).toBe('v22.18.2');
  expect(floorNode(['v24.21.0', 'v22.15.0', 'v20.11.0'])).toBeNull();
  expect(floorNode(['v22.18.2', 'v22.18.1'])).toBe('v22.18.1');
  expect(floorNode(['v22.16.2', 'v22.16.9'], '22.16.5')).toBe('v22.16.9');
  expect(floorNode(['.DS_Store', 'v22', 'v22.17.0-rc.1'])).toBeNull();
});
