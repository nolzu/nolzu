import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createLocalTicket, openDatabase, relatedCards, reposOfCard, writeSetting } from '@nolzu/core/node';
import { BOARD_KINDS, type TicketAdapter, type TicketRef } from '@nolzu/protocol';
import { ghRunner, type RunGh } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextSources, createCardFrom, githubSource, nextCardKey, postCard, refOwner, remoteOwner } from './create-card.ts';
import { CONTEXT_LIMIT } from './overview.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-create-'));
  db = openDatabase(dir);
  writeSetting(db, 'localKeyPrefix', 'APP');
  createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Add a search box', description: '' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const row = (key: string) =>
  db.prepare('SELECT board, stage, state, title, summary, extra_context, source, source_ref FROM cards WHERE key = ?').get(key) as
    | Record<string, unknown>
    | undefined;
const count = () => (db.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n;
const pullRow = (key: string) =>
  db.prepare('SELECT pr_author, pr_decision, pr_head_at, pr_draft FROM cards WHERE key = ?').get(key) as Record<string, unknown> | undefined;

// An adapter that answers from a list and records what it was asked. No adapter is connected to Add
// card, so the service takes one only to show where one would plug in.
function stubAdapter(tickets: Record<string, { title: string; body: string }>): TicketAdapter & { asked: TicketRef[] } {
  const asked: TicketRef[] = [];
  return {
    name: 'stub',
    asked,
    async get(refs) {
      asked.push(...refs);
      return refs.map((ref) => {
        const key = ref.kind === 'external' ? ref.key : '';
        const found = tickets[key];
        return { ref, notFound: found === undefined, ticket: found === undefined ? null : { key, title: found.title, body: found.body, state: 'open', url: null, parentKey: null } };
      });
    },
    search: async () => [],
  };
}

it('makes a local ticket with the next key from free text, in the inbox', async () => {
  const made = await createCardFrom(db, {}, { input: 'Sort the list by time', description: 'Quickest first.' });

  expect(made).toEqual({ key: 'APP-2', note: null });
  expect(row('APP-2')).toMatchObject({ board: 'delivery', stage: 'inbox', state: 'idle', title: 'Sort the list by time', summary: 'Quickest first.', source: 'local' });
});

// A whole idea typed into Add card or Start from an idea: the board shows its first line, cut, and
// the card's text keeps every word.
it('makes the first line of long typed text the title and keeps the whole text as the body', async () => {
  const idea = 'A recipe app where a cook saves recipes, searches them by ingredient and plans the meals of a whole week';
  await createCardFrom(db, {}, { input: idea });
  const made = row('APP-2') as { title: string; summary: string };
  expect(made.title.length).toBeLessThanOrEqual(80);
  expect(made.title.endsWith('…')).toBe(true);
  expect(made.summary).toBe(idea);

  await createCardFrom(db, {}, { input: '', title: 'Search the recipes\nBy ingredient and by title.' });
  expect(row('APP-3')).toMatchObject({ title: 'Search the recipes', summary: 'Search the recipes\nBy ingredient and by title.' });
});

it('takes the title field over the typed text when both are given', async () => {
  await createCardFrom(db, {}, { input: 'sort', title: 'Sort the list by time' });

  expect(row('APP-2')?.title).toBe('Sort the list by time');
});

it('keeps an external key with its ref and says the ticket is not loaded, when no adapter can read it', async () => {
  const made = await createCardFrom(db, {}, { input: 'PROJ-123' });

  expect(made.key).toBe('PROJ-123');
  expect(made.note).toMatch(/not loaded/);
  expect(row('PROJ-123')).toMatchObject({ title: 'PROJ-123', summary: null, source: 'external', source_ref: 'PROJ-123' });
});

it('reads an external ticket through the adapter it is given', async () => {
  const adapter = stubAdapter({ 'PROJ-123': { title: 'Search by ingredient', body: 'Match ingredients too.' } });

  const made = await createCardFrom(db, { external: adapter }, { input: 'PROJ-123' });

  expect(adapter.asked).toEqual([{ kind: 'external', key: 'PROJ-123' }]);
  expect(made).toEqual({ key: 'PROJ-123', note: null });
  expect(row('PROJ-123')).toMatchObject({ title: 'Search by ingredient', summary: 'Match ingredients too.', source: 'stub' });
});

it('refuses an external key the adapter did not find, and writes nothing', async () => {
  await expect(createCardFrom(db, { external: stubAdapter({}) }, { input: 'PROJ-9' })).rejects.toThrow(/PROJ-9 is not in stub/);
  expect(count()).toBe(1);
});

// Two states, and one fix each. Jira answers a refused token with the same 404 and the same
// sentence as a ticket that is gone, so one refusal for both would send a person to Jira to hunt
// for a ticket that is fine.
it('tells a ticket that is gone from a read that never got an answer', async () => {
  const quiet: TicketAdapter = {
    name: 'stub',
    get: async (refs) => refs.map((ref) => ({ ref, ticket: null, notFound: false })),
    search: async () => [],
  };
  await expect(createCardFrom(db, { external: quiet }, { input: 'PROJ-9' })).rejects.toThrow(
    /could not be read from stub\. The call failed/,
  );
  expect(count()).toBe(1);
});

// The id goes into the card row, and the sentence a person reads takes the name they know the
// system by.
it('names the ticket system the way a person writes it', async () => {
  const jira: TicketAdapter = { ...stubAdapter({}), name: 'jira', title: 'Jira' };

  await expect(createCardFrom(db, { external: jira }, { input: 'PROJ-9' })).rejects.toThrow('PROJ-9 is not in Jira.');
});

it('passes a refusal from the ticket system on, so a refused token reaches the person', async () => {
  const refuses: TicketAdapter = {
    name: 'stub',
    get: () => Promise.reject(new Error('Jira refused the API token, so nothing was read.')),
    search: async () => [],
  };

  await expect(createCardFrom(db, { external: refuses }, { input: 'PROJ-9' })).rejects.toThrow(/refused the API token/);
  expect(count()).toBe(1);
});

it('refuses a typed local key that already exists, points at the card and writes nothing', async () => {
  await expect(createCardFrom(db, {}, { input: 'APP-1' })).rejects.toThrow(/APP-1 is already on the board/);
  expect(count()).toBe(1);
});

it('refuses a typed local key that does not exist, because local keys are counted and not chosen', async () => {
  await expect(createCardFrom(db, {}, { input: 'APP-99' })).rejects.toThrow(/APP-99/);
  expect(count()).toBe(1);
});

it('refuses a GitHub issue when the caller gave no way to reach gh, and writes nothing', async () => {
  await expect(createCardFrom(db, {}, { input: 'recipes#12' })).rejects.toThrow(/cannot read GitHub issues/);
  expect(count()).toBe(1);
});

it.each(['', '   '])('refuses an empty input %j', async (input) => {
  await expect(createCardFrom(db, {}, { input })).rejects.toThrow(/title or a ticket key/);
  expect(count()).toBe(1);
});

it('puts the extra context on the new card, typed or copied from another card', async () => {
  await createCardFrom(db, {}, { input: 'Sort the list', extra: 'Keep the old order for ties.' });

  expect(row('APP-2')?.extra_context).toBe('Keep the old order for ties.');
});

it('links the requested cards to the new one', async () => {
  const made = await createCardFrom(db, {}, { input: 'Sort the list', links: ['APP-1'] });

  expect(relatedCards(db, made.key)).toEqual([{ key: 'APP-1', title: 'Add a search box' }]);
});

// One write: a link that fails leaves no card behind it, and no key is used up.
it('writes nothing, not even the card, when a link cannot be made', async () => {
  await expect(createCardFrom(db, {}, { input: 'Sort the list', links: ['APP-7'] })).rejects.toThrow(/APP-7/);
  expect(count()).toBe(1);

  const next = await createCardFrom(db, {}, { input: 'Sort the list' });
  expect(next.key).toBe('APP-2');
});

it('refuses a name that is no board at all, names the boards there are, and writes nothing', async () => {
  // The names come from the board list, so the sentence stays true the day a board is added.
  await expect(createCardFrom(db, {}, { input: 'Sort the list', board: 'roadmap' })).rejects.toThrow(
    `There is no roadmap board here. A card goes on one of these: ${BOARD_KINDS.join(', ')}.`,
  );
  expect(count()).toBe(1);
});

// The first stage is not `inbox` everywhere: the PR reviews board starts at Incoming. A card written
// to a stage its own board has not got is in the database with no column to draw it.
// The last row is a card made from a ticket key. Free text and a ticket key write the row on two
// separate lines, so each one can regress to `inbox` on its own.
it.each([
  ['delivery', 'inbox', 'Sort the list'],
  ['epics', 'inbox', 'Sort the list'],
  ['investigations', 'inbox', 'Sort the list'],
  ['questions', 'inbox', 'Sort the list'],
  ['prreview', 'incoming', 'Sort the list'],
  ['prreview', 'incoming', 'PROJ-123'],
])('makes a card on the %s board, on its first stage, from %j', async (board, stage, input) => {
  const made = await createCardFrom(db, { external: stubAdapter({ 'PROJ-123': { title: 'Review the pull request', body: '' } }) }, { input, board });

  expect(row(made.key)).toMatchObject({ board, stage, state: 'idle' });
});

it('keeps the project prefix and one counter on every board but the two Research kinds', async () => {
  // One database holds every board and a card key is unique across it, so a card on another board
  // takes the next project key. A question and an investigation count under their own prefixes, Q and
  // INV. APP-1 is the card the setup made.
  const keys = [];
  for (const board of BOARD_KINDS) keys.push((await createCardFrom(db, {}, { input: 'Sort the list', board })).key);
  expect(keys).toEqual(['APP-2', 'APP-3', 'INV-1', 'Q-1', 'APP-4']);
  expect(nextCardKey(db, 'questions')).toBe('Q-2');
  expect(nextCardKey(db)).toBe('APP-5');
});

it('asks the adapter nothing for free text', async () => {
  const adapter = stubAdapter({});
  const get = vi.spyOn(adapter, 'get');

  await createCardFrom(db, { external: adapter }, { input: 'Sort the list' });

  expect(get).not.toHaveBeenCalled();
});

// Recorded from a real `gh api graphql` read on 2026-09-25, with the names changed. The shapes are
// what GitHub answers, not what a stub author guessed: an issue, a number that belongs to a pull
// request, an issue that is gone, a repository this login cannot open, and a whole call that was
// refused.
const ISSUE = '{"data":{"t0":{"issueOrPullRequest":{"__typename":"Issue","number":12,"title":"Search by ingredient","body":"Match ingredients too.","state":"OPEN","url":"https://github.com/cook/recipes/issues/12","parent":null}}}}';
const PULL_REQUEST = '{"data":{"t0":{"issueOrPullRequest":{"__typename":"PullRequest"}}}}';
const GONE = '{"data":{"t0":{"issueOrPullRequest":null}},"errors":[{"type":"NOT_FOUND","path":["t0","issueOrPullRequest"],"message":"Could not resolve to an issue or pull request with the number of 12."}]}';
const NO_REPOSITORY = '{"data":{"t0":null},"errors":[{"type":"NOT_FOUND","path":["t0"],"message":"Could not resolve to a Repository with the name \'cook/recipes\'."}]}';
const REFUSED = '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}';

// A `gh` of our own. It answers with one of the recordings above, or fails the way the real runner
// fails when there is no gh and when gh has no login.
function ghSource(answer: string | Error, defaultOwner: string | null = null) {
  const calls: string[][] = [];
  // How often the source was built. Building the real one spawns git to find the default owner,
  // and a card that never touches GitHub must not pay for it.
  const built: string[] = [];
  const run: RunGh = async (args) => {
    calls.push([...args]);
    if (answer instanceof Error) throw answer;
    return { code: 0, stdout: answer, stderr: '' };
  };
  const source = async () => {
    built.push('built');
    return { run, defaultOwner };
  };
  return { calls, built, source, run };
}

describe('a GitHub issue', () => {
  // Keyed repo#n like a pull request card, so the card names a folder and can run. The owner stays on
  // the card as its source ref.
  it('makes a card from the issue, keyed by repository and number, with the full name as its ref', async () => {
    const gh = ghSource(ISSUE);

    const made = await createCardFrom(db, { github: gh.source }, { input: 'cook/recipes#12' });

    expect(made).toEqual({ key: 'recipes#12', note: null });
    expect(row('recipes#12')).toMatchObject({
      board: 'delivery',
      stage: 'inbox',
      state: 'idle',
      title: 'Search by ingredient',
      summary: 'Match ingredients too.',
      source: 'github',
      source_ref: 'cook/recipes#12',
    });
  });

  // The Research add box sends an issue link as input too, and the issue lands in that board's Inbox.
  it('makes a Research card from an issue link, with its title and text', async () => {
    const gh = ghSource(ISSUE);

    const made = await createCardFrom(db, { github: gh.source }, { input: 'https://github.com/cook/recipes/issues/12', board: 'questions' });

    expect(made.key).toBe('recipes#12');
    expect(row('recipes#12')).toMatchObject({ board: 'questions', stage: 'inbox', title: 'Search by ingredient', summary: 'Match ingredients too.', source_ref: 'cook/recipes#12' });
  });

  // The default owner and the project remote meet in one line of postCard, which the route tests at
  // the end run. This half is the adapter's: the card lands under the owner the caller handed in.
  it('lands under the default owner the caller gives, when the ref names none', async () => {
    const gh = ghSource(ISSUE, 'cook');

    const made = await createCardFrom(db, { github: gh.source }, { input: 'recipes#12' });

    expect(made.key).toBe('recipes#12');
    expect(row('recipes#12')).toMatchObject({ title: 'Search by ingredient', source_ref: 'cook/recipes#12' });
  });

  // Finding the default owner spawns git in the project folder. A card typed as free text never
  // needs one, and a project folder on a slow mount would pay for it on every card.
  it('goes looking for no GitHub owner when the card is free text', async () => {
    const gh = ghSource(ISSUE, 'cook');

    await createCardFrom(db, { github: gh.source }, { input: 'Sort the list by time' });

    expect(gh.built).toEqual([]);
  });

  it('asks for the owner when the ref names none and the project has no GitHub remote', async () => {
    const gh = ghSource(ISSUE);

    await expect(createCardFrom(db, { github: gh.source }, { input: 'recipes#12' })).rejects.toThrow('as in owner/recipes#12');
    // Nothing was read, because a guessed owner would open somebody else's repository.
    expect(gh.calls).toEqual([]);
    expect(count()).toBe(1);
  });

  // The three states GitHub cannot tell apart. Each one answers not found, so they share a
  // sentence that names all three.
  it.each([
    ['an issue that is gone', GONE],
    ['a number that belongs to a pull request', PULL_REQUEST],
    ['a repository this login cannot open', NO_REPOSITORY],
  ])('says the issue is not there for %s, and writes nothing', async (_what, answer) => {
    const gh = ghSource(answer);

    await expect(createCardFrom(db, { github: gh.source }, { input: 'cook/recipes#12' })).rejects.toThrow(
      'GitHub has no issue cook/recipes#12',
    );
    expect(count()).toBe(1);
  });

  // The other half of the pair. A call that never got an answer must not read as an issue that is
  // gone, because the fix is to try again and not to go looking on GitHub.
  it('says the call failed when the whole query was refused, and writes nothing', async () => {
    const gh = ghSource(REFUSED);

    await expect(createCardFrom(db, { github: gh.source }, { input: 'cook/recipes#12' })).rejects.toThrow(
      'could not be read from GitHub',
    );
    expect(count()).toBe(1);
  });

  it('says to install gh when there is none, and writes nothing', async () => {
    const gh = ghSource(new Error('gh is not on the PATH, so Nolzu cannot read GitHub issues. Install the GitHub CLI from https://cli.github.com, then start Nolzu again.'));

    await expect(createCardFrom(db, { github: gh.source }, { input: 'cook/recipes#12' })).rejects.toThrow(/Install the GitHub CLI/);
    expect(count()).toBe(1);
  });

  it('says to log in when gh has no login, and writes nothing', async () => {
    const gh = ghSource(new Error('gh is not logged in to GitHub. Run gh auth login in a terminal, then add the card again.'));

    await expect(createCardFrom(db, { github: gh.source }, { input: 'cook/recipes#12' })).rejects.toThrow(/Run gh auth login/);
    expect(count()).toBe(1);
  });

  // The key carries no owner, so another owner's recipes#12 is the same key. The card that is there
  // stays, and the sentence names whose it is rather than calling this one a card already added.
  it('refuses an issue whose key another owner holds, and names that owner', async () => {
    await createCardFrom(db, { github: ghSource(ISSUE).source }, { input: 'bake/recipes#12' });

    await expect(createCardFrom(db, { github: ghSource(ISSUE).source }, { input: 'cook/recipes#12', board: 'epics' })).rejects.toThrow(
      'recipes#12 on the board is bake/recipes#12. A card key carries no owner, so cook/recipes#12 cannot go on the board as well. Type its title to make a local card instead.',
    );
    expect(row('recipes#12')).toMatchObject({ board: 'delivery', source_ref: 'bake/recipes#12' });
  });

  it('says the same issue is already on the board', async () => {
    await createCardFrom(db, { github: ghSource(ISSUE).source }, { input: 'cook/recipes#12' });

    await expect(createCardFrom(db, { github: ghSource(ISSUE).source }, { input: 'cook/recipes#12' })).rejects.toThrow('recipes#12 is already on the board.');
    expect(count()).toBe(2);
  });
});

describe('the owner a bare ref takes', () => {
  const repoAt = (url: string | null): string => {
    const folder = join(dir, 'project');
    mkdirSync(folder, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: folder });
    if (url !== null) execFileSync('git', ['remote', 'add', 'origin', url], { cwd: folder });
    writeSetting(db, 'projectPath', folder);
    return folder;
  };

  it('is the owner of the project origin on github.com', async () => {
    repoAt('https://github.com/cook/recipes.git');

    await expect(remoteOwner(db)).resolves.toBe('cook');
  });

  it('is nobody when the origin is on another host, because gh here talks to github.com', async () => {
    repoAt('https://gitlab.com/cook/recipes.git');

    await expect(remoteOwner(db)).resolves.toBeNull();
  });

  it('is nobody when the project has no origin', async () => {
    repoAt(null);

    await expect(remoteOwner(db)).resolves.toBeNull();
  });

  it('is nobody when no project folder is set', async () => {
    await expect(remoteOwner(db)).resolves.toBeNull();
  });

  // A folder that was moved or deleted. git refuses to run in it, and that is not a reason to
  // refuse every card, free text included.
  it('is nobody when the project folder is gone', async () => {
    writeSetting(db, 'projectPath', join(dir, 'moved-away'));

    await expect(remoteOwner(db)).resolves.toBeNull();
  });
});

