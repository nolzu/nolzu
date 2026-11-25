import { expect, it } from 'vitest';
import { at } from './repo-param.ts';

it('names no repository for the project folder and names any other one', () => {
  expect(at('.')).toEqual({});
  expect(at('api')).toEqual({ repo: 'api' });
  expect(JSON.stringify({ short: true, ...at('api') })).toBe('{"short":true,"repo":"api"}');
  expect(new URLSearchParams({ path: 'a.ts', ...at('.') }).toString()).toBe('path=a.ts');
});
