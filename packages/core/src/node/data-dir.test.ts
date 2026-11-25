import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, inject, it } from 'vitest';
import { resolveDataDir } from './data-dir.ts';

it('uses ~/.nolzu, and NOLZU_DATA_DIR overrides it', () => {
  const custom = join(tmpdir(), 'nolzu-custom');
  expect(resolveDataDir({})).toBe(join(homedir(), '.nolzu'));
  expect(resolveDataDir({ NOLZU_DATA_DIR: custom })).toBe(custom);
});

it('ignores NOLZU_DATA_DIR in fake mode and never returns the live directory', () => {
  for (const custom of [join(tmpdir(), 'nolzu-custom'), inject('liveDataDir')]) {
    const dir = resolveDataDir({ NOLZU_FAKE_AGENT: '1', NOLZU_DATA_DIR: custom });
    expect(dir).toBe(join(homedir(), '.nolzu-fake'));
    expect(dir).not.toBe(inject('liveDataDir'));
  }
});

it('runs tests with HOME and NOLZU_DATA_DIR in a temp directory', () => {
  expect(homedir()).toContain('nolzu-test-');
  expect(resolveDataDir(process.env)).toBe(join(homedir(), 'data'));
});

it('fails a test that resolves the live directory', () => {
  expect(() => resolveDataDir({ NOLZU_DATA_DIR: inject('liveDataDir') })).toThrow(/live data directory/);
});