// A workspace from New project: the project folder has no origin, each repository has its own.
describe('the owner a bare ref takes in a workspace', () => {
  const workspace = (origins: Record<string, string>) => {
    const folder = join(dir, 'workspace');
    for (const [name, url] of Object.entries(origins)) {
      mkdirSync(join(folder, name), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: join(folder, name) });
      execFileSync('git', ['remote', 'add', 'origin', url], { cwd: join(folder, name) });
    }
    execFileSync('git', ['init', '-q'], { cwd: folder });
    writeSetting(db, 'projectPath', folder);
    writeSetting(db, 'repos', Object.keys(origins).map((path) => ({ path, base: 'main' })));
  };

  it('is the owner of the repository with that name', async () => {
    workspace({ api: 'https://github.com/cook/recipes-api.git', web: 'https://github.com/bake/recipes-web.git' });

    await expect(refOwner(db, 'recipes-web')).resolves.toEqual({ owner: 'bake', several: [] });
    await expect(refOwner(db, 'Recipes-API')).resolves.toEqual({ owner: 'cook', several: [] });
  });

  it('is nobody when no repository has the name and the origins have different owners', async () => {
    workspace({ api: 'https://github.com/cook/recipes-api.git', web: 'https://github.com/bake/recipes-web.git' });

    await expect(refOwner(db, 'docs')).resolves.toEqual({ owner: null, several: [] });
  });

  // As the project folder's own origin was before: one owner for every repository.
  it('is the one owner every origin shares when no repository has the name', async () => {
    workspace({ api: 'https://github.com/cook/recipes-api.git', web: 'https://github.com/cook/recipes-web.git' });

    await expect(refOwner(db, 'docs')).resolves.toEqual({ owner: 'cook', several: [] });
  });

  it('names every owner when two repositories have the name', async () => {
    workspace({ api: 'https://github.com/cook/recipes.git', mirror: 'https://github.com/bake/recipes.git' });

    await expect(refOwner(db, 'recipes')).resolves.toEqual({ owner: null, several: ['cook', 'bake'] });
  });

  it('makes the card under that owner, and says why when there are several', async () => {
    workspace({ api: 'https://github.com/cook/recipes.git', mirror: 'https://github.com/bake/recipes.git' });
    const gh = ghSource(ISSUE);
    const source = githubSource(db, gh.run);

    await expect(createCardFrom(db, { github: source }, { input: 'recipes#12' })).rejects.toThrow(
      'Type the owner as well, as in cook/recipes#12. Two repositories of this project are called recipes, from cook and bake, so Nolzu does not know which one you mean.',
    );
    expect(gh.calls).toEqual([]);

    writeSetting(db, 'repos', [{ path: 'api', base: 'main' }]);
    await createCardFrom(db, { github: source }, { input: 'recipes#12' });
    expect(row('recipes#12')).toMatchObject({ source_ref: 'cook/recipes#12' });
  });

  // A review on a workspace needs to know which repository to read, and the link already names it.
  it('gives a pull request card the repository whose origin the link names', async () => {
    workspace({ api: 'https://github.com/cook/menus.git', web: 'https://github.com/Cook/Recipes.git' });

    await createCardFrom(db, { github: githubSource(db, ghSource(PULL).run) }, { input: 'https://github.com/cook/recipes/pull/42', board: 'prreview' });

    expect(reposOfCard(db, 'recipes#42')).toEqual(['web']);
  });

  it('leaves the list to the person when no repository has that origin', async () => {
    workspace({ api: 'https://github.com/cook/menus.git', web: 'https://github.com/bake/recipes.git' });

    await createCardFrom(db, { github: githubSource(db, ghSource(PULL).run) }, { input: 'cook/recipes#42', board: 'prreview' });

    expect(reposOfCard(db, 'recipes#42')).toBeNull();
  });
});

