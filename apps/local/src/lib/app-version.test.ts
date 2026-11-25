import { describe, expect, it } from 'vitest';
import { isBeta, readBuild, versionLine } from './app-version.ts';

describe('versionLine', () => {
  it('shows the plain version for a tagged release', () => {
    expect(versionLine({ version: '0.9.0', commit: null, date: '2026-10-30' })).toEqual({
      short: '0.9.0',
      full: 'Nolzu 0.9.0, built 2026-10-30',
    });
  });

  it('marks a build from an untagged commit as dev, with the short commit', () => {
    expect(versionLine({ version: '0.9.0', commit: '0b407d5', date: '2026-10-30' })).toEqual({
      short: '0.9.0-dev · 0b407d5',
      full: 'Nolzu 0.9.0-dev · 0b407d5, built 2026-10-30',
    });
  });

  it('leaves out the date when the build has none', () => {
    expect(versionLine({ version: '0.0.0', commit: null, date: '' }).full).toBe('Nolzu 0.0.0');
  });
});

describe('readBuild', () => {
  const fakeGit = (answers: Record<string, string | null>) => (args: string[]) => answers[args.join(' ')] ?? null;

  it('keeps the commit when HEAD has no release tag', () => {
    const git = fakeGit({ 'rev-parse --short HEAD': 'b9fcb837' });
    expect(readBuild('0.9.0', git, '2026-10-30')).toEqual({ version: '0.9.0', commit: 'b9fcb837', date: '2026-10-30' });
  });

  it('drops the commit on a release tag', () => {
    const git = fakeGit({ 'describe --tags --exact-match': 'v0.9.0', 'rev-parse --short HEAD': 'b9fcb837' });
    expect(readBuild('0.9.0', git, '2026-10-30').commit).toBeNull();
  });

  it('gives the plain version when git is missing', () => {
    expect(readBuild('0.9.0', () => null, '2026-10-30').commit).toBeNull();
  });
});

// Beta until 1.0, beside the version in the rail.
describe('isBeta', () => {
  it('is true below 1.0.0 and false from it', () => {
    expect(['0.1.0', '0.99.3', '0.0.0'].map(isBeta)).toEqual([true, true, true]);
    expect(['1.0.0', '2.4.1'].map(isBeta)).toEqual([false, false]);
  });
});
