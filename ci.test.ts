import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// CI checks and publishes nothing: no job writes packages, and no trigger lets a
// pull request run with write access. Plain text and not a YAML parser, because the file is short
// and the root has no YAML dependency.
const dir = join(import.meta.dirname, '.github', 'workflows');
const ci = readFileSync(join(dir, 'ci.yml'), 'utf8');

it('no workflow starts from a trigger that runs a pull request with write access', () => {
  for (const name of readdirSync(dir)) {
    expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/^ *(workflow_run|pull_request_target):/m);
  }
});

it('publishes nothing: no job writes packages and no step publishes', () => {
  expect(ci).toMatch(/\npermissions:\n {2}contents: read\n\n/);
  expect(ci).not.toContain('packages: write');
  expect(ci).not.toMatch(/\bpublish\b/);
  expect(ci).not.toContain('npm.pkg.github.com');
  for (const name of ['protocol', 'core', 'ui', 'runner', 'skills']) {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'packages', name, 'package.json'), 'utf8')) as { private?: boolean; publishConfig?: unknown };
    expect(manifest.private, name).toBe(true);
    expect(manifest.publishConfig, name).toBeUndefined();
  }
});

it('keeps the token out of every checkout', () => {
  const checkouts = ci.split('uses: actions/checkout@').slice(1);
  expect(checkouts.length).toBeGreaterThan(0);
  for (const step of checkouts) expect(step.split('\n      - ')[0]).toContain('persist-credentials: false');
});
