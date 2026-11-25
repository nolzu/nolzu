import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStackHook, stackAddresses, stackEnv } from './packages/runner/src/index.ts';
import { afterEach, beforeEach, expect, it } from 'vitest';

// The example hook in docs/stack-hook, run the way Nolzu runs it, against a stub docker that writes
// down each call and the two folders it would mount. No test needs a real docker. The copy sits in a
// folder with a space, the way demo-setup prints the line for a checkout at such a path.
let dir = '';
let log = '';
let hook = { load: '', unload: '', status: '' };
const here = () => join(dir, 'my tools');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-stack-hook-'));
  log = join(dir, 'docker.log');
  cpSync(join(import.meta.dirname, 'docs', 'stack-hook'), here(), { recursive: true });
  const script = join(here(), 'stack.sh');
  hook = { load: `sh '${script}' load {key}`, unload: `sh '${script}' unload {key}`, status: `sh '${script}' status {key}` };
  writeFileSync(
    join(dir, 'docker'),
    '#!/bin/sh\necho "$* | $API_DIR | $WEB_DIR" >> "$DOCKER_LOG"\n[ "$1" = info ] && exit "${DOCKER_DOWN:-0}"\necho "Container recipes-api Started"\nexit "${COMPOSE_FAILS:-0}"\n',
  );
  chmodSync(join(dir, 'docker'), 0o755);
  mkdirSync(join(dir, 'worktrees', 'APP-1'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const run = (action: 'load' | 'unload', repos: readonly string[], extra: Record<string, string> = {}) =>
  runStackHook(hook, action, 'APP-1', {
    cwd: join(dir, 'worktrees', 'APP-1'),
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, DOCKER_LOG: log, ...stackEnv('APP-1', join(dir, 'recipes'), repos), ...extra },
  });
const load = (repos: readonly string[], extra: Record<string, string> = {}) => run('load', repos, extra);
const lastCall = () => readFileSync(log, 'utf8').trim().split('\n').at(-1);

it('mounts the card checkout of a listed repository and the base folder of the other', async () => {
  const card = join(dir, 'worktrees', 'APP-1');
  const result = await load(['api']);

  expect(lastCall()).toBe(`compose -p nolzu-app-1 -f ${here()}/compose.yaml up -d --wait | ${card}/api | ${join(dir, 'recipes')}/web`);
  expect(result?.code).toBe(0);
  // Compose progress goes to stderr, so stdout is the two address lines and nothing else.
  expect(result?.stdout).toBe('api http://localhost:8787/recipes\nweb http://localhost:8080\n');
  expect(result?.stderr).toContain('Container recipes-api Started');
  expect(stackAddresses(result?.stdout ?? '')).toEqual(['api http://localhost:8787/recipes', 'web http://localhost:8080']);
});

it('exits non-zero with a sentence when docker is not running', async () => {
  const result = await load(['api', 'web'], { DOCKER_DOWN: '1' });

  expect(result?.code).toBe(1);
  expect(result?.stderr.trim()).toBe('Docker is not running, so stack.sh cannot run load. Start Docker and run it again.');
  expect(result?.stdout).toBe('');
});

it('prints no addresses when compose fails to bring the stack up', async () => {
  const result = await load(['api'], { COMPOSE_FAILS: '1' });

  expect(result?.code).toBe(1);
  expect(result?.stdout).toBe('');
});

it('takes the stack down under the same project name', async () => {
  const result = await run('unload', ['api']);

  expect(result?.code).toBe(0);
  expect(lastCall()).toMatch(/^compose -p nolzu-app-1 -f .*\/compose\.yaml down \|/);
});

it('names the compose project after the card it runs for', async () => {
  mkdirSync(join(dir, 'worktrees', 'WEB-12'), { recursive: true });
  const result = await runStackHook(hook, 'status', 'WEB-12', {
    cwd: join(dir, 'worktrees', 'WEB-12'),
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, DOCKER_LOG: log, ...stackEnv('WEB-12', join(dir, 'recipes'), ['web']) },
  });

  expect(result?.code).toBe(0);
  expect(lastCall()).toBe(`compose -p nolzu-web-12 -f ${here()}/compose.yaml ps | ${join(dir, 'recipes')}/api | ${join(dir, 'worktrees', 'WEB-12')}/web`);
});
