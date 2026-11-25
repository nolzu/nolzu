import { describe, expect, it } from 'vitest';
import { ignoreWith, ignoreWithout, manifestWith, manifestWithout, parseManifest } from './manifest.ts';

const file = (repositories: unknown) => JSON.stringify({ repositories });
const api = { folder: 'api', url: 'https://example.com/team/api.git', base: 'main' };

describe('reading .nolzu/repositories.json', () => {
  it('reads no file as no repository and no problem', () => {
    expect(parseManifest(null)).toEqual({ repos: [], problems: [] });
  });

  it('reads each good entry', () => {
    const web = { folder: 'web', url: 'git@example.com:team/web.git', base: 'develop' };

    expect(parseManifest(file([api, web]))).toEqual({ repos: [api, web], problems: [] });
  });

  it('names a file that is not JSON, or holds no list, and reads nothing from it', () => {
    expect(parseManifest('{ nope')).toEqual({ repos: [], problems: ['.nolzu/repositories.json is not JSON, so Nolzu reads no repository from it.'] });
    expect(parseManifest('[]').problems).toEqual(['.nolzu/repositories.json has no list of repositories, so Nolzu reads no repository from it.']);
    expect(parseManifest(JSON.stringify({ repositories: 'api' })).repos).toEqual([]);
  });

  // A teammate's file is untrusted: each bad entry is named, the good ones still read.
  it('names each bad entry by the clone rules and keeps the good ones', () => {
    const read = parseManifest(
      file([
        api,
        'api',
        { folder: '../up', url: 'https://example.com/team/up.git', base: 'main' },
        { folder: 'tool', url: 'ext::sh -c touch% /tmp/x', base: 'main' },
        { folder: 'local', url: '/home/someone/local', base: 'main' },
        { folder: 'secret', url: 'https://someone:hunter2@example.com/team/secret.git', base: 'main' },
        { folder: 'backend', url: 'https://example.com/team/server.git', base: 'main' },
        { folder: 'docs', url: 'https://example.com/team/docs.git', base: '-x' },
        { folder: 'API', url: 'https://example.com/team/API.git', base: 'main' },
        { folder: '.nolzu', url: 'https://example.com/team/.nolzu.git', base: 'main' },
      ]),
    );

    expect(read.repos).toEqual([api]);
    expect(read.problems).toEqual([
      'Entry 2 of .nolzu/repositories.json is not a folder, a URL and a base branch.',
      'Entry 3 of .nolzu/repositories.json names no folder Nolzu can clone into.',
      'In .nolzu/repositories.json, the entry "tool" cannot be cloned. The URL names a git transport of its own, which can run any command. Type an https:// or user@host:path URL.',
      'In .nolzu/repositories.json, the entry "local" cannot be cloned. Type an https:// or the user@host:path form of the repository URL. Nolzu clones nothing else, not a local path either.',
      'In .nolzu/repositories.json, the entry "secret" cannot be cloned. The URL holds a user name and password or a token. Type it without them, and let git find the login the way it does for a push.',
      'In .nolzu/repositories.json, the entry "backend" has a URL that clones into "server", not into "backend".',
      'In .nolzu/repositories.json, the entry "docs" has no base branch Nolzu can use.',
      'In .nolzu/repositories.json, the entry "API" is there twice.',
      'Entry 10 of .nolzu/repositories.json names no folder Nolzu can clone into.',
    ]);
    // No sentence repeats a URL, so a token in one is never shown.
    expect(read.problems.join(' ')).not.toContain('hunter2');
  });
});

describe('writing an entry', () => {
  it('starts the file when there is none', () => {
    expect(manifestWith(null, api)).toEqual({ text: `${JSON.stringify({ repositories: [api] }, null, 2)}\n` });
  });

  it('adds an entry, replaces one of the same folder in any case, and keeps the rest as they were', () => {
    const odd = { folder: 'odd', note: 'a person wrote this' };
    const before = file([odd, { folder: 'API', url: 'https://example.com/old/API.git', base: 'main' }]);

    const after = manifestWith(before, api);

    expect(after !== null && 'text' in after && JSON.parse(after.text)).toEqual({ repositories: [odd, api] });
  });

  it('answers null when the entry is there already as it is', () => {
    expect(manifestWith(file([api]), api)).toBeNull();
  });

  it('leaves a file it cannot read alone, with a sentence', () => {
    expect(manifestWith('{ nope', api)).toEqual({ problem: '.nolzu/repositories.json is not JSON, so Nolzu left it alone and did not add api to it.' });
    expect(manifestWith('[]', api)).toEqual({ problem: '.nolzu/repositories.json has no list of repositories, so Nolzu left it alone and did not add api to it.' });
  });
});

describe('the .gitignore line', () => {
  it('adds /<folder>/ and keeps every line and the last newline', () => {
    expect(ignoreWith(null, 'api')).toBe('/api/\n');
    expect(ignoreWith('/worktrees/\n/.tasks/\n', 'api')).toBe('/worktrees/\n/.tasks/\n/api/\n');
    expect(ignoreWith('node_modules', 'api')).toBe('node_modules\n/api/\n');
  });

  it('answers null when the folder is ignored already, in any of the usual forms', () => {
    for (const line of ['/api/', '/api', 'api/', 'api', '  /api/  ']) expect(ignoreWith(`x\n${line}\n`, 'api')).toBeNull();
    expect(ignoreWith('/apis/\n', 'api')).toBe('/apis/\n/api/\n');
  });
});

// A removed repository takes its entry and its line with it.
describe('taking a repository out', () => {
  it('drops the entry of that folder in any case, and keeps the mark and every other entry as it was', () => {
    const odd = { folder: 'odd', note: 'a person wrote this' };
    const before = JSON.stringify({ workspace: true, repositories: [odd, { ...api, folder: 'API' }] });

    const after = manifestWithout(before, 'api');

    expect(after !== null && 'text' in after && JSON.parse(after.text)).toEqual({ workspace: true, repositories: [odd] });
  });

  it('answers null when there is no file or no entry of that folder', () => {
    expect(manifestWithout(null, 'api')).toBeNull();
    expect(manifestWithout(file([{ ...api, folder: 'web' }]), 'api')).toBeNull();
  });

  it('leaves a file it cannot read alone, with a sentence', () => {
    expect(manifestWithout('{ nope', 'api')).toEqual({ problem: '.nolzu/repositories.json is not JSON, so Nolzu left it alone and did not take api out of it.' });
  });

  it('drops the lines that ignore the folder at the top, and keeps the ones that match at any depth', () => {
    expect(ignoreWithout('/worktrees/\n/api/\n/.tasks/\n', 'api')).toBe('/worktrees/\n/.tasks/\n');
    expect(ignoreWithout('/api\napi/\n  /api/  \n/apis/\napi\nsrc/api/', 'api')).toBe('api/\n/apis/\napi\nsrc/api/');
    expect(ignoreWithout('/apis/\n', 'api')).toBeNull();
    expect(ignoreWithout(null, 'api')).toBeNull();
  });
});
