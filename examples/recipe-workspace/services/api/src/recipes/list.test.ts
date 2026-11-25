import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listRecipes } from './list.ts';

test('lists every recipe in the data file', () => {
  const recipes = listRecipes();
  assert.ok(recipes.length >= 3, 'the demo needs a few recipes to be worth filtering');
  for (const recipe of recipes) {
    assert.equal(typeof recipe.title, 'string');
    assert.notEqual(recipe.title, '');
    assert.ok(recipe.minutes > 0);
  }
});

test('gives every recipe its own id', () => {
  const ids = listRecipes().map((recipe) => recipe.id);
  assert.equal(new Set(ids).size, ids.length);
});
