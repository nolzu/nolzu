import { describe, expect, it } from 'vitest';
import { carried, folderOf, shownFolder } from './project-folder.ts';

describe('folderOf', () => {
  it('puts the project in the home folder under its name', () => {
    expect(folderOf('Daily Habits')).toBe('~/Daily Habits');
    expect(folderOf('  recipes ')).toBe('~/recipes');
  });

  it('turns a slash into a dash, so the name stays one folder', () => {
    expect(folderOf('shop/web')).toBe('~/shop-web');
    expect(folderOf('a\\b')).toBe('~/a-b');
  });
});

describe('shownFolder', () => {
  it('reads a folder from the home folder unless it starts with a slash', () => {
    expect(shownFolder('~/nolzu/daily-habits')).toBe('~/nolzu/daily-habits');
    expect(shownFolder('nolzu/daily-habits')).toBe('~/nolzu/daily-habits');
    expect(shownFolder('/srv/recipes')).toBe('/srv/recipes');
    expect(shownFolder('~')).toBe('~');
  });

  it('reads . and .. and drops extra slashes, as the server does', () => {
    expect(shownFolder(' ~/code/./old/../recipes/ ')).toBe('~/code/recipes');
    expect(shownFolder('/srv//a/../b')).toBe('/srv/b');
  });

  it('shows nothing for an empty field', () => {
    expect(shownFolder('   ')).toBe('');
  });
});

describe('carried', () => {
  it('adds the name and a typed folder to the link, encoded', () => {
    expect(carried('./new/idea', 'Daily Habits', '~/nolzu/a&b')).toBe('./new/idea?name=Daily+Habits&folder=%7E%2Fnolzu%2Fa%26b');
  });

  it('leaves out a folder still following the name, and an empty name', () => {
    expect(carried('./new/idea', 'recipes', null)).toBe('./new/idea?name=recipes');
    expect(carried('./new', '', null)).toBe('./new');
  });
});
