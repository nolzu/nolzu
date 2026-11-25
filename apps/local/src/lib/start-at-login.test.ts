import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, openDatabase } from '@nolzu/core/node';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LOGIN_NOTE } from './getting-started.ts';
import { launchAgent, loginCommand, loginItemPath, loginSwitch, systemdUnit, systemLoginItem, turnOffAtLogin, turnOnAtLogin } from './start-at-login.ts';

let dir = '';
let home = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-login-item-'));
  home = mkdtempSync(join(tmpdir(), 'nolzu-login-home-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The press is the consent. Turn on calls the port once, and the offer is answered.
it('calls the login item once on Turn on, and closes the offer', async () => {
  const item = vi.fn(async () => null);

  expect(await turnOnAtLogin(db, item)).toBeNull();

  expect(item).toHaveBeenCalledTimes(1);
  expect(getSetting(db, 'seenNotes')).toEqual([LOGIN_NOTE]);
});

it('keeps the offer when the item could not be made, and says why', async () => {
  const item = vi.fn(async () => 'Nolzu could not write the login item. EACCES.');

  expect(await turnOnAtLogin(db, item)).toBe('Nolzu could not write the login item. EACCES.');
  expect(getSetting(db, 'seenNotes')).toEqual([]);
  expect(await turnOnAtLogin(db, null)).toMatch(/^Starting at login works only for a Nolzu the nolzu command started/);
  expect(getSetting(db, 'seenNotes')).toEqual([]);
});

// Nothing calls the port but the Turn on route: no page load, no snapshot and no first card does.
it('is turned on from one place only, the route Turn on posts to', () => {
  const root = new URL('../', import.meta.url).pathname;
  const callers = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|svelte)$/.test(file) && !file.endsWith('.test.ts') && !file.endsWith('start-at-login.ts'))
    .filter((file) => readFileSync(join(root, file), 'utf8').includes('turnOnAtLogin('));

  expect(callers).toEqual([join('routes', 'api', 'login-item', '+server.ts')]);
});

// The port itself is only asked whether it exists (`systemLoginItem() !== null`) outside the route.
it('never runs the port outside the route Turn on posts to', () => {
  const root = new URL('../', import.meta.url).pathname;
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => /\.(ts|svelte)$/.test(file) && !file.endsWith('.test.ts') && !file.endsWith('start-at-login.ts') && !file.includes('login-item'));
  const uses = files.flatMap((file) => [...readFileSync(join(root, file), 'utf8').matchAll(/systemLoginItem\(([^)]*)\)(.{0,9})/g)].map((one) => `${file}: ${one[0]}`));

  for (const use of uses) expect(use).toMatch(/systemLoginItem\(\) !== null$/);
});

it('writes a LaunchAgent that starts this nolzu without a browser, by absolute paths', () => {
  const plist = launchAgent(['/opt/node & co/bin/node', '/opt/nolzu/bin/nolzu.js', '--no-open']);

  expect(plist).toContain('<key>Label</key><string>com.nolzu.client</string>');
  expect(plist).toContain('<string>/opt/node &amp; co/bin/node</string>\n    <string>/opt/nolzu/bin/nolzu.js</string>\n    <string>--no-open</string>');
  expect(plist).toContain('<key>RunAtLoad</key><true/>');
});

// The real port, on a temp home: it writes one file there, and runs nothing.
it('writes the item only under the home it is given, for a server the nolzu command started', async () => {
  const argv = ['/opt/node', '/opt/nolzu/bin/nolzu.js'];
  expect(systemLoginItem('freebsd', home, argv, '/opt/node')).toBeNull();
  expect(systemLoginItem('darwin', home, ['/opt/node', '/opt/vite/bin/vite.js'], '/opt/node')).toBeNull();

  const item = systemLoginItem('darwin', home, argv, '/opt/node');
  expect(await item?.()).toBeNull();

  const path = join(home, 'Library', 'LaunchAgents', 'com.nolzu.client.plist');
  expect(readFileSync(path, 'utf8')).toBe(launchAgent(['/opt/node', '/opt/nolzu/bin/nolzu.js', '--no-open']));
  expect(existsSync(join(home, 'Library', 'LaunchAgents'))).toBe(true);
});