describe('the route', () => {
  const post = (body: unknown) => new Request('http://localhost/api/cards', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('answers 201 with the key and the note, and tells the board', async () => {
    const told = vi.fn();

    const response = await postCard(db, told, post({ input: 'PROJ-123' }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ key: 'PROJ-123', note: expect.stringMatching(/not loaded/) });
    expect(told).toHaveBeenCalledOnce();
  });

  it('answers 409 with the sentence a refusal gives, and tells nobody', async () => {
    const told = vi.fn();

    const response = await postCard(db, told, post({ input: 'APP-1' }));

    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toContain('already on the board');
    expect(told).not.toHaveBeenCalled();
  });

  it('refuses extra context over the limit the overview holds it to', async () => {
    const response = await postCard(db, () => undefined, post({ input: 'Sort the list', extra: 'x'.repeat(CONTEXT_LIMIT + 1) }));

    expect(response.status).toBe(413);
    expect(count()).toBe(1);
  });

  it.each(['not json', { input: 3 }, { input: 'x', links: 'APP-1' }, { input: 'x', links: [1] }, { input: 'x', extra: 1 }, { input: 'x', title: false }])(
    'answers 400 to a body it cannot read: %j',
    async (body) => {
      const response = await postCard(db, () => undefined, post(body));

      expect(response.status).toBe(400);
      expect(count()).toBe(1);
    },
  );
});

// Add card stores a size, shows the key a card will get, and starts the board's first auto stage in the
// same call when its go button asks.
describe('Add and start', () => {
  const post = (body: unknown) => new Request('http://localhost/api/cards', { method: 'POST', body: JSON.stringify(body) });
  const size = (key: string) => (db.prepare('SELECT size FROM cards WHERE key = ?').get(key) as { size: string | null }).size;

  it('stores the size the dialog sent, and none when none was picked', async () => {
    await postCard(db, () => undefined, post({ input: 'Sort recipes by rating', size: 'small' }));
    await postCard(db, () => undefined, post({ input: 'PROJ-7', size: 'large' }));
    await postCard(db, () => undefined, post({ input: 'Show the cooking time' }));

    expect([size('APP-2'), size('PROJ-7'), size('APP-3')]).toEqual(['small', 'large', null]);
  });

  it('previews the key the next local card gets, and the card gets it', async () => {
    db.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-2', 'delivery', 'inbox', 'Held by hand')").run();

    expect(nextCardKey(db)).toBe('APP-3');
    const response = await postCard(db, () => undefined, post({ input: 'Sort recipes by rating' }));
    expect(await response.json()).toMatchObject({ key: 'APP-3' });
    expect(nextCardKey(db)).toBe('APP-4');
  });

  it('makes the card, then starts its first auto stage once', async () => {
    const start = vi.fn(async () => null);

    const response = await postCard(db, () => undefined, post({ input: 'Sort recipes by rating', start: true }), undefined, start);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ key: 'APP-2', note: null });
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith('APP-2', 'refine');
  });

  it.each([
    ['epics', 'refine', 'APP-2'],
    ['investigations', 'research', 'INV-1'],
    ['questions', 'research', 'Q-1'],
    ['prreview', 'pre-review', 'APP-2'],
  ])('starts the stage after the first on %s', async (board, stage, key) => {
    const start = vi.fn(async () => null);

    await postCard(db, () => undefined, post({ input: 'Why is the list slow', board, start: true }), undefined, start);

    expect(start).toHaveBeenCalledWith(key, stage);
  });

  // Cmd Enter and Add to Inbox send no start.
  it('starts nothing when the dialog asks for no start', async () => {
    const start = vi.fn(async () => null);

    await postCard(db, () => undefined, post({ input: 'Sort recipes by rating' }), undefined, start);

    expect(start).not.toHaveBeenCalled();
    expect(row('APP-2')).toMatchObject({ stage: 'inbox', state: 'idle' });
  });

  // False is no start, the same as a start left out.
  it('starts nothing when start is false', async () => {
    const start = vi.fn(async () => null);

    const response = await postCard(db, () => undefined, post({ input: 'Sort recipes by rating', start: false }), undefined, start);

    expect(response.status).toBe(201);
    expect(start).not.toHaveBeenCalled();
    expect(row('APP-2')).toMatchObject({ stage: 'inbox', state: 'idle' });
  });

  // Asked to start with no way to start, it says so rather than answering as if a run started.
  it('says no run started when it was handed no way to start one', async () => {
    const response = await postCard(db, () => undefined, post({ input: 'Sort recipes by rating', start: true }));

    expect(await response.json()).toEqual({ key: 'APP-2', note: null, refused: 'APP-2 was added, and Nolzu started no run from here. Move the card to start one.' });
  });

  // The card is made before the start is asked, so a refused start leaves it in Inbox and the dialog
  // closes on the key, with the reason for the toast.
  it('keeps the card in its first column and says why when the start is refused', async () => {
    const start = vi.fn(async () => ({ status: 409, message: 'APP-2 cannot move from inbox to refine while it is queued.' }));

    const response = await postCard(db, () => undefined, post({ input: 'Sort recipes by rating', start: true }), undefined, start);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ key: 'APP-2', note: null, refused: 'APP-2 cannot move from inbox to refine while it is queued.' });
    expect(row('APP-2')).toMatchObject({ stage: 'inbox', state: 'idle' });
  });

  it('makes no card and starts nothing when the card is refused', async () => {
    const start = vi.fn(async () => null);

    const response = await postCard(db, () => undefined, post({ input: 'APP-1', start: true }), undefined, start);

    expect(response.status).toBe(409);
    expect(start).not.toHaveBeenCalled();
  });

  it.each([{ input: 'x', size: 'huge' }, { input: 'x', size: 3 }, { input: 'x', start: 'yes' }])('answers 400 to a size or a start it cannot read: %j', async (body) => {
    const response = await postCard(db, () => undefined, post(body));

    expect(response.status).toBe(400);
    expect(count()).toBe(1);
  });
});

