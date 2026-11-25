import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlan, shareTasks, stepBodies } from './plan.ts';

// The example the plan skill gives the run, as the run would write it: the indented block under the
// skill's own sentence, four spaces off.
function skillExample(): string {
  const skill = readFileSync(join(import.meta.dirname, '..', '..', '..', 'skills', 'skills', 'nolzu-plan', 'SKILL.md'), 'utf8');
  const lines = skill.split('\n');
  const start = lines.findIndex((line) => line.startsWith('    1. '));
  const end = lines.findIndex((line, at) => at > start && line !== '' && !line.startsWith('    '));
  return lines
    .slice(start, end)
    .map((line) => line.slice(4))
    .join('\n');
}

describe('parsePlan', () => {
  // The skill and the parser are one pair. A form changed in one and not the other would turn every
  // plan into plain text, and nothing else in the suite would say so.
  it('reads the example the skill gives the run, each step with its files', () => {
    expect(parsePlan(skillExample())).toEqual({
      steps: [
        { text: 'Add a q option to GET /recipes that matches the title and ignores case.', files: ['api/src/recipes.ts', 'api/test/recipes.test.ts'], covers: ['AC1'] },
        { text: 'Put a search box above the list that asks the api 200 ms after the last key.', files: ['web/src/routes/+page.svelte'], covers: ['AC1', 'AC2'] },
      ],
      text: null,
    });
  });

  // The sections the plan skill writes since the brief has ids: Approach above the steps, Not doing and
  // the rest after them. A step that covers none has no covers.
  it('reads the steps between Approach and Not doing, each with its Covers ids', () => {
    const plan = [
      '## Approach',
      '',
      'The api filters the recipes by title. The page asks it again as the person types.',
      '',
      '## Steps',
      '',
      '1. Add the search option.',
      '   Files: api/src/recipes.ts',
      '   Tests: an empty query, written first.',
      '   Undo: revert the file.',
      '   Covers: AC1, ac2',
      '2. Move the list helper out of the page.',
      '   Files: web/src/list.ts (new)',
      '   Covers: none',
      '',
      '## Not doing',
      '',
      '1. Ingredient search.',
      '',
      '## Settled questions',
      '',
      'Repositories: api, web',
    ].join('\n');

    expect(parsePlan(plan)?.steps).toEqual([
      { text: 'Add the search option.', files: ['api/src/recipes.ts'], covers: ['AC1', 'AC2'] },
      { text: 'Move the list helper out of the page.', files: ['web/src/list.ts'] },
    ]);
  });

  it('skips a title above the steps, and stops at the sections after them', () => {
    const plan = [
      '# Plan for APP-1',
      '',
      '1. Add the search option.',
      '   Files: api/src/recipes.ts',
      '',
      '## Risks',
      '',
      '1. A slow list would show the delay.',
      '',
      'Repositories: api, web',
    ].join('\n');

    expect(parsePlan(plan)?.steps).toEqual([{ text: 'Add the search option.', files: ['api/src/recipes.ts'] }]);
  });

  it('reads files in backticks, in a list under the field, and a step written as a heading', () => {
    const plan = [
      '### 1. Add `filterRecipes` to the list module',
      '- **Files:** `services/api/src/recipes/list.ts` (new), `services/api/src/index.ts`',
      '- Tests: an empty query.',
      '### 2. Wire the box',
      '   Files:',
      '   - web/src/routes/+page.svelte: the box',
      '   - web/src/lib/search.ts (new)',
      '   Tests:',
      '   - the box sends the query.',
    ].join('\n');

    expect(parsePlan(plan)?.steps).toEqual([
      { text: 'Add `filterRecipes` to the list module', files: ['services/api/src/recipes/list.ts', 'services/api/src/index.ts'] },
      { text: 'Wire the box', files: ['web/src/routes/+page.svelte', 'web/src/lib/search.ts'] },
    ]);
  });

  it('reads a step that names no files, and a field that says none', () => {
    expect(parsePlan('1. Test an empty query.\n2. Write the note.\n   Files: none\n')?.steps).toEqual([
      { text: 'Test an empty query.', files: [] },
      { text: 'Write the note.', files: [] },
    ]);
  });

  // A plan that left the form still shows all it says, as the run wrote it.
  it('hands back a plan with no numbered step as text', () => {
    const prose = 'The search runs in the api.\n\nThen the page sends what the person types.';

    expect(parsePlan(prose)).toEqual({ steps: null, text: prose });
  });

  // A skipped number means the list is not the one the skill asks for, and a step read from half of it
  // would hide the rest. The whole file goes back as text.
  it('hands back a plan whose numbers skip as text', () => {
    expect(parsePlan('1. Add the option.\n3. Wire the box.')).toEqual({ steps: null, text: '1. Add the option.\n3. Wire the box.' });
  });

  it('hands back a step with no words as text', () => {
    expect(parsePlan('1.\n   Files: api/src/recipes.ts')?.steps).toBeNull();
  });

  // The review block, Read at and the decisions sit above the steps, and Rules that apply and Read
  // first below them, so none of their lines may read as a step.
  it('reads the steps of a plan with the review block, decisions and Read first', () => {
    const plan = [
      '## Before you approve',
      '',
      '- Concluded: the api filters the list.',
      '- Size: 1 step, 1 file. AC1 goes to step 1.',
      '',
      '## Approach',
      '',
      'Read at: 4f2a91c on 2026-10-24.',
      'The api filters the list.',
      '',
      '## Decisions',
      '',
      '- D1: The api filters. Not: the page.',
      '',
      '## Steps',
      '',
      '1. Add the search option.',
      '   Files: api/src/recipes.ts',
      '   Uses: listRecipes(db) in api/src/recipes.ts.',
      '   Check: npm test passes.',
      '   Covers: AC1',
      '',
      '## Read first',
      '',
      '- api/src/recipes.ts: listRecipes.',
    ].join('\n');

    expect(parsePlan(plan)).toEqual({ steps: [{ text: 'Add the search option.', files: ['api/src/recipes.ts'], covers: ['AC1'] }], text: null });
  });

  it('reads nothing from an empty file', () => {
    expect(parsePlan('  \n')).toBeNull();
  });
});