it('writes a systemd user unit that starts this nolzu without a browser, by absolute paths', () => {
  const unit = systemdUnit(['/opt/node 100%/bin/node', '/opt/nolzu/bin/nolzu.js', '--no-open']);

  // systemd unquotes the line itself, so each part is quoted and its % specifier doubled.
  expect(unit).toContain('\nExecStart="/opt/node 100%%/bin/node" "/opt/nolzu/bin/nolzu.js" "--no-open"\n');
  expect(unit).toContain('[Install]\nWantedBy=default.target\n');
  expect(systemdUnit(['/a\\b"c$d'])).toContain('ExecStart="/a\\\\b\\"c$$d"');
});

// A global install and a clone run as they are. A copy npx started lives in npm's cache, which npm may
// clear, so the item asks npx for the newest one, by paths beside node, with node's folder on PATH.
it('runs this copy at login, or npx with @latest for a copy in the npx cache', () => {
  expect(loginCommand('/opt/node/bin/node', '/opt/node/lib/node_modules/nolzu/dist/nolzu.js')).toEqual({ command: ['/opt/node/bin/node', '/opt/node/lib/node_modules/nolzu/dist/nolzu.js', '--no-open'], path: null });
  expect(loginCommand('/opt/node/bin/node', '/src/nolzu/apps/local/bin/nolzu.js')).toEqual({ command: ['/opt/node/bin/node', '/src/nolzu/apps/local/bin/nolzu.js', '--no-open'], path: null });
  expect(loginCommand('/opt/node/bin/node', '/home/me/.npm/_npx/1a2b3c/node_modules/nolzu/dist/nolzu.js')).toEqual({
    command: ['/opt/node/bin/node', '/opt/node/bin/npx', '--yes', 'nolzu@latest', '--no-open'],
    path: '/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  });
  // Only a folder named _npx, not a name that holds it.
  expect(loginCommand('/opt/node/bin/node', '/home/me/my_npx/nolzu/dist/nolzu.js').path).toBeNull();
});

it('sets PATH in the LaunchAgent and the unit only when it is given', () => {
  expect(launchAgent(['/n'])).not.toContain('EnvironmentVariables');
  expect(launchAgent(['/n'], '/opt/a&b:/usr/bin')).toContain('  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key><string>/opt/a&amp;b:/usr/bin</string>\n  </dict>\n  <key>RunAtLoad</key>');
  expect(systemdUnit(['/n'])).not.toContain('Environment=');
  expect(systemdUnit(['/n'], '/opt/100%:/usr/bin')).toContain('[Service]\nEnvironment="PATH=/opt/100%%:/usr/bin"\nExecStart="/n"\n');
  // Environment= expands no variables, so its $ stays single while ExecStart doubles it.
  expect(systemdUnit(['/a$b'], '/opt/$x/"q"\\')).toContain('Environment="PATH=/opt/$x/\\"q\\"\\\\"\nExecStart="/a$$b"');
});

// The real port on a temp home, for a copy npx started: the item names the npx beside node, and there
// is no item to offer where that npx is missing.
it('writes an item that runs npx for an npx copy, and offers none with no npx beside node', async () => {
  const bin = join(home, 'node', 'bin');
  mkdirSync(bin, { recursive: true });
  const argv = ['/n', join(home, '.npm', '_npx', '1a2b3c', 'node_modules', 'nolzu', 'dist', 'nolzu.js')];
  expect(systemLoginItem('darwin', home, argv, join(bin, 'node'))).toBeNull();

  writeFileSync(join(bin, 'npx'), '');
  expect(await systemLoginItem('darwin', home, argv, join(bin, 'node'))?.()).toBeNull();

  expect(readFileSync(join(home, 'Library', 'LaunchAgents', 'com.nolzu.client.plist'), 'utf8')).toBe(
    launchAgent([join(bin, 'node'), join(bin, 'npx'), '--yes', 'nolzu@latest', '--no-open'], `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`),
  );
});

// Where each system reads its login items: launchd and the systemd user manager.
it.each([
  ['darwin', ['Library', 'LaunchAgents', 'com.nolzu.client.plist']],
  ['linux', ['.config', 'systemd', 'user', 'nolzu.service']],
])('keeps the %s item under the home it is given', (platform, at) => {
  expect(loginItemPath(platform, home)).toBe(join(home, ...at));
});

// The switch, on a temp home for each system: On writes the item, the switch reads it back, Off removes it.
it.each([
  ['darwin', launchAgent],
  ['linux', systemdUnit],
])('turns the %s item on and off, and the switch shows whether it is there', async (platform, file) => {
  const argv = ['/opt/node', '/opt/nolzu/bin/nolzu.js'];
  const path = loginItemPath(platform, home) ?? '';
  expect(loginSwitch(platform, home, argv)).toEqual({ on: false, canTurnOn: true, path: path.replace(home, '~') });

  expect(await turnOnAtLogin(db, systemLoginItem(platform, home, argv, '/opt/node'))).toBeNull();

  expect(readFileSync(path, 'utf8')).toBe(file(['/opt/node', '/opt/nolzu/bin/nolzu.js', '--no-open']));
  expect(loginSwitch(platform, home, argv).on).toBe(true);

  expect(await turnOffAtLogin(platform, home)).toBeNull();

  expect(existsSync(path)).toBe(false);
  expect(loginSwitch(platform, home, argv).on).toBe(false);
  // Off twice is still off, with nothing to remove.
  expect(await turnOffAtLogin(platform, home)).toBeNull();
});

// What systemctl --user enable would do, done by hand: the link in default.target.wants. Without it the
// unit sits there and nothing starts it.
it('enables the Linux unit with the link systemctl would make, and Off removes both', async () => {
  const unit = join(home, '.config', 'systemd', 'user', 'nolzu.service');
  const link = join(home, '.config', 'systemd', 'user', 'default.target.wants', 'nolzu.service');

  expect(await systemLoginItem('linux', home, ['/opt/node', '/opt/nolzu/bin/nolzu.js'], '/opt/node')?.()).toBeNull();
  // On again over an item already there writes it once more, link and all.
  expect(await systemLoginItem('linux', home, ['/opt/node', '/opt/nolzu/bin/nolzu.js'], '/opt/node')?.()).toBeNull();

  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(unit);

  // A unit with no link starts nothing, so the switch shows it off.
  rmSync(link);
  expect(loginSwitch('linux', home, []).on).toBe(false);

  expect(await turnOffAtLogin('linux', home)).toBeNull();
  expect(existsSync(unit)).toBe(false);
});

// Off at a fresh start on every system, and On only for a server the nolzu command started. Off stays
// open while an item is there, so a person can always take it away.
it('is off on a fresh home, and can be turned on only for a server the nolzu command started', () => {
  for (const platform of ['darwin', 'linux']) {
    expect(loginSwitch(platform, home, ['/opt/node', '/opt/vite/bin/vite.js'])).toMatchObject({ on: false, canTurnOn: false });
  }
  expect(loginSwitch('win32', home, ['/opt/node', '/opt/nolzu/bin/nolzu.js'])).toEqual({ on: false, canTurnOn: false, path: null });
  expect(loginSwitch('freebsd', home, ['/opt/node', '/opt/nolzu/bin/nolzu.js'])).toEqual({ on: false, canTurnOn: false, path: null });
});

// Nothing turns it on by itself. The item lives on disk and nowhere in the database,
// so no migration or update can set it, and these are the only modules that reach the writers: New
// project, the first task, the first card, the server start and the launcher import none of them.
it('is reached only by the route a press posts to, the rail offer and the settings page', () => {
  const repo = new URL('../../../../', import.meta.url).pathname;
  // The packages cannot import the app (the ESLint boundaries), so the app and its launcher are all of it.
  const roots = ['apps/local/src', 'apps/local/bin'];
  const files = roots.flatMap((root) => readdirSync(join(repo, root), { recursive: true, encoding: 'utf8' }).map((file) => join(root, file)));
  const importers = files.filter((file) => /\.(ts|js|svelte)$/.test(file) && !file.includes('.test.') && readFileSync(join(repo, file), 'utf8').includes('start-at-login.ts'));

  expect(importers.sort()).toEqual(['apps/local/src/lib/coach.ts', 'apps/local/src/routes/api/login-item/+server.ts', 'apps/local/src/routes/settings/[section]/+page.server.ts']);
  // The settings page only reads the switch, and Off has the one caller On has.
  const offCallers = importers.filter((file) => readFileSync(join(repo, file), 'utf8').includes('turnOffAtLogin('));
  expect(offCallers).toEqual(['apps/local/src/routes/api/login-item/+server.ts']);
});
