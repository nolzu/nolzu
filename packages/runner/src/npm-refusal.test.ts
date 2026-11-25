import { expect, it } from 'vitest';
import { npmScopeRefusal } from './npm-refusal.ts';

const SAID =
  'The package registry refused @recipes, so log in to npm for that scope where Nolzu runs (npm login --scope=@recipes) and run again. Runs use your own npm setup.';

it('names the scope of a 404 on a URL encoded scoped package', () => {
  expect(npmScopeRefusal('npm error 404 Not Found - GET https://registry.npmjs.org/@recipes%2fui - Not found')).toBe(SAID);
  expect(npmScopeRefusal('npm error 404 Not Found - GET https://registry.npmjs.org/@recipes%2Fui')).toBe(SAID);
});

it('names the scope of a 404 on a plain scoped path', () => {
  expect(npmScopeRefusal('404 Not Found - GET https://npm.example.test/@recipes/ui')).toBe(SAID);
});

it('names the scope of the 404 pnpm prints', () => {
  expect(npmScopeRefusal('ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@recipes%2Fui: Not Found - 404')).toBe(SAID);
});

it('names the scope from the not in this registry line', () => {
  expect(npmScopeRefusal("npm error 404  '@recipes/ui@2.1.0' is not in this registry.")).toBe(SAID);
});

it('reads the lines inside a JSON stream line, where a newline is written as \\n', () => {
  const line = JSON.stringify({ type: 'user', content: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@recipes%2fui' });
  expect(npmScopeRefusal(line)).toBe(SAID);
});

it('says nothing special for a 404 on an unscoped package', () => {
  expect(npmScopeRefusal('npm error 404 Not Found - GET https://registry.npmjs.org/left-pad - Not found')).toBeNull();
  expect(npmScopeRefusal("npm error 404  'left-pad@9.9.9' is not in this registry.")).toBeNull();
});

it('says nothing when there is no 404', () => {
  expect(npmScopeRefusal('added 120 packages from @recipes/ui in 3s')).toBeNull();
  expect(npmScopeRefusal('')).toBeNull();
});
