import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { CLOUD_OPEN } from '@nolzu/protocol';
import { SKILL_FOLDERS } from '@nolzu/runner';
import { freePort, NO_ACCOUNT, platformWarning, readRecord, versionOutput } from '../src/lib/bin.ts';
import { floorNode, inEngineFolder, isFont, isSourceMap, isTestFile, loadsFromAnotherHost, outsideTheApp, releaseRefusal, tracesMachine } from './pack-rules.ts';

// The client as a release publishes it: packed, installed with npm install -g into an empty prefix,
// asked for its help, started on the fake engine through the nolzu link, and started a second time,
// which opens the first. The script is the check: it exits 1 on any failure.
//
// Release mode (`--release`, or NOLZU_RELEASE=1) is the check before a publish: it also fails on a
// placeholder or development version, in the manifest and in what the installed command prints.
const release = process.argv.includes('--release') || process.env.NOLZU_RELEASE === '1';

const app = join(import.meta.dirname, '..');
const repository = join(app, '..', '..');

for (const built of ['build/index.js', 'dist/nolzu.js']) {
  if (!existsSync(join(app, built))) {
    console.error(`apps/local/${built} is missing. Run corepack pnpm build first.`);
    process.exit(1);
  }
}

const failures: string[] = [];
const check = (what: string, ok: boolean) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

// Under the system temp folder and never inside the repository, or a missing file would be found in
// the repository's own node_modules and the check would pass on a broken package.
const scratch = mkdtempSync(join(tmpdir(), 'nolzu-pack-'));
const home = join(scratch, 'home');
// What npm install -g fills: lib/node_modules/nolzu and the bin/nolzu link, on Linux and macOS.
const prefix = join(scratch, 'global');
mkdirSync(home);

// Nothing of this machine reaches the install or the app: a new home, an empty npm cache, and a
// registry address where nothing listens, so an install that needs any registry fails. The new home
// has no git config, so the workspace commit below gets its author here.
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(npm_|NOLZU_)/i.test(name) && name !== 'NODE_PATH'));
const env = {
  ...clean,
  HOME: home,
  USERPROFILE: home,
  GIT_AUTHOR_NAME: 'Pack Check',
  GIT_AUTHOR_EMAIL: 'pack-check@example.com',
  GIT_COMMITTER_NAME: 'Pack Check',
  GIT_COMMITTER_EMAIL: 'pack-check@example.com',
  npm_config_cache: join(scratch, 'npm-cache'),
  npm_config_registry: 'http://127.0.0.1:9',
  npm_config_update_notifier: 'false',
};

// Linux writes its not-tested warning on every start, so the checks read what is said besides it.
const warning = platformWarning(process.platform);

