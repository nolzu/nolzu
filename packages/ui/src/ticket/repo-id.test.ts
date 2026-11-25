import { expect, it } from 'vitest';
import { repoSuffix } from './repo-id.ts';

it('adds nothing for the project folder and a safe end for any other repository', () => {
  expect(repoSuffix('.')).toBe('');
  expect(repoSuffix('api')).toBe('-api');
  expect(repoSuffix('recipe api')).toBe('-recipe_api');
  expect(repoSuffix('services/api')).toBe('-services_api');
});
