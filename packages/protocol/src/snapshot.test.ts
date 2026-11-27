import { expect, it } from 'vitest';
import { actionsJob, checkWords, matchPlan } from './snapshot.ts';

const task = (key: string, title: string) => ({ key, title });

it('pairs each step of the plan with the linked task of the same title, in plan order', () => {
  const linked = [task('APP-3', 'Search by ingredient'), task('APP-2', 'Add a recipe')];

  expect(matchPlan(['Add a recipe', 'Search by ingredient', 'Print a shopping list'], linked)).toEqual([linked[1], linked[0], null]);
});

it('gives one task to one step, so two steps with one title need two cards', () => {
  const linked = [task('APP-2', 'Add a recipe')];

  expect(matchPlan(['Add a recipe', 'Add a recipe'], linked)).toEqual([linked[0], null]);
});

it('reads a title with spaces at its ends as the same title', () => {
  const linked = [task('APP-2', ' Add a recipe ')];

  expect(matchPlan(['Add a recipe  '], linked)).toEqual([linked[0]]);
});

it('matches nothing with no plan, and a step with no task stays open', () => {
  expect(matchPlan([], [task('APP-2', 'Add a recipe')])).toEqual([]);
  expect(matchPlan(['Add a recipe'], [])).toEqual([null]);
});

it('pairs a task with the step it was made from when the person changed its title before adding it', () => {
  const linked = [{ key: 'APP-2', title: 'Add a recipe with a photo', step: 'Add a recipe' }, task('APP-3', 'Search by ingredient')];

  expect(matchPlan(['Add a recipe', 'Search by ingredient'], linked)).toEqual([linked[0], linked[1]]);
});

// "1 file problem" says nothing. The chip names the file and what is wrong with it.
it('says the output check problems in a few words, and in full', () => {
  const missing = (file: string) => ({ file, problem: 'The file is missing.' });

  expect(checkWords([missing('implement/summary.md')])).toEqual({ short: 'summary missing', full: 'implement/summary.md: The file is missing.' });
  expect(checkWords([missing('implement/summary.md'), missing('share/TESTING.md')]).short).toBe('2 files missing');
  expect(checkWords([{ file: 'plan/plan.md', problem: 'The file is empty.' }]).short).toBe('plan empty');
  const heading = { file: 'implement/progress.md', problem: 'The heading "## Steps done" is missing.' };
  expect(checkWords([heading]).short).toBe('progress, 1 problem');
  expect(checkWords([heading, { ...heading, problem: 'The section "## Review" is empty.' }]).short).toBe('progress, 2 problems');
  expect(checkWords([heading, missing('implement/summary.md')])).toEqual({
    short: '2 files, 2 problems',
    full: 'implement/progress.md: The heading "## Steps done" is missing. implement/summary.md: The file is missing.',
  });
});

// Fix CI reads a log only by the ids a GitHub Actions job link names, and never guesses one.
it('reads the run and job ids of a GitHub Actions job link of the pull request\'s repository, and nothing from any other link', () => {
  expect(actionsJob('https://github.com/example/recipes/actions/runs/123/job/456', 'example/recipes')).toEqual({ owner: 'example', repo: 'recipes', run: '123', job: '456' });
  expect(actionsJob('https://github.com/example/recipes/actions/runs/123/job/456?pr=12#step:4:9', 'example/recipes')).toEqual({ owner: 'example', repo: 'recipes', run: '123', job: '456' });
  expect(actionsJob('https://github.com/example/recipes/actions/runs/123', 'example/recipes')).toBeNull();
  expect(actionsJob('https://github.com/example/recipes/runs/456', 'example/recipes')).toBeNull();
  expect(actionsJob('https://ci.example.com/example/recipes/actions/runs/123/job/456', 'example/recipes')).toBeNull();
  expect(actionsJob('http://github.com/example/recipes/actions/runs/123/job/456', 'example/recipes')).toBeNull();
  expect(actionsJob('https://github.com/example/recipes/actions/runs/123/job/456/../../../../x', 'example/recipes')).toBeNull();
  expect(actionsJob('https://github.com/../recipes/actions/runs/123/job/456', 'example/recipes')).toBeNull();
  expect(actionsJob('https://github.com/example/recipes/actions/runs/12a/job/456', 'example/recipes')).toBeNull();
  expect(actionsJob(null, 'example/recipes')).toBeNull();
  expect(actionsJob('https://github.com/Example/Recipes/actions/runs/1/job/2', 'example/recipes')).toEqual({ owner: 'Example', repo: 'Recipes', run: '1', job: '2' });
  expect(actionsJob('https://github.com/someone/else/actions/runs/1/job/2', 'example/recipes')).toBeNull();
});