const run = (command: string, args: string[], cwd: string, runEnv: NodeJS.ProcessEnv = env) => {
  const result = spawnSync(command, args, { cwd, env: runEnv, encoding: 'utf8' });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`;
  return { ok: result.status === 0, out: warning === null ? out : out.replace(`${warning}\n`, '') };
};

const filesUnder = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

try {
  // The pnpm that runs this script, so a clone never needs a second pnpm on PATH.
  const packed = run(process.env.npm_execpath ?? 'pnpm', ['pack', '--pack-destination', scratch], app, process.env);
  const tarball = readdirSync(scratch).find((name) => name.endsWith('.tgz'));
  check('pnpm pack writes a tarball', packed.ok && tarball !== undefined);
  if (tarball === undefined) throw new Error(packed.out);

  const listed = run('tar', ['-tzf', join(scratch, tarball)], scratch).out.trim().split('\n');
  console.log(`${tarball}: ${listed.length} files`);
  check('the tarball holds only package.json, README.md, LICENSE, build/ and dist/', !listed.some(outsideTheApp));
  check('the tarball holds no test file', !listed.some(isTestFile));
  check('the tarball holds no .claude/ or .agents/ folder', !listed.some(inEngineFolder));
  check('the tarball holds no source map', !listed.some(isSourceMap));
  for (const file of ['README.md', 'LICENSE', 'dist/nolzu.js', 'build/index.js', 'dist/skills/nolzu-refine/SKILL.md', 'dist/shared/finish.md', 'dist/fonts/OFL.txt', 'dist/THIRD-PARTY-NOTICES.md']) {
    check(`the tarball holds ${file}`, listed.includes(`package/${file}`));
  }
  for (const font of ['Geist-Variable', 'GeistMono-Variable']) {
    check(`the tarball holds the ${font} font`, listed.some((file) => file.startsWith('package/build/client/_app/immutable/assets/') && isFont(file, font)));
  }

  // The way a person installs it, into a prefix of its own so nothing of this machine's global
  // packages is read or changed.
  const installed = run('npm', ['install', '--global', '--prefix', prefix, join(scratch, tarball), '--offline', '--no-audit', '--no-fund', '--ignore-scripts'], scratch);
  check('npm install -g installs the tarball into an empty prefix with no registry', installed.ok);
  if (!installed.ok) throw new Error(installed.out);

  const unpacked = join(prefix, 'lib', 'node_modules', 'nolzu');
  const manifest = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8')) as { name: string; version: string; dependencies?: Record<string, string> };
  check('the package is named nolzu', manifest.name === 'nolzu');
  check('the package depends on nothing, so no @nolzu package is fetched', Object.keys(manifest.dependencies ?? {}).length === 0);
  check('the manifest has no workspace: range left', !JSON.stringify(manifest).includes('workspace:'));

  const local = [repository, userInfo().homedir];
  const leaks = filesUnder(unpacked).filter((file) => tracesMachine(readFileSync(file, 'latin1'), local));
  check('no packed file names a path of this machine or carries an attribution line', leaks.length === 0);
  for (const file of leaks) console.log(`     ${file.slice(unpacked.length + 1)}`);

  // Every start below goes through this link, as a typed `nolzu` does. Node follows it to dist/, where
  // the command finds the server build beside it.
  const bin = join(prefix, 'bin', 'nolzu');
  check('npm links the nolzu command into the prefix', existsSync(bin) && lstatSync(bin).isSymbolicLink());
  const help = run(bin, ['--help'], home);
  check('nolzu --help exits 0 and prints the usage', help.ok && help.out.includes('Usage: npx nolzu@latest'));
  // The packed command has its version line from the build, the line the rail shows, and asks no git:
  // the install is not a repository, so only the build can give it the commit this clone is on.
  const version = run(bin, ['--version'], home);
  const git = (args: string[]) => {
    const answer = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    return answer.status === 0 ? answer.stdout.trim() : null;
  };
  const expected = versionOutput(manifest.version, git, null);
  check(`nolzu --version exits 0 and prints ${expected}`, version.ok && version.out.trim() === expected);
  if (!version.out.includes(expected)) console.log(version.out);
  if (release) {
    const refused = releaseRefusal(manifest.version);
    check(`the package version ${manifest.version} is a release version`, refused === null);
    if (refused !== null) console.log(`     ${refused}`);
    check(`nolzu --version prints the plain release version, nolzu ${manifest.version}`, version.out.trim().split('\n').at(-1) === `nolzu ${manifest.version}`);
  }

  // The account commands load code split chunks in dist/ that a start never touches. Port 1
  // is the address, because nothing listens there.
  // While the cloud is closed it answers with one sentence and calls nothing, so it loads no chunk.
  const login = run(bin, ['login'], home, { ...env, NOLZU_CLOUD_URL: 'http://127.0.0.1:1' });
  if (CLOUD_OPEN) {
    check('nolzu login loads its chunks and names the server it could not reach', !login.ok && login.out.includes('Nolzu could not reach http://127.0.0.1:1'));
    if (!login.out.includes('Nolzu could not reach')) console.log(login.out);
  } else {
    check('nolzu login says Free needs no account and calls no server', login.ok && login.out.includes(NO_ACCOUNT) && !login.out.includes('could not reach'));
    if (!login.out.includes(NO_ACCOUNT)) console.log(login.out);
  }

  // Not the range the command uses, and not the ports the tests take, so nothing open here is hit.
  const port = await freePort({}, { first: 5330, last: 5339 });
  // A nolzu started inside a run of another install inherits that install's skills folder. The skills
  // check below proves this copy reads its own.
  const inherited = join(scratch, 'another-install', 'dist');
  const started = { ...env, NOLZU_FAKE_AGENT: '1', NOLZU_PORT: String(port), NOLZU_SKILLS_DIR: inherited };
  const child = spawn(bin, ['--no-open'], { cwd: home, env: started, stdio: ['ignore', 'pipe', 'pipe'] });
  let printed = '';
  child.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  // A death by a signal sets signalCode and leaves exitCode null.
  const running = () => child.exitCode === null && child.signalCode === null;
  try {
    let status = 0;
    for (let tries = 1; tries <= 60 && status !== 200 && running(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = await fetch(`http://localhost:${port}/new`).then((answer) => answer.status).catch(() => 0);
      if (status !== 200 && tries % 4 === 0) console.log(`     waiting for port ${port}`);
    }
    check(`the installed app answers on http://localhost:${port}/new`, status === 200);
    // A fresh data folder shows the terms first, and the accept is a form post from the app's own page.
    const before = await fetch(`http://localhost:${port}/new`, { redirect: 'manual' }).catch(() => null);
    check('a fresh start sends a page to the terms', before?.status === 303 && before.headers.get('location') === '/accept?to=%2Fnew');
    const accepted = await fetch(`http://localhost:${port}/accept`, {
      method: 'POST',
      headers: { origin: `http://localhost:${port}`, 'x-sveltekit-action': 'true' },
      body: new URLSearchParams({ accept: 'on', to: '/new' }),
    }).catch(() => null);
    const after = await fetch(`http://localhost:${port}/new`, { redirect: 'manual' }).catch(() => null);
    check('accepting the terms opens the app', accepted?.ok === true && after?.status === 200);
    // The start prints the data folder with the home as ~, so the server is asked for the whole path.
    const health = (await fetch(`http://localhost:${port}/api/health`).then((answer) => answer.json()).catch(() => null)) as { dataDir?: string } | null;
    check('the app keeps its data in the scratch home', health?.dataDir === join(home, '.nolzu-fake'));
    // The lines print once the agent tools answer, so they can trail the first answer.
    for (let tries = 0; tries < 100 && !printed.includes('Ctrl+C'); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    check('the start names the data folder and the address', printed.includes('~/.nolzu-fake (no account needed)') && printed.includes(`Nolzu is at http://localhost:${port}`));
    if (status !== 200 || !printed.includes('Ctrl+C')) console.log(printed);

    // A browser finds the fonts through the page's stylesheets, so follow the same path and fetch each file.
    const page = `http://localhost:${port}/new`;
    const html = await fetch(page).then((answer) => answer.text()).catch(() => '');
    const sheets = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((match) => new URL(match[1]!, page).href);
    const styles = await Promise.all(sheets.map(async (sheet) => ({ sheet, text: await fetch(sheet).then((answer) => answer.text()).catch(() => '') })));
    const fonts = styles.flatMap(({ sheet, text }) => [...text.matchAll(/url\(\s*["']?([^"')]+\.woff2)/g)].map((match) => new URL(match[1]!, sheet)));
    check(
      'the page links Geist and Geist Mono from its own address',
      ['Geist-Variable', 'GeistMono-Variable'].every((font) => fonts.some((url) => isFont(url.pathname, font))) && fonts.every((url) => url.origin === new URL(page).origin),
    );
    const served = await Promise.all(fonts.map((url) => fetch(url).then((answer) => answer.ok && answer.headers.get('content-type') === 'font/woff2').catch(() => false)));
    check('the installed app serves each font as font/woff2', served.length > 0 && served.every(Boolean));
    // Each route's styles and head tags ship in their own chunks, which /new never links, so read every file.
    const remote = filesUnder(unpacked).filter((file) => /\.(css|html|js)$/.test(file) && loadsFromAnotherHost(readFileSync(file, 'utf8')));
    check('no packed file or page asks another host for a stylesheet, a font or a connection', !loadsFromAnotherHost(html) && remote.length === 0);
    for (const file of remote) console.log(`     ${file.slice(unpacked.length + 1)}`);

    // The installed server has no skills package, so this proves it finds the skills the command
    // pointed it at. The first repository New project adds makes the workspace. Its clone of a host
    // that never resolves fails in the background, so the project never gets the first card that
    // writes its files, and Write the project files copies them instead, with no engine.
    const parent = join(scratch, 'projects');
    mkdirSync(parent);
    const address = `http://localhost:${port}`;
    const action = (path: string, fields: Record<string, string>) =>
      fetch(`${address}${path}`, { method: 'POST', headers: { origin: address, 'x-sveltekit-action': 'true' }, body: new URLSearchParams(fields) })
        .then((answer) => answer.text())
        .catch((error: Error) => error.message);
    const made = [
      await action('/new?/add', { folder: join(parent, 'recipes'), name: 'recipes', url: 'https://example.invalid/recipes/api.git' }),
      await action('/settings/project?/files', {}),
    ].join('\n');
    const skill = SKILL_FOLDERS.every((folder) => existsSync(join(parent, 'recipes', folder, 'nolzu-refine', 'SKILL.md')));
    check('the installed app copies its skills into a new workspace', skill);
    if (!skill) console.log(made, printed);

    // A second start from another folder, with the same port asked for, opens the first and leaves.
    // The browser is a stand-in on PATH that writes down the address, so no real one opens. DISPLAY,
    // because on Linux the command opens nothing without one.
    const browserDir = join(scratch, 'browser');
    const opened = join(scratch, 'opened');
    mkdirSync(browserDir);
    for (const name of ['open', 'xdg-open']) writeFileSync(join(browserDir, name), `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(opened)}\n`, { mode: 0o755 });
    const again = run(bin, [], parent, { ...started, PATH: `${browserDir}:${process.env.PATH ?? ''}`, DISPLAY: ':0' });
    for (let tries = 0; tries < 40 && !existsSync(opened); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    check('a second start exits 0 and says Nolzu is already running at the first address', again.ok && again.out.trim() === `Nolzu is already running at ${address}. Opening it.`);
    check('a second start opens the first address', existsSync(opened) && readFileSync(opened, 'utf8') === address);
    check('a second start leaves the first one running and starts no other', running() && readRecord(join(home, '.nolzu-fake'))?.pid === child.pid);
    if (!again.ok) console.log(again.out);
  } finally {
    const exited = new Promise((resolve) => (running() ? child.once('exit', resolve) : resolve(null)));
    child.kill();
    const late = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(late);
  }

  // The user floor is Node 22.16 (`engines`), while this check runs on Node 24. So the
  // installed command starts once more on the oldest Node 22 at or above the floor, opens its database
  // and answers, with no SQLite warning. NOLZU_NODE22 names that node binary; otherwise nvm's folder
  // is read. With neither, one line says the check was skipped.
  const nvm = join(homedir(), '.nvm', 'versions', 'node');
  const found22 = existsSync(nvm) ? floorNode(readdirSync(nvm)) : null;
  const node22 = process.env.NOLZU_NODE22 ?? (found22 === null ? null : join(nvm, found22, 'bin', 'node'));
  if (node22 === null || !existsSync(node22)) {
    console.log('skip the start on Node 22: none found. Set NOLZU_NODE22 to a node binary of 22.16 or newer to run it.');
  } else {
    const port22 = await freePort({}, { first: 5330, last: 5339 });
    const child22 = spawn(node22, [realpathSync(bin), '--no-open'], { cwd: home, env: { ...started, NOLZU_PORT: String(port22) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    child22.stdout.on('data', (chunk: Buffer) => (said += chunk.toString()));
    child22.stderr.on('data', (chunk: Buffer) => (said += chunk.toString()));
    const up = () => child22.exitCode === null && child22.signalCode === null;
    try {
      let status = 0;
      for (let tries = 1; tries <= 60 && status !== 200 && up(); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        status = await fetch(`http://localhost:${port22}/new`).then((answer) => answer.status).catch(() => 0);
      }
      check(`the installed app starts on Node ${found22 ?? 'from NOLZU_NODE22'}, opens its database and answers`, status === 200);
      check('a start on Node 22 prints no SQLite warning', !said.includes('ExperimentalWarning'));
      if (status !== 200 || said.includes('ExperimentalWarning')) console.log(said);
    } finally {
      const exited = new Promise((resolve) => (up() ? child22.once('exit', resolve) : resolve(null)));
      child22.kill();
      const late = setTimeout(() => child22.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(late);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  failures.push('stopped early');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length === 0) {
  console.log('Pack check passed.');
} else {
  console.error(`Pack check failed: ${failures.length} check${failures.length === 1 ? '' : 's'}.`);
  process.exitCode = 1;
}
