import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidSkillName, lintSkills, parseFrontmatter } from './lint.ts';

const fixture = (name: string) => path.join(import.meta.dirname, '..', 'fixtures', name);

it('passes a valid skill with no issues', async () => {
  expect(await lintSkills(fixture('valid'))).toEqual({ checked: 1, issues: [] });
});

it('checks zero skills in an empty directory, like the real skills folder', async () => {
  expect(await lintSkills(fixture('empty'))).toEqual({ checked: 0, issues: [] });
});

it('flags frontmatter that does not start on the first line', async () => {
  const result = await lintSkills(fixture('bad-frontmatter'));
  expect(result.checked).toBe(1);
  expect(result.issues).toEqual([{ skill: 'example-skill', message: expect.stringMatching(/first line/) }]);
});

it('flags a name that does not match its folder', async () => {
  const result = await lintSkills(fixture('bad-name'));
  expect(result.issues).toEqual([{ skill: 'example-skill', message: expect.stringMatching(/folder name/) }]);
});

it('flags a description outside 1-1024 characters', async () => {
  const result = await lintSkills(fixture('bad-description'));
  expect(result.issues).toEqual([{ skill: 'example-skill', message: expect.stringMatching(/description/) }]);
});

it('flags a model key in frontmatter', async () => {
  const result = await lintSkills(fixture('bad-model'));
  expect(result.issues).toEqual([{ skill: 'example-skill', message: expect.stringMatching(/model/) }]);
});

it('flags a relative link that does not resolve', async () => {
  const result = await lintSkills(fixture('bad-link'));
  expect(result.issues).toEqual([{ skill: 'example-skill', message: expect.stringMatching(/does-not-exist\.md/) }]);
});

describe('isValidSkillName', () => {
  it.each(['a', 'example-skill', 'a2-b3'])('accepts %s', (name) => {
    expect(isValidSkillName(name)).toBe(true);
  });

  it.each(['-foo', 'foo-', 'foo--bar', 'Foo', 'foo_bar', '', 'a'.repeat(65)])('refuses %s', (name) => {
    expect(isValidSkillName(name)).toBe(false);
  });
});

describe('parseFrontmatter', () => {
  it('refuses invalid YAML between the markers', () => {
    expect(parseFrontmatter('---\nname: [unterminated\n---\nbody\n').ok).toBe(false);
  });

  it('refuses a YAML scalar that is not a mapping', () => {
    expect(parseFrontmatter('---\njust a string\n---\nbody\n').ok).toBe(false);
  });
});