describe('contextSources', () => {
  it('lists the cards that have extra context, by key, and leaves out the ones with none', () => {
    createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Sort the list', description: '' });
    createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Blank', description: '' });
    db.prepare("UPDATE cards SET extra_context = 'Ties keep their order.' WHERE key = 'APP-2'").run();
    db.prepare("UPDATE cards SET extra_context = '   ' WHERE key = 'APP-3'").run();

    expect(contextSources(db)).toEqual([{ key: 'APP-2', title: 'Sort the list', extra: 'Ties keep their order.' }]);
  });
});

// HAND WRITTEN, AND NOT RECORDED. The envelope is the recorded one above; the fields inside the
// pull request node are written from the query, because reading one would be a call to GitHub and
// none was made. The four recorded envelopes below it are reused unchanged: they say nothing
// about a node's fields, so they hold for a pull request read as they do for an issue.
const PULL = '{"data":{"t0":{"issueOrPullRequest":{"__typename":"PullRequest","number":42,"title":"Cache the recipe list","body":"The list is read on every page, so it is cached for a minute.","url":"https://github.com/cook/recipes/pull/42","state":"OPEN","isDraft":false,"author":{"login":"dana"},"reviewDecision":"CHANGES_REQUESTED","commits":{"nodes":[{"commit":{"committedDate":"2026-09-25T09:00:00.000Z"}}]}}}}}';
const MERGED = PULL.replace('"state":"OPEN"', '"state":"MERGED"');

