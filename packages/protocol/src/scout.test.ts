import { describe, expect, it } from 'vitest';
import { scoutEntryName, scoutEntrySlug, scoutSecretName } from './scout.ts';

// The keychain refuses any other name, so every name built here has to pass the same rule.
const KEYCHAIN_NAME = /^[a-z0-9][a-z0-9-]*$/;

describe('scoutEntryName', () => {
  it('names a source by its kind, the project it reads and its id', () => {
    expect(scoutEntryName('sentry', 'recipes-web', 7)).toBe('sentry-recipes-web-7');
    expect(scoutEntryName('linear', 'PROJ, OPS', 3)).toBe('linear-proj-ops-3');
  });

  // Two sources of one kind and project keep two tokens, so removing one never takes the other's.
  it('keeps two sources of one kind and project apart by their id', () => {
    expect(scoutEntryName('sentry', 'recipes-web', 7)).not.toBe(scoutEntryName('sentry', 'recipes-web', 8));
  });

  it('reads an address for its host, and leaves out a user name and a password typed into it', () => {
    expect(scoutEntryName('jira', 'https://your-site.atlassian.net', 2)).toBe('jira-your-site-atlassian-net-2');
    expect(scoutEntryName('logs', 'https://logs.example.com:9200', 4)).toBe('logs-logs-example-com-9200-4');
    expect(scoutEntryName('logs', 'https://user:hunter2@logs.example.com', 4)).toBe('logs-logs-example-com-4');
  });

  it('builds a name the keychain takes from anything typed, and drops a project with nothing left in it', () => {
    for (const project of ['  Recipes Web  ', 'ÄÖÜ', '--', '', 'a'.repeat(200), 'PROJ/../etc']) {
      expect(scoutEntryName('sentry', project, 12)).toMatch(KEYCHAIN_NAME);
    }
    expect(scoutEntryName('sentry', '***', 12)).toBe('sentry-12');
    expect(scoutEntrySlug('a'.repeat(200)).length).toBeLessThanOrEqual(40);
  });

  // The old name stays, because the first read of an older source moves its token from there.
  it('keeps the old name a source had before', () => {
    expect(scoutSecretName(7)).toBe('scout-7');
  });
});
