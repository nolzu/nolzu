import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { projectName } from './app-header.ts';

function withProject(value: string | null): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (value !== null) db.prepare('INSERT INTO settings VALUES (?, ?)').run('projectPath', JSON.stringify(value));
  return db;
}

it('names the project by its folder', () => {
  expect(projectName(withProject('/home/dev/recipes'))).toBe('recipes');
  expect(projectName(withProject('/home/dev/recipes/'))).toBe('recipes');
});

it('names no project when none is set', () => {
  expect(projectName(withProject(null))).toBeNull();
  expect(projectName(withProject('/'))).toBeNull();
});
