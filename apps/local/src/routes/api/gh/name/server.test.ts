import { beforeEach, expect, it, vi } from 'vitest';

// A recorded gh: `you/meal-planner` is taken and every other name is free, or gh is signed out.
const gh = vi.hoisted(() => ({ signedIn: true, calls: [] as string[][] }));
vi.mock('@nolzu/runner', async (real) => ({
  ...(await real<typeof import('@nolzu/runner')>()),
  ghRunner: () => async (args: readonly string[]) => {
    gh.calls.push([...args]);
    if (!gh.signedIn) throw new Error('gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.');
    return args[2] === 'you/meal-planner' ? { code: 0, stdout: '{"name":"meal-planner"}', stderr: '' } : { code: 1, stdout: '', stderr: `GraphQL: Could not resolve to a Repository with the name '${args[2]}'. (repository)\n` };
  },
}));

const { GET } = await import('./+server.ts');
const ask = async (owner: string, name: string) => (await (await GET({ url: new URL(`http://localhost/api/gh/name?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`) } as never)).json()) as { problem: string | null };

beforeEach(() => {
  gh.calls = [];
  gh.signedIn = true;
});

it('answers no problem for a free name, and the sentence for a taken one', async () => {
  expect(await ask('you', 'recipes')).toEqual({ problem: null });
  expect(await ask('you', 'meal-planner')).toEqual({ problem: 'github.com/you/meal-planner exists already. Pick another name, or add that repository by its URL.' });
  expect(gh.calls).toEqual([
    ['repo', 'view', 'you/recipes', '--json', 'name'],
    ['repo', 'view', 'you/meal-planner', '--json', 'name'],
  ]);
});

// The values come from the address, so an owner or a name that reads as a flag never reaches gh.
it('refuses an owner or a name GitHub would refuse before gh sees it', async () => {
  expect(await ask('--help', 'recipes')).toEqual({ problem: '"--help" is not a GitHub account name.' });
  expect(await ask('you', 'my recipes')).toEqual({ problem: '"my recipes" cannot be a repository name on GitHub. Use letters, digits, ".", "-" and "_".' });
  expect(gh.calls).toEqual([]);
});

it('says what gh said when it is signed out', async () => {
  gh.signedIn = false;

  expect(await ask('you', 'recipes')).toEqual({ problem: 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.' });
});
