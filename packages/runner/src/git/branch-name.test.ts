import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { BRANCH_NAME_MAX, branchName, branchNameProblem, slugify } from './branch-name.ts';

const TITLE = 'Add a search box to the recipe list';
const BACKSLASH = String.fromCharCode(92);
const CONTROL = 'ctrl' + String.fromCharCode(1) + 'char' + String.fromCharCode(127);

const accepted = (name: string): boolean => {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

it('fills the default template', () => {
  expect(branchName('{key}-{slug}', 'PROJ-123', TITLE)).toBe('PROJ-123-add-a-search-box-to-the-recipe-list');
});

it('keeps the key case and lowercases the slug', () => {
  expect(branchName('{key}-{slug}', 'PROJ-123', 'Add A Search Box')).toBe('PROJ-123-add-a-search-box');
});

it('cuts a long title on a word boundary and leaves no trailing hyphen', () => {
  const name = branchName('{key}-{slug}', 'PROJ-123', 'Add a search box to the recipe list so a cook can find a meal by name quickly');

  expect(name.length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
  expect(name.endsWith('-')).toBe(false);
  // Cut between words, so the last piece is a whole word and not half of one.
  expect(name).toBe('PROJ-123-add-a-search-box-to-the-recipe-list-so-a-cook-can');
});

it('returns the key alone when the title slugs to nothing', () => {
  expect(branchName('{key}-{slug}', 'PROJ-123', '!!! ??? ...')).toBe('PROJ-123');
  expect(branchName('{key}-{slug}', 'PROJ-123', '')).toBe('PROJ-123');
});

it.each([
  ['spaces', 'a b c'],
  ['two dots', 'a..b'],
  ['the characters git refuses', 'a~b^c:d?e*f[g' + BACKSLASH + 'h'],
  ['a leading slash', '/leading'],
  ['a trailing slash', 'trailing/'],
  ['a trailing dot', 'dot.'],
  ['a trailing .lock', 'name.lock'],
  ['the at brace pair', 'at@{brace'],
  ['control characters', CONTROL],
])('strips %s', (_label, title) => {
  const name = branchName('{key}-{slug}', 'PROJ-123', title);

  expect(accepted(name)).toBe(true);
  expect(name.startsWith('PROJ-123')).toBe(true);
});

it('refuses an unknown placeholder and lists the allowed ones', () => {
  expect(() => branchName('{key}-{title}', 'PROJ-123', TITLE)).toThrow(/title/);
  expect(() => branchName('{key}-{title}', 'PROJ-123', TITLE)).toThrow(/key/);
  expect(() => branchName('{key}-{title}', 'PROJ-123', TITLE)).toThrow(/slug/);
});

it('refuses a template that carries no key', () => {
  expect(() => branchName('{slug}', 'PROJ-123', TITLE)).toThrow(/key/);
});

it('makes a name git accepts for 200 titles', () => {
  const words = ['add', 'fix', 'Search', 'box', 'r\u00e9cip\u00e9', 'na\u00efve', '\u00dcn\u00efcode', '\u65e5\u672c\u8a9e', '\u043c\u0435\u043d\u044e', 'a/b', 'a..b', 'x'.repeat(40), '...', '@{', 'v1.0.lock'];
  const titles = Array.from({ length: 200 }, (_, i) =>
    Array.from({ length: (i % 6) + 1 }, (_, w) => words[(i * 7 + w * 3) % words.length]).join(' '),
  );

  for (const [i, title] of titles.entries()) {
    const name = branchName('{key}-{slug}', 'PROJ-' + i, title);
    expect(name.length, title).toBeLessThanOrEqual(BRANCH_NAME_MAX);
    expect(accepted(name), title + ' -> ' + name).toBe(true);
  }
}, 60000);

it('never returns an empty name, whatever the key holds', () => {
  // The checkout runs `git worktree add -b <name>`, and an empty name fails there with a message about
  // git syntax that names nothing the person can fix.
  for (const key of ['...', '@', '-', '###', '\u65e5\u672c\u8a9e']) {
    const name = branchName('{key}-{slug}', key, '!!! ???');
    expect(name, key).not.toBe('');
    expect(accepted(name), `${key} -> ${name}`).toBe(true);
  }
});

it('keeps two keys that differ on two different branches', () => {
  // The local key prefix is the user's own word, so an accented prefix is a normal input. Losing
  // the accent silently mapped two cards onto one branch.
  const pairs: [string, string][] = [
    ['\u00c9TEL-1', 'TEL-1'],
    ['\u00c9TEL-12', 'TEL-12'],
    ['APP.1', 'APP-1'],
    ['APP/1', 'APP-1'],
    ['APP#1', 'APP-1'],
  ];

  for (const [left, right] of pairs) {
    expect(branchName('{key}-{slug}', left, TITLE), `${left} vs ${right}`).not.toBe(
      branchName('{key}-{slug}', right, TITLE),
    );
  }
});

it('keeps the key whole when the cap has to cut something', () => {
  // The key is what keeps two cards apart, so the slug gives way and never the key.
  const long = 'TEAM-PLATFORM-INFRASTRUCTURE-MIGRATION-SUBPROJECT-ALPHA-0001';
  const other = 'TEAM-PLATFORM-INFRASTRUCTURE-MIGRATION-SUBPROJECT-ALPHA-0002';

  expect(branchName('{key}-{slug}', long, TITLE)).toContain(long);
  expect(branchName('{key}-{slug}', long, TITLE)).not.toBe(branchName('{key}-{slug}', other, TITLE));
  // The same has to hold when the template puts the slug first.
  expect(branchName('{slug}-{key}', 'APP-1', TITLE)).not.toBe(branchName('{slug}-{key}', 'APP-2', TITLE));
});

it.each([
  '{key} {slug}',
  '{key}~{slug}',
  '{key}:{slug}',
  '{key}^{slug}',
  '{key}?{slug}',
  '{key}*{slug}',
  '{key}[{slug}',
  'feature/.{key}-{slug}',
  'feat.lock/{key}-{slug}',
  '{key}-{slug}.lock.lock',
])('cleans the template text too, so %s still gives a name git accepts', (template) => {
  const name = branchName(template, 'PROJ-123', TITLE);

  expect(accepted(name), `${template} -> ${name}`).toBe(true);
});

it('gives a name git accepts even for the key HEAD', () => {
  const name = branchName('{key}-{slug}', 'HEAD', '!!!');

  expect(accepted(name), name).toBe(true);
});

it('keeps a word that fitted inside the cap', () => {
  // The cut walked back to the previous hyphen even when the cap landed exactly on one, which
  // threw away a whole word for nothing.
  const title = Array.from({ length: 14 }, () => 'abc').join(' ');
  const name = branchName('{key}-{slug}', 'APP-1', title);

  expect(name.length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
  expect(name.split('-').filter((part) => part === 'abc')).toHaveLength(13);
});

it('keeps a key with a doubled hyphen apart from the plain one', () => {
  // The key looked clean, so no hash was added, and the collapse of repeated hyphens then made
  // the two names identical.
  expect(branchName('{key}-{slug}', 'APP--1', TITLE)).not.toBe(branchName('{key}-{slug}', 'APP-1', TITLE));
  expect(branchName('{key}-{slug}', 'APP---1', TITLE)).not.toBe(branchName('{key}-{slug}', 'APP-1', TITLE));
});

it('still carries something of the card when the key is empty', () => {
  const name = branchName('{key}-{slug}', '', TITLE);

  expect(name).not.toBe(slugify(TITLE));
  expect(accepted(name), name).toBe(true);
});

it('stays inside the cap when the template holds text after the slug', () => {
  const title = Array.from({ length: 80 }, () => 'a').join(' ');

  expect(branchName('{key}-{slug}-x', 'APP-1', title).length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
  expect(branchName('{key}-{slug}-x', 'APP-1', TITLE).length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
});

it('stays inside the cap when the template repeats a placeholder', () => {
  // The budget was counted once and then spent once per placeholder.
  expect(branchName('{key}-{slug}-{slug}', 'PROJ-123', TITLE).length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
  expect(branchName('{key}-{slug}-{slug}-{slug}', 'PROJ-123', TITLE).length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
});

it('cleans a template that ends in a dot instead of throwing it away', () => {
  const name = branchName('release/{key}-{slug}.lock.', 'PROJ-123', TITLE);

  expect(name.startsWith('release/'), name).toBe(true);
  expect(accepted(name), name).toBe(true);
});

it('uses the room it has when the template repeats the slug', () => {
  // Each character cut from the slug shrinks the name once per copy, so taking the whole overflow
  // off a single copy overshot and fell back to the key on its own.
  const name = branchName('{key}-{slug}-{slug}', 'PROJ-123', 'Add a search box to the recipe list so a cook can find a meal');

  expect(name.length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
  expect(name.length).toBeGreaterThan(40);
  expect(name.startsWith('PROJ-123')).toBe(true);
});

it('leaves no stray separator at the edge, whichever one the template used', () => {
  expect(branchName('{key}_{slug}', 'APP-1', '!!!')).toBe('APP-1');
  expect(branchName('{key}-{slug}', 'APP-1', '!!!')).toBe('APP-1');
});

it('keeps a key whose edge underscore is trimmed apart from the plain one', () => {
  // The name trims an underscore at the edge, and the key did not, so the key looked untouched,
  // took no hash, and two cards landed on one branch. The same shape as the doubled hyphen.
  expect(branchName('{key}-{slug}', '_1', TITLE)).not.toBe(branchName('{key}-{slug}', '1', TITLE));
  expect(branchName('{slug}-{key}', 'APP-1_', TITLE)).not.toBe(branchName('{slug}-{key}', 'APP-1', TITLE));
});

it('still carries the card when the key is only an underscore', () => {
  const name = branchName('{key}-{slug}', '_', TITLE);

  expect(name).not.toBe(slugify(TITLE));
  expect(accepted(name), name).toBe(true);
});

it('leaves an underscore inside a key alone', () => {
  expect(branchName('{key}-{slug}', 'APP_1', 'Add a search box')).toContain('APP_1');
});

it('fills {type}, {key} and {desc} with the words Refine wrote, slashes kept', () => {
  const name = branchName('{type}/{key}/{desc}', 'APP-1', TITLE, { type: 'fix', desc: 'search-box' });

  expect(name).toBe('fix/APP-1/search-box');
  expect(accepted(name)).toBe(true);
});

it('falls back to feature and the first four words of the title when Refine wrote no lines', () => {
  expect(branchName('{type}/{key}/{desc}', 'APP-1', TITLE)).toBe('feature/APP-1/add-a-search-box');
  expect(branchName('{type}/{key}/{desc}', 'APP-1', TITLE, { type: null, desc: null })).toBe('feature/APP-1/add-a-search-box');
});

it('reads a kind it does not know as feature, and cleans the desc words', () => {
  expect(branchName('{type}/{key}/{desc}', 'APP-1', TITLE, { type: 'Hotfix', desc: 'Search Box!' })).toBe('feature/APP-1/search-box');
});

it('leaves out an empty desc part rather than ending on a slash', () => {
  const name = branchName('{type}/{key}/{desc}', 'APP-1', '!!!');

  expect(name).toBe('feature/APP-1');
  expect(accepted(name)).toBe(true);
});

it('cuts a long desc to the cap and keeps the key whole', () => {
  const desc = 'search-box-for-the-recipe-list-with-filters-by-cuisine-and-cooking-time';
  const name = branchName('{type}/{key}/{desc}', 'PROJ-123', TITLE, { type: 'feature', desc });

  expect(name.length).toBeLessThanOrEqual(BRANCH_NAME_MAX);
  expect(name.startsWith('feature/PROJ-123/search-box')).toBe(true);
  expect(accepted(name)).toBe(true);
});

it('keeps the old {key}-{slug} names when the new parts are given', () => {
  expect(branchName('{key}-{slug}', 'PROJ-123', TITLE, { type: 'fix', desc: 'search-box' })).toBe('PROJ-123-add-a-search-box-to-the-recipe-list');
});

// A name typed on the card page: what git takes, the cap, and the card key.
it('takes a typed branch name only when git takes it, it fits and it carries the key', () => {
  const good = ['HABITS-2-create-the-sveltekit-typescript-project-next-to', 'feature/APP-1/search', 'fix_APP-1.v2'];
  for (const name of good) {
    expect(branchNameProblem(name, name.includes('HABITS') ? 'HABITS-2' : 'APP-1')).toBeNull();
    expect(accepted(name)).toBe(true);
  }
  const bad = ['', 'APP-1 search', 'APP-1..x', '.APP-1', 'APP-1.lock', 'APP-1/', '-APP-1', 'APP-1//x', 'APP-1@{x', 'APP-1~1', 'APP-1:x', `APP-1${BACKSLASH}x`, 'APP-1-étel', 'feature/.APP-1'];
  for (const name of bad) {
    expect(branchNameProblem(name, 'APP-1'), name).not.toBeNull();
  }
  // Every name git refuses is refused here too.
  for (const name of bad) if (!accepted(name)) expect(branchNameProblem(name, 'APP-1')).not.toBeNull();
  expect(branchNameProblem('search-box', 'APP-1')).toBe('The name must carry the card key APP-1.');
  expect(branchNameProblem('APP-12-search', 'APP-1')).toBe('The name must carry the card key APP-1.');
  expect(branchNameProblem('XAPP-1-search', 'APP-1')).toBe('The name must carry the card key APP-1.');
  expect(branchNameProblem(`APP-1-${'a'.repeat(BRANCH_NAME_MAX - 6)}`, 'APP-1')).toBeNull();
  expect(branchNameProblem(`APP-1-${'a'.repeat(BRANCH_NAME_MAX - 5)}`, 'APP-1')).toBe(`The name is ${BRANCH_NAME_MAX + 1} characters, and ${BRANCH_NAME_MAX} is the limit.`);
});