describe('a GitHub pull request on the PR reviews board', () => {
  const add = (input: string, answer: string | Error = PULL) =>
    createCardFrom(db, { github: ghSource(answer).source }, { input, board: 'prreview' });

  it('makes a card from the pull request, on Incoming, keyed repo#number', async () => {
    const made = await add('cook/recipes#42');

    expect(made).toEqual({ key: 'recipes#42', note: null });
    expect(row('recipes#42')).toMatchObject({
      board: 'prreview',
      stage: 'incoming',
      state: 'idle',
      title: 'Cache the recipe list',
      source: 'github-pr',
      // The key carries no owner, so the owner is kept here. A key with a slash in it would
      // leave the card with no folder for its review round.
      source_ref: 'cook/recipes#42',
    });
    expect(pullRow('recipes#42')).toEqual({
      pr_author: 'dana',
      pr_decision: 'CHANGES_REQUESTED',
      pr_head_at: '2026-09-25T09:00:00.000Z',
      pr_draft: 0,
    });
  });

  // Two owners can carry one repository name, and the key holds only the repository. The old
  // refusal said to open that card, which is somebody else's pull request.
  it('names the pull request the key already holds when two owners share a repository name', async () => {
    await add('cook/recipes#42');

    await expect(add('bake/recipes#42')).rejects.toThrow('recipes#42 on the board is cook/recipes#42. A card key carries no owner, so bake/recipes#42 cannot go on the board as well. Review it on GitHub instead.');
    expect(count()).toBe(2);
  });

  // The same pull request twice is not a clash of two repositories, so it keeps the plain sentence.
  it('says the same pull request is already on the board', async () => {
    await add('cook/recipes#42');

    await expect(add('cook/recipes#42')).rejects.toThrow('recipes#42 is already on the board. Open that card, or use another key.');
  });

  // The mirror of the issue path, which refuses a pull request number. This is a recorded answer,
  // and on this board it is the wrong kind of number.
  it('says the pull request is not there when the number is an issue, and writes nothing', async () => {
    await expect(add('cook/recipes#12', ISSUE)).rejects.toThrow('GitHub has no pull request cook/recipes#12');
    expect(count()).toBe(1);
  });

  it.each([
    ['a pull request that is gone', GONE],
    ['a repository this login cannot open', NO_REPOSITORY],
  ])('says the pull request is not there for %s, and writes nothing', async (_what, answer) => {
    await expect(add('cook/recipes#42', answer)).rejects.toThrow('GitHub has no pull request cook/recipes#42');
    expect(count()).toBe(1);
  });

  // The other half of the pair. A call that got no answer must not read as a pull request that is
  // gone, because the fix is to try again and not to go looking on GitHub.
  it.each([
    ['the whole query was refused', REFUSED],
    ['the body cannot be read', 'Bad credentials'],
    ['the answer is empty', ''],
  ])('says the call failed when %s, and writes nothing', async (_what, answer) => {
    await expect(add('cook/recipes#42', answer)).rejects.toThrow('could not be read from GitHub');
    expect(count()).toBe(1);
  });

  // A merged pull request has nothing left to review, and `stateOf` would have read it as open.
  it('refuses a pull request that is merged, and writes nothing', async () => {
    await expect(add('cook/recipes#42', MERGED)).rejects.toThrow('is merged, so there is nothing to review');
    expect(count()).toBe(1);
  });

  it('says to install gh when there is none, and says to log in when gh has no login', async () => {
    await expect(add('cook/recipes#42', new Error('gh is not on the PATH, so Nolzu cannot read GitHub issues. Install the GitHub CLI from https://cli.github.com, then start Nolzu again.'))).rejects.toThrow(
      /Install the GitHub CLI/,
    );
    await expect(add('cook/recipes#42', new Error('gh is not logged in to GitHub. Run gh auth login in a terminal, then add the card again.'))).rejects.toThrow(/Run gh auth login/);
    expect(count()).toBe(1);
  });

  // Nothing on this machine can read GitHub at all, which is a different fix from a login.
  it('names the fix when this machine cannot reach GitHub at all', async () => {
    await expect(createCardFrom(db, {}, { input: 'cook/recipes#42', board: 'prreview' })).rejects.toThrow(/Install the GitHub CLI/);
  });

  // The skill reads the description to know what the change is meant to do, so the card keeps it as
  // its ticket text. It used to be written null, and the review then had the diff and no intent.
  it('keeps the pull request description as the card ticket text', async () => {
    await add('cook/recipes#42');

    expect(row('recipes#42')?.summary).toBe('The list is read on every page, so it is cached for a minute.');
  });

  it('leaves the ticket text empty for a pull request with no description', async () => {
    await add('cook/recipes#42', PULL.replace('"body":"The list is read on every page, so it is cached for a minute."', '"body":""'));

    expect(row('recipes#42')?.summary).toBeNull();
  });

  it('reads a draft, and a pull request whose author the answer does not carry', async () => {
    const answer = PULL.replace('"isDraft":false', '"isDraft":true').replace('"author":{"login":"dana"}', '"author":null');

    await add('cook/recipes#42', answer);

    expect(pullRow('recipes#42')).toMatchObject({ pr_author: null, pr_draft: 1 });
  });

  // The board decides which of the two is read. The same ref on Delivery is still an issue, and a
  // pull request number there is still refused.
  it('still reads an issue on every other board', async () => {
    const gh = ghSource(ISSUE);

    const made = await createCardFrom(db, { github: gh.source }, { input: 'cook/recipes#12', board: 'delivery' });

    expect(made.key).toBe('recipes#12');
    expect(pullRow('recipes#12')).toEqual({ pr_author: null, pr_decision: null, pr_head_at: null, pr_draft: 0 });
  });
});