// An epic's plan in the full form: each step becomes one Delivery task, titled by its sentence, with
// the step's fields as its description and nothing from the sections around the steps.
describe('an epic plan in the full form', () => {
  const plan = [
    '## Before you approve',
    '',
    '- Concluded: three tasks, the api first.',
    '- Decide: D4, one search endpoint for both pages.',
    '- Size: 3 steps, 4 files. AC1 to AC3 each go to a step.',
    '',
    '## Approach',
    '',
    'Read at: 4f2a91c on 2026-10-24.',
    'The api gets one search endpoint, and both pages ask it.',
    '',
    '## Decisions',
    '',
    '- D4: One endpoint for both pages. Not: one per page, because they filter the same list.',
    '',
    '## Steps',
    '',
    '1. Add GET /search to the api.',
    '   Files: api/src/search.ts (new)',
    '   Uses:',
    '     - api/src/recipes.ts: listRecipes, which it filters.',
    '   Tests: an empty query and a title match.',
    '   Check: npm test -- search fails first, then passes.',
    '   Undo: delete the file.',
    '   Covers: AC1',
    '2. Ask it from the list page.',
    '   Files: web/src/routes/+page.svelte',
    '   Uses: GET /search from step 1.',
    '   Copy: the tag filter in web/src/routes/tags/+page.svelte.',
    '   Check: npm test -- page passes.',
    '   Undo: revert the page.',
    '   Covers: AC2',
    '3. Ask it from the planner page.',
    '   Files: web/src/routes/planner/+page.svelte, web/src/lib/search.ts',
    '   Check: npm test -- planner passes.',
    '   Undo: revert both files.',
    '   Covers: AC3',
    '',
    '## Risks',
    '',
    'A slow list makes both pages lag.',
    '',
    '## Order',
    '',
    'Step 1 before the others.',
    '',
    '## Settled questions',
    '',
    '- Q1: titles only, the brief default.',
    '',
    '## Rules that apply',
    '',
    'None.',
    '',
    '## Not doing',
    '',
    'Ingredient search.',
    '',
    '## Read first',
    '',
    '- api/src/recipes.ts: listRecipes, which step 1 filters.',
    '',
    'Repositories: api, web',
  ].join('\n');

  it('makes one task per step, with its title and files, and a bullet under Uses is not a file', () => {
    expect(parsePlan(plan)?.steps).toEqual([
      { text: 'Add GET /search to the api.', files: ['api/src/search.ts'], covers: ['AC1'] },
      { text: 'Ask it from the list page.', files: ['web/src/routes/+page.svelte'], covers: ['AC2'] },
      { text: 'Ask it from the planner page.', files: ['web/src/routes/planner/+page.svelte', 'web/src/lib/search.ts'], covers: ['AC3'] },
    ]);
  });

  it('gives each task its fields as a short list, and the last one stops at Risks', () => {
    const bodies = stepBodies(plan) ?? [];
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toBe(
      [
        'Ask it from the list page.',
        '',
        '- Files: web/src/routes/+page.svelte',
        '- Uses: GET /search from step 1.',
        '- Copy: the tag filter in web/src/routes/tags/+page.svelte.',
        '- Check: npm test -- page passes.',
        '- Undo: revert the page.',
        '- Covers: AC2',
      ].join('\n'),
    );
    expect(bodies[0]).toContain('- Uses:\n  - api/src/recipes.ts: listRecipes, which it filters.');
    expect(bodies[2]?.endsWith('- Covers: AC3')).toBe(true);
  });
});

