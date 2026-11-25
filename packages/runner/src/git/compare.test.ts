import { expect, it } from 'vitest';
import { compareUrl } from './compare.ts';
import { parseRemoteUrl } from './remote.ts';

const SPELLINGS = [
  'git@github.com:nolzu/nolzu.git',
  'https://github.com/nolzu/nolzu.git',
  'https://github.com/nolzu/nolzu',
  'ssh://git@github.com/nolzu/nolzu.git',
];

it.each(SPELLINGS)('reads %s as the same repository', (url) => {
  const place = parseRemoteUrl(url);

  expect(place).toEqual({ host: 'github.com', owner: 'nolzu', repo: 'nolzu' });
});

it('keeps a host that is not github.com, rather than pretending it is', () => {
  expect(parseRemoteUrl('git@github.example.invalid:team/app.git')).toEqual({
    host: 'github.example.invalid',
    owner: 'team',
    repo: 'app',
  });
});

it('keeps a nested group as the owner', () => {
  expect(parseRemoteUrl('https://gitlab.com/group/sub/app.git')?.owner).toBe('group/sub');
});

it('reads nothing out of a line that is not a remote', () => {
  expect(parseRemoteUrl('not a url at all')).toBe(null);
});

const draft = {
  remote: 'git@github.com:nolzu/nolzu.git',
  base: 'main',
  head: 'APP-1-add-a-search-box',
  title: 'feat(list): add the search box',
  body: 'What changed, in plain words.',
};

it('builds the compare url with the title and the body filled in', () => {
  const made = compareUrl(draft);

  expect(made.ok).toBe(true);
  if (!made.ok) return;
  expect(made.url).toContain('https://github.com/nolzu/nolzu/compare/main...APP-1-add-a-search-box');
  expect(made.url).toContain('expand=1');
  // Read through the query key, not as text anywhere in the URL: renaming the key empties the
  // title on GitHub and a substring check would not notice.
  expect(new URL(made.url).searchParams.get('title')).toBe(draft.title);
  expect(made.url).toContain(encodeURIComponent(draft.body));
});

it('keeps a working url when the branch name holds a slash', () => {
  const made = compareUrl({ ...draft, head: 'feature/APP-1-add-a-search-box' });

  expect(made.ok).toBe(true);
  if (!made.ok) return;
  // A slash in the path would read as another segment and the page would not exist.
  expect(made.url).toContain('main...feature%2FAPP-1-add-a-search-box');
});

it('refuses a host that is not github, and names it', () => {
  const made = compareUrl({ ...draft, remote: 'git@gitlab.com:nolzu/nolzu.git' });

  expect(made.ok).toBe(false);
  if (made.ok) return;
  expect(made.reason).toContain('gitlab.com');
  expect(made.reason).toMatch(/github/i);
});

it('refuses a remote it cannot read at all', () => {
  const made = compareUrl({ ...draft, remote: 'not a url at all' });

  expect(made.ok).toBe(false);
});

it('refuses a compare of a branch with itself', () => {
  const made = compareUrl({ ...draft, head: 'main' });

  expect(made.ok).toBe(false);
  if (made.ok) return;
  expect(made.reason).toMatch(/same/i);
});

it('cuts a long body on a line boundary and says where the rest is', () => {
  const long = Array.from({ length: 400 }, (_, at) => `line ${at} of the plain summary`).join('\n');

  const made = compareUrl({ ...draft, body: long });

  expect(made.ok).toBe(true);
  if (!made.ok) return;
  const body = decodeURIComponent(new URL(made.url).searchParams.get('body') ?? '');
  // Cut between lines, so no sentence is halved, and the last line says the whole text is in the
  // card rather than leaving the reader wondering.
  expect(body).not.toMatch(/line \d+ of the plain summ$/);
  expect(body.split('\n').at(-1)).toMatch(/card/i);
  // Measured: github.com stops answering just above 7050 characters. A looser bound here would let
  // the cap drift back up to a length that fails.
  expect(made.url.length).toBeLessThanOrEqual(6800);
});

it('leaves a body that fits exactly as it was written', () => {
  const made = compareUrl(draft);

  expect(made.ok).toBe(true);
  if (!made.ok) return;
  expect(decodeURIComponent(new URL(made.url).searchParams.get('body') ?? '')).toBe(draft.body);
});

it('keeps a working url when the base branch holds a slash', () => {
  // Every fixture above uses `main`, which has nothing to encode, so the base side was carried by
  // nothing. A team whose base is `release/2026` would get a url pointing at a page that is not there.
  const made = compareUrl({ ...draft, base: 'release/2026' });

  expect(made.ok).toBe(true);
  if (!made.ok) return;
  expect(made.url).toContain('compare/release%2F2026...APP-1-add-a-search-box');
});

it('reads nothing out of a remote with no owner in it', () => {
  // `git@github.com:nolzu.git` names a host and one part. There is no owner, so there is no
  // repository to compare, and guessing one would send a person to somebody else's page.
  expect(parseRemoteUrl('git@github.com:nolzu.git')).toBe(null);
});

it('keeps the case a host was written in', () => {
  // Hosts are matched case insensitively where it matters, but what the person typed is what goes
  // into the message they read, so it is not quietly rewritten here.
  expect(parseRemoteUrl('git@GitHub.com:nolzu/nolzu.git')?.host).toBe('GitHub.com');
});

it('still builds the url when the host was typed with capitals', () => {
  const made = compareUrl({ ...draft, remote: 'git@GitHub.com:nolzu/nolzu.git' });

  expect(made.ok).toBe(true);
});

it('keeps a credential out of the reason for a remote it cannot read', () => {
  const made = compareUrl({ ...draft, remote: 'https://x-access-token:ghs_notarealtoken@github.com/nolzu' });

  expect(made.ok).toBe(false);
  if (made.ok) return;
  expect(made.reason).not.toContain('ghs_notarealtoken');
  // The person still needs to see which remote it was, so the rest of it stays.
  expect(made.reason).toContain('github.com/nolzu');
});