// What the Add card dialog sends, through the route, with a gh of our own. The board decides whether
// the number is an issue or a pull request, and each form the dialog takes makes a card on both.
describe('the route, with a GitHub reference', () => {
  const answers =
    (stdout: string): RunGh =>
    async () => ({ code: 0, stdout, stderr: '' });
  const post = (input: string, board: string) =>
    new Request('http://localhost/api/cards', { method: 'POST', body: JSON.stringify({ input, links: [], board }) });

  // The short form takes its owner from the project origin, so the project has one on github.com.
  beforeEach(() => {
    const folder = join(dir, 'project');
    mkdirSync(folder, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: folder });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/cook/recipes.git'], { cwd: folder });
    writeSetting(db, 'projectPath', folder);
  });

  it.each(['cook/recipes#12', 'recipes#12', 'https://github.com/cook/recipes/issues/12'])('makes an issue card from %j on Delivery', async (input) => {
    const told = vi.fn();

    const response = await postCard(db, told, post(input, 'delivery'), answers(ISSUE));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ key: 'recipes#12', note: null });
    expect(row('recipes#12')).toMatchObject({ board: 'delivery', title: 'Search by ingredient', source: 'github', source_ref: 'cook/recipes#12' });
    expect(told).toHaveBeenCalledOnce();
  });

  it.each(['cook/recipes#42', 'recipes#42', 'https://github.com/cook/recipes/pull/42'])('makes a pull request card from %j on PR reviews', async (input) => {
    const response = await postCard(db, () => undefined, post(input, 'prreview'), answers(PULL));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ key: 'recipes#42', note: null });
    expect(row('recipes#42')).toMatchObject({ board: 'prreview', title: 'Cache the recipe list', source: 'github-pr', source_ref: 'cook/recipes#42' });
  });

  // Another owner than the one in every other case here, so the owner can only come from the origin.
  it('takes the owner of a short reference from the project origin', async () => {
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/bake/recipes.git'], { cwd: join(dir, 'project') });

    const response = await postCard(db, () => undefined, post('recipes#12', 'delivery'), answers(ISSUE));

    expect(await response.json()).toEqual({ key: 'recipes#12', note: null });
    expect(row('recipes#12')?.source_ref).toBe('bake/recipes#12');
  });

  // The real runner on a PATH of our own. Its sentence is the one the dialog shows, word for word.
  it('answers 409 with the sentence of the runner when gh is missing, and makes nothing', async () => {
    const empty = join(dir, 'no-gh');
    mkdirSync(empty);

    const response = await postCard(db, () => undefined, post('cook/recipes#12', 'delivery'), ghRunner({ path: () => empty }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: 'gh is not on the PATH, so Nolzu cannot read GitHub. Install the GitHub CLI from https://cli.github.com, then start Nolzu again.',
    });
    expect(count()).toBe(1);
  });

  // A gh with no login exits 4, which the runner turns into its own sentence.
  it('answers 409 with the sentence of the runner when gh has no login, and makes nothing', async () => {
    const bin = join(dir, 'logged-out');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 4\n', { mode: 0o755 });

    const response = await postCard(db, () => undefined, post('cook/recipes#42', 'prreview'), ghRunner({ path: () => bin }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.' });
    expect(count()).toBe(1);
  });
});