describe('stepBodies', () => {
  // An epic's task takes its step as its description, so the task run starts from what Plan wrote.
  it('gives each step its sentence and its fields as a list, Uses, Copy and Check too, in the skill example', () => {
    expect(stepBodies(skillExample())).toEqual([
      [
        'Add a q option to GET /recipes that matches the title and ignores case.',
        '',
        '- Files: api/src/recipes.ts, api/test/recipes.test.ts (new)',
        '- Uses: listRecipes(db) in api/src/recipes.ts. Gives listRecipes(db, q?: string) to step 2.',
        '- Copy: the name filter in listTags (api/src/tags.ts).',
        '- Tests: an empty query, part of a word and mixed case, written before the code.',
        '- Check: npm test -- recipes fails on "matches part of a word" first, then passes.',
        '- Undo: revert both files.',
        '- Covers: AC1',
      ].join('\n'),
      [
        'Put a search box above the list that asks the api 200 ms after the last key.',
        '',
        '- Files: web/src/routes/+page.svelte',
        '- Tests: an empty box shows every recipe again.',
        '- Check: npm test -- page passes.',
        '- Undo: revert the page.',
        '- Covers: AC1, AC2',
      ].join('\n'),
    ]);
  });

  it('keeps a Covers line and the list under a field, and stops at the sections after the steps', () => {
    const plan = [
      '# Plan for APP-1',
      '',
      '1. Add the search option.',
      '   Files:',
      '     - api/src/recipes.ts',
      '     - api/test/recipes.test.ts',
      '   Covers: AC1',
      '',
      '## Risks',
      '',
      'A slow list would show the delay.',
    ].join('\n');

    expect(stepBodies(plan)).toEqual(['Add the search option.\n\n- Files:\n  - api/src/recipes.ts\n  - api/test/recipes.test.ts\n- Covers: AC1']);
  });

  it('gives a step with nothing under it its sentence alone, and a drifted plan nothing', () => {
    expect(stepBodies('1. Test an empty query.\n2. Write the note.')).toEqual(['Test an empty query.', 'Write the note.']);
    expect(stepBodies('Some prose with no steps.')).toBeNull();
    expect(stepBodies('')).toBeNull();
  });
});

