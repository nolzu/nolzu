import { existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting } from '@nolzu/core/node';
import { LOGIN_NOTE } from './getting-started.ts';
import { homePath } from './home-path.ts';
import { storeSetting } from './settings-page.ts';

// The one change On makes to the machine: a login item that starts Nolzu at the next login. A port, so
// a test hands in a fake and nothing else reaches the real one. It answers null when the item is in
// place, or the sentence that says why not. The item on disk is the whole setting: no database row
// holds it, so no update or migration can turn it on, and the switch reads the disk.
export type LoginItem = () => Promise<string | null>;

export const LAUNCH_AGENT = 'com.nolzu.client';

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A macOS LaunchAgent that runs the command once at login, with PATH set when `path` is given. launchd
// reads ~/Library/LaunchAgents by itself at the next login, so nothing runs launchctl now: Nolzu is
// running already.
export function launchAgent(command: readonly string[], path: string | null = null): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCH_AGENT}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...command.map((part) => `    <string>${xml(part)}</string>`),
    '  </array>',
    ...(path === null ? [] : ['  <key>EnvironmentVariables</key>', '  <dict>', `    <key>PATH</key><string>${xml(path)}</string>`, '  </dict>']),
    '  <key>RunAtLoad</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// systemd unquotes ExecStart itself, so each part goes in double quotes with its specifiers (%) and
// variables ($) doubled.
const UNIT_ESCAPES: Readonly<Record<string, string>> = { '\\': '\\\\', '"': '\\"', '%': '%%', $: '$$' };

// A systemd user unit, with PATH set when `path` is given.
export function systemdUnit(command: readonly string[], path: string | null = null): string {
  const word = (part: string) => `"${part.replace(/[\\"%$]/g, (one) => UNIT_ESCAPES[one] ?? one)}"`;
  // Environment= expands no variables, so a $ there stays as it is.
  const setting = (part: string) => `"${part.replace(/[\\"%]/g, (one) => UNIT_ESCAPES[one] ?? one)}"`;
  return [
    '[Unit]',
    'Description=Nolzu',
    '# Written by Start Nolzu when I log in, in Settings. Turn that off to remove it.',
    '',
    '[Service]',
    ...(path === null ? [] : [`Environment=${setting(`PATH=${path}`)}`]),
    `ExecStart=${command.map(word).join(' ')}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// Where each system reads its login items at the next login, under the home folder, and what goes there.
// Limit: ~/.config and not $XDG_CONFIG_HOME. It is rare, and reading the environment here would let
// a test reach the real one.
const ITEMS: Readonly<Record<string, { at: readonly string[]; file: (command: readonly string[], path: string | null) => string }>> = {
  darwin: { at: ['Library', 'LaunchAgents', `${LAUNCH_AGENT}.plist`], file: launchAgent },
  linux: { at: ['.config', 'systemd', 'user', 'nolzu.service'], file: systemdUnit },
};

export function loginItemPath(platform: string, home: string): string | null {
  const item = ITEMS[platform];
  return item === undefined ? null : join(home, ...item.at);
}

// The files that make the item. On Linux the link `systemctl --user enable` would make, written by hand
// so nothing runs systemctl: the user manager follows default.target.wants at the next login.
function itemFiles(platform: string, home: string): string[] {
  const path = loginItemPath(platform, home);
  if (path === null) return [];
  return platform === 'linux' ? [path, join(dirname(path), 'default.target.wants', basename(path))] : [path];
}

/**
 * What the item runs. A copy npx started sits in npm's cache, `_npx/<hash>/node_modules`, which npm may
 * clear and which never updates, so the item runs npx with @latest instead, as the person starts it.
 * The item has no shell, so it names npx by its path beside node, and `path` puts node's folder on PATH
 * for the nolzu command npx starts with `#!/usr/bin/env node`. A global install or a clone runs as it is.
 */
export function loginCommand(node: string, bin: string): { command: string[]; path: string | null } {
  if (!bin.split(/[\\/]/).includes('_npx')) return { command: [node, bin, '--no-open'], path: null };
  return { command: [node, join(dirname(node), 'npx'), '--yes', 'nolzu@latest', '--no-open'], path: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin` };
}

/**
 * The login item of this machine, or null where On cannot work, so neither the rail nor the switch offers it.
 *
 * Only for a server the nolzu command started, so the item starts that same command, by absolute
 * paths, with `--no-open` (`loginCommand`). A development server is not one, and neither is an npx
 * copy with no npx beside node. No system command runs on any system:
 * launchd and the systemd user manager each read their folder by themselves at the next login.
 */
export function systemLoginItem(platform: string = process.platform, home = homedir(), argv: readonly string[] = process.argv, node = process.execPath): LoginItem | null {
  const bin = argv[1];
  const item = ITEMS[platform];
  const [path, link] = itemFiles(platform, home);
  if (item === undefined || path === undefined || bin === undefined || !/^nolzu(\.js)?$/.test(basename(bin))) return null;
  const run = loginCommand(node, bin);
  if (run.path !== null && !existsSync(run.command[1] ?? '')) return null;
  return async () => {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, item.file(run.command, run.path));
      if (link !== undefined) {
        await mkdir(dirname(link), { recursive: true });
        await rm(link, { force: true });
        await symlink(path, link);
      }
      return null;
    } catch (error) {
      return `Nolzu could not write the login item. ${(error as Error).message}`;
    }
  };
}

// Off on the switch: the item and its link go. Nothing there is off already. Off works wherever an item
// can be, so a person can take it away even from a server that could not have written it.
export async function turnOffAtLogin(platform: string = process.platform, home = homedir()): Promise<string | null> {
  try {
    for (const file of itemFiles(platform, home)) await rm(file, { force: true });
    return null;
  } catch (error) {
    return `Nolzu could not remove the login item. ${(error as Error).message}`;
  }
}

export interface LoginSwitch {
  // Whether the item is in place now. The switch shows this and nothing else.
  on: boolean;
  canTurnOn: boolean;
  // The item's file with home as ~, which the row names, or null on a system with no item.
  path: string | null;
}

// What the switch in Settings shows, read off the disk on each load.
export function loginSwitch(platform: string = process.platform, home = homedir(), argv: readonly string[] = process.argv): LoginSwitch {
  const files = itemFiles(platform, home);
  return {
    on: files.length > 0 && files.every((file) => existsSync(file)),
    canTurnOn: systemLoginItem(platform, home, argv) !== null,
    path: files[0] === undefined ? null : homePath(files[0], home),
  };
}

// Turn on under "Start Nolzu when you log in?", and On on the switch in Settings. The press is the
// consent, so the route both post to is the one caller. The offer is answered once
// the item is in place, and stays while it is not.
export async function turnOnAtLogin(db: DatabaseSync, item: LoginItem | null): Promise<string | null> {
  if (item === null) return 'Starting at login works only for a Nolzu the nolzu command started, on macOS or Linux.';
  const refused = await item();
  if (refused !== null) return refused;
  const seen = getSetting(db, 'seenNotes');
  return seen.includes(LOGIN_NOTE) ? null : storeSetting(db, 'seenNotes', [...seen, LOGIN_NOTE]);
}
