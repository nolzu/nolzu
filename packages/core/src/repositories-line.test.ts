import { describe, expect, it } from 'vitest';
import { repositoriesLine } from './repositories-line.ts';

const known = ['.', 'api', 'web'];

describe('repositoriesLine', () => {
  it('reads the names on the line', () => {
    expect(repositoriesLine('# Refined\n\nText.\n\nRepositories: api, web\n', known)).toEqual({ known: ['api', 'web'], unknown: [] });
  });

  it('reads the last such line and ignores an earlier one', () => {
    const text = 'Repositories: web\n\n## Plan\n\n1. Change the API.\n\nRepositories: api\n';
    expect(repositoriesLine(text, known)).toEqual({ known: ['api'], unknown: [] });
  });

  it('splits known names from unknown ones', () => {
    expect(repositoriesLine('Repositories: api, billing, web, docs', known)).toEqual({ known: ['api', 'web'], unknown: ['billing', 'docs'] });
  });

  // The plan skill's sections since the brief has ids: the line still ends the file, after Settled questions.
  it('reads the line under the sections of a plan with Covers and Settled questions', () => {
    const plan = '## Approach\n\nFilter in the api.\n\n## Steps\n\n1. Add the option.\n   Files: api/src/recipes.ts\n   Covers: AC1\n\n## Not doing\n\nIngredients.\n\n## Settled questions\n\n- Titles only? Yes.\n\nRepositories: api\n';
    expect(repositoriesLine(plan, known)).toEqual({ known: ['api'], unknown: [] });
  });

  it('answers null when there is no such line', () => {
    expect(repositoriesLine('# Plan\n\nThe repositories are api and web.\n', known)).toBeNull();
  });

  it('takes the project root as a dot, and names in backticks or with a slash', () => {
    expect(repositoriesLine('Repositories: `.`, `api/`, web', known)).toEqual({ known: ['.', 'api', 'web'], unknown: [] });
  });

  it('names each repository once and skips empty names', () => {
    expect(repositoriesLine('Repositories: api, , api,web,', known)).toEqual({ known: ['api', 'web'], unknown: [] });
  });

  it('reads a line that names nothing as an empty list', () => {
    expect(repositoriesLine('Repositories:', known)).toEqual({ known: [], unknown: [] });
  });

  it('does not read a line that only mentions the word', () => {
    expect(repositoriesLine('The Repositories: api line comes last.\n', known)).toBeNull();
  });

  it('reads the line inside a list item or in bold', () => {
    expect(repositoriesLine('**Repositories:** api, web\n', known)).toEqual({ known: ['api', 'web'], unknown: [] });
    expect(repositoriesLine('- Repositories: api\n', known)).toEqual({ known: ['api'], unknown: [] });
    expect(repositoriesLine('* **Repositories**: web\n', known)).toEqual({ known: ['web'], unknown: [] });
  });

  it('matches a name whatever its case and gives back the project spelling', () => {
    expect(repositoriesLine('Repositories: API, Web, Billing', known)).toEqual({ known: ['api', 'web'], unknown: ['Billing'] });
  });
});