// An epic task's ticket copies the epic criteria its step covers and the decisions it names, each
// under the epic's key, so the task's own AC1 never clashes with the epic's.
describe('the seed of an epic task', () => {
  const plan = [
    '1. Answer GET /recipes/<id> with one recipe.',
    '   Files: services/api/src/server.ts',
    '   Uses: D1 and D3 of the epic.',
    '   Check: npm test passes.',
    '   Covers: AC2, AC4, AC9',
    '2. Show one recipe on the page.',
    '   Files: services/web/app.js',
    '   Covers: none',
  ].join('\n');
  const seed = {
    key: 'APP-5',
    criteria: [
      { id: 'AC2', level: 'must' as const, text: 'Opening #/recipes/3 shows Lentil stew.', check: 'a browser test opens the address.' },
      { id: 'AC4', level: null, text: 'An unknown id answers 404.', check: null },
    ],
    decisions: [
      { id: 'D1', text: 'One route per recipe. Not: the page picks from the list, because the list grows.' },
      { id: 'D2', text: 'Not named by step 1.' },
      { id: 'D3', text: 'The 404 carries the cross-origin header.' },
    ],
  };

  it('copies the criteria of Covers and the decisions the step names, in their order, and skips an id the epic lacks', () => {
    const bodies = stepBodies(plan, seed) ?? [];
    expect(bodies[0]).toBe(
      [
        'Answer GET /recipes/<id> with one recipe.',
        '',
        '- Files: services/api/src/server.ts',
        '- Uses: D1 and D3 of the epic.',
        '- Check: npm test passes.',
        '- Covers: AC2, AC4, AC9',
        '',
        '- From APP-5: AC2 (must): Opening #/recipes/3 shows Lentil stew. Check: a browser test opens the address.',
        '- From APP-5: AC4: An unknown id answers 404.',
        '- From APP-5: D1: One route per recipe. Not: the page picks from the list, because the list grows.',
        '- From APP-5: D3: The 404 carries the cross-origin header.',
      ].join('\n'),
    );
    expect(bodies[1]).toBe('Show one recipe on the page.\n\n- Files: services/web/app.js\n- Covers: none');
  });

  it('gives the bodies as before with no seed, or a seed with nothing in it', () => {
    expect(stepBodies(plan, { key: 'APP-5', criteria: [], decisions: [] })).toEqual(stepBodies(plan));
    expect(stepBodies(plan)?.[0]).not.toContain('From APP-5');
  });
});

// An epic's Plan writes a plan for colleagues, whose tasks carry the plan step numbers.
describe('shareTasks', () => {
  const file = [
    'The recipe list gets a search box.',
    '',
    '## Approach',
    '',
    '### 1. Not a task',
    'The approach says it.',
    '',
    '## Tasks',
    '',
    '### 1. Filter recipes by title',
    'The api filters the list.',
    '',
    'Done when part of a title finds it.',
    '',
    '### 3) **Test the filter**',
    'A test proves it.',
    '#### A detail',
    'Not part of the task.',
    '',
    '## Risks',
    '',
    '### 4. Not a task either',
  ].join('\n');

  it('reads each task under ## Tasks by its number, with the text up to the next heading', () => {
    expect([...shareTasks(file)]).toEqual([
      [1, { title: 'Filter recipes by title', description: 'The api filters the list.\n\nDone when part of a title finds it.' }],
      [3, { title: 'Test the filter', description: 'A test proves it.' }],
    ]);
  });

  it('gives none for a file with no Tasks section, and keeps the first of two tasks with one number', () => {
    expect(shareTasks('Plain words only.\n').size).toBe(0);
    expect(shareTasks('## Tasks\n### 2. One\nA\n### 2. Two\nB\n').get(2)).toEqual({ title: 'One', description: 'A' });
    expect(shareTasks('## Tasks\n### 1. Empty\n').get(1)).toEqual({ title: 'Empty', description: '' });
  });
});