// Jira as the project's ticket system. The keychain is a fake that counts its reads and the fetch is a
// stub, so nothing reaches a keychain or a Jira site.
describe('Add card on a Jira project', () => {
  const post = (body: unknown) => new Request('http://localhost/api/cards', { method: 'POST', body: JSON.stringify(body) });
  const ISSUE = JSON.stringify({
    key: 'PROJ-123',
    self: 'https://you.atlassian.net/rest/api/3/issue/10001',
    fields: { summary: 'Search by ingredient', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Find a recipe by what is in the fridge.' }] }] } },
  });

  function seams(token: string | null = 'ATATT3xFfGF0-recipe-token') {
    const reads: string[] = [];
    const fetched: string[] = [];
    const keychain = {
      read: async (name: string) => {
        reads.push(name);
        return token;
      },
      write: () => Promise.reject(new Error('Add card writes no token.')),
      remove: () => Promise.reject(new Error('Add card removes no token.')),
    };
    const fetcher = async (url: string) => {
      fetched.push(url);
      return url.includes('/issue/PROJ-123') ? new Response(ISSUE, { status: 200 }) : new Response('{}', { status: 404 });
    };
    return { reads, fetched, jira: { keychain, fetcher } };
  }

  const useJira = () => {
    writeSetting(db, 'ticketSystem', 'jira');
    writeSetting(db, 'jiraSite', 'https://you.atlassian.net');
    writeSetting(db, 'jiraEmail', 'dana@example.com');
  };

  it.each(['PROJ-123', 'https://you.atlassian.net/browse/PROJ-123'])('makes %s a card titled from Jira with source jira', async (input) => {
    useJira();
    const { reads, fetched, jira } = seams();

    const response = await postCard(db, () => undefined, post({ input }), undefined, null, jira);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ key: 'PROJ-123', note: null });
    expect(row('PROJ-123')).toMatchObject({ title: 'Search by ingredient', summary: 'Find a recipe by what is in the fridge.', source: 'jira', source_ref: 'PROJ-123' });
    expect(reads).toEqual(['jira-token']);
    expect(fetched).toEqual([expect.stringMatching(/^https:\/\/you\.atlassian\.net\/rest\/api\/3\/issue\/PROJ-123\?/)]);
  });

  it('keeps a key with the local prefix local, and reads no keychain', async () => {
    useJira();
    const { reads, jira } = seams();

    const response = await postCard(db, () => undefined, post({ input: 'APP-1' }), undefined, null, jira);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toContain('APP-1 is already on the board');
    expect(reads).toEqual([]);
  });

  it('names Settings, Integrations when the token is missing, and makes nothing', async () => {
    useJira();
    const { fetched, jira } = seams(null);

    const response = await postCard(db, () => undefined, post({ input: 'PROJ-123' }), undefined, null, jira);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toMatch(/no Jira API token on this machine.*Settings, Integrations at \/settings\/integrations/);
    expect(fetched).toEqual([]);
    expect(count()).toBe(1);
  });

  it('refuses a Jira link from another site and reads nothing', async () => {
    useJira();
    const { reads, fetched, jira } = seams();

    const response = await postCard(db, () => undefined, post({ input: 'https://you.atlassian.net.example.org/browse/PROJ-123' }), undefined, null, jira);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toBe(
      'That link is on you.atlassian.net.example.org, and this project reads Jira at you.atlassian.net. Paste a link from you.atlassian.net, or type the key.',
    );
    expect([reads, fetched, count()]).toEqual([[], [], 1]);
  });

  // A key with the local prefix reads as a local card, so a Jira link to one would clash with the counter.
  it('refuses a Jira link whose key has the local prefix, and reads nothing', async () => {
    useJira();
    const { reads, fetched, jira } = seams();

    const response = await postCard(db, () => undefined, post({ input: 'https://you.atlassian.net/browse/APP-7' }), undefined, null, jira);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toMatch(/^APP-7 has this project's local key prefix.*Settings, Project at \/settings\/project/);
    expect([reads, fetched, count()]).toEqual([[], [], 1]);
  });

  it('reads no keychain on a local project, and keeps a typed key as an external card', async () => {
    const { reads, jira } = seams();

    const response = await postCard(db, () => undefined, post({ input: 'PROJ-123' }), undefined, null, jira);

    expect(response.status).toBe(201);
    expect(row('PROJ-123')).toMatchObject({ source: 'external' });
    expect(reads).toEqual([]);
  });

  // Keep it as a local card, and a Linear link, which nothing reads yet.
  it.each(['https://you.atlassian.net/browse/PROJ-123', 'https://linear.app/recipes/issue/PROJ-123/search-by-ingredient'])(
    'makes %s a local card titled with its key on a local project, with the link in its text',
    async (input) => {
      const { reads, jira } = seams();

      const response = await postCard(db, () => undefined, post({ input }), undefined, null, jira);

      expect(await response.json()).toEqual({ key: 'APP-2', note: null });
      expect(row('APP-2')).toMatchObject({ title: 'PROJ-123', summary: input, source: 'local' });
      expect(reads).toEqual([]);
    },
  );
});
