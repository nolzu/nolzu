import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, openDatabase, writeSetting } from '@nolzu/core/node';
import { ghRunner, type RunGh } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { postCard } from './create-card.ts';
import { MINE_SHOWN, myTickets } from './my-tickets.ts';
import { jiraReader } from './ticket-system.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-mine-'));
  db = openDatabase(dir);
  writeSetting(db, 'localKeyPrefix', 'APP');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// A workspace whose repositories have GitHub origins, as New project makes one.
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

const issue = (owner: string, repo: string, number: number, title: string) => ({
  number,
  title,
  body: `${title}, in more words.`,
  state: 'open',
  html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
  repository_url: `https://api.github.com/repos/${owner}/${repo}`,
});

// A `gh` that answers the search with `items` and an issue read with the matching one, and keeps what it
// was asked. Nothing reaches GitHub.
function gh(items: ReturnType<typeof issue>[]): { run: RunGh; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunGh = async (args) => {
    calls.push([...args]);
    if (args.includes('search/issues')) return { code: 0, stdout: JSON.stringify({ items }), stderr: '' };
    const query = args.find((one) => one.startsWith('query=')) ?? '';
    const found = items.find((one) => query.includes(`name: "${one.html_url.split('/')[4]}"`) && query.includes(`number: ${one.number})`));
    const node = found === undefined ? null : { __typename: 'Issue', number: found.number, title: found.title, body: found.body, state: 'OPEN', url: found.html_url, parent: null };
    return { code: 0, stdout: JSON.stringify({ data: { t0: { issueOrPullRequest: node } } }), stderr: '' };
  };
  return { run, calls };
}

const noJira = async () => {
  throw new Error('This project does not read Jira.');
};

describe('GitHub issues', () => {
  it('lists the open issues assigned to the gh login in the project repositories, minus those with a card', async () => {
    workspace({ api: 'https://github.com/cook/recipes-api.git', web: 'https://github.com/bake/recipes-web.git' });
    createCard(db, { key: 'recipes-api#3', board: 'delivery', stage: 'inbox', title: 'Cache drops rows', sourceRef: 'cook/recipes-api#3' });
    // Done cards count too, so a finished ticket never comes back as a new one.
    createCard(db, { key: 'recipes-web#4', board: 'delivery', stage: 'done', title: 'Old search', sourceRef: 'bake/recipes-web#4' });
    const { run, calls } = gh([issue('cook', 'recipes-api', 3, 'Cache drops rows'), issue('bake', 'recipes-web', 4, 'Old search'), issue('bake', 'recipes-web', 9, 'Search by ingredient')]);

    const mine = await myTickets(db, { run, jira: noJira });

    expect(mine).toEqual({ asked: true, problems: [], tickets: [{ key: 'recipes-web#9', title: 'Search by ingredient', input: 'https://github.com/bake/recipes-web/issues/9' }] });
    // One search over both repositories, and no pull requests.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('q=is:issue is:open repo:cook/recipes-api repo:bake/recipes-web assignee:@me');
  });

  it(`shows no more than ${MINE_SHOWN}`, async () => {
    workspace({ api: 'https://github.com/cook/recipes-api.git' });
    const { run } = gh(Array.from({ length: 30 }, (_, at) => issue('cook', 'recipes-api', at + 1, `Task ${at + 1}`)));

    const mine = await myTickets(db, { run });

    expect(mine.tickets).toHaveLength(MINE_SHOWN);
    expect(mine.tickets[0]?.key).toBe('recipes-api#1');
  });

  // The press posts the row's input, which is the link a person would paste, so the card comes out of
  // Add card's own path with the issue's title, text and source. Then the row is gone.
  it('makes the card a pasted link makes, and drops the row after', async () => {
    workspace({ api: 'https://github.com/cook/recipes-api.git' });
    const { run } = gh([issue('cook', 'recipes-api', 12, 'Plan a week of meals')]);
    const [row] = (await myTickets(db, { run })).tickets;

    const request = new Request('http://localhost/api/cards', { method: 'POST', body: JSON.stringify({ input: row?.input, board: 'delivery' }) });
    const response = await postCard(db, () => undefined, request, run);

    expect(response.status).toBe(201);
    expect(db.prepare('SELECT title, summary, source, source_ref FROM cards WHERE key = ?').get('recipes-api#12')).toEqual({
      title: 'Plan a week of meals',
      summary: 'Plan a week of meals, in more words.',
      source: 'github',
      source_ref: 'cook/recipes-api#12',
    });
    expect((await myTickets(db, { run })).tickets).toEqual([]);
  });

  // The real `gh` runner, on a PATH with no `gh` on it.
  it('says how to install gh when it is missing, and lists nothing', async () => {
    workspace({ api: 'https://github.com/cook/recipes-api.git' });

    const mine = await myTickets(db, { run: ghRunner({ path: () => dir }) });

    expect(mine).toEqual({ asked: true, tickets: [], problems: ['gh is not on the PATH, so Nolzu cannot read GitHub. Install the GitHub CLI from https://cli.github.com, then start Nolzu again.'] });
  });

  it('asks nothing on a project with no GitHub origin and local tickets', async () => {
    workspace({ api: 'https://gitlab.com/cook/recipes-api.git' });
    const { run, calls } = gh([]);

    expect(await myTickets(db, { run, jira: noJira })).toEqual({ asked: false, tickets: [], problems: [] });
    expect(calls).toEqual([]);
  });
});

describe('Jira tickets', () => {
  const useJira = () => {
    writeSetting(db, 'ticketSystem', 'jira');
    writeSetting(db, 'jiraSite', 'https://you.atlassian.net');
    writeSetting(db, 'jiraEmail', 'dana@example.com');
  };
  const row = (key: string, summary: string) => ({ key, self: 'https://you.atlassian.net/rest/api/3/issue/1', fields: { summary, status: { statusCategory: { key: 'new' } } } });

  // A fake keychain and fetch, so nothing reaches a keychain or a Jira site.
  function jira(answer: () => Response) {
    const fetched: string[] = [];
    const keychain = { read: async () => 'ATATT3xFfGF0-recipe-token', write: () => Promise.reject(new Error('no')), remove: () => Promise.reject(new Error('no')) };
    const fetcher = async (url: string) => {
      fetched.push(url);
      return answer();
    };
    return { fetched, reader: () => jiraReader(db, keychain, fetcher) };
  }

  it('lists the open tickets assigned to the account, minus those with a card or the local prefix', async () => {
    useJira();
    createCard(db, { key: 'PROJ-1', board: 'delivery', stage: 'done', title: 'Shopping list', source: 'jira', sourceRef: 'PROJ-1' });
    const { fetched, reader } = jira(() => new Response(JSON.stringify({ issues: [row('PROJ-1', 'Shopping list'), row('PROJ-2', 'Search by ingredient'), row('APP-9', 'Local looking')], isLast: true }), { status: 200 }));

    const mine = await myTickets(db, { jira: reader });

    expect(mine).toEqual({ asked: true, problems: [], tickets: [{ key: 'PROJ-2', title: 'Search by ingredient', input: 'PROJ-2' }] });
    expect(fetched).toHaveLength(1);
    expect(new URL(fetched[0] ?? '').searchParams.get('jql')).toBe('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  });

  // The token sentence of a Scout source names the Scout page. Here the fix is Connect Jira again.
  it('sends a refused token to Settings, Integrations, and GitHub still answers', async () => {
    useJira();
    workspace({ api: 'https://github.com/cook/recipes-api.git' });
    const { reader } = jira(() => new Response('{}', { status: 404, headers: { 'x-seraph-loginreason': 'AUTHENTICATED_FAILED' } }));
    const { run } = gh([issue('cook', 'recipes-api', 5, 'Print a recipe')]);

    const mine = await myTickets(db, { run, jira: reader });

    expect(mine.problems).toEqual(['Jira refused the API token, so your tickets were not read. Connect Jira again in Settings, Integrations at /settings/integrations.']);
    expect(mine.tickets.map((one) => one.key)).toEqual(['recipes-api#5']);
  });

  it('says where to connect Jira when it is not connected on this machine', async () => {
    writeSetting(db, 'ticketSystem', 'jira');
    const { fetched, reader } = jira(() => new Response('{}', { status: 200 }));

    const mine = await myTickets(db, { jira: reader });

    expect(mine.problems).toEqual(['Jira is the ticket system here, and Jira is not connected on this machine. Connect Jira again in Settings, Integrations at /settings/integrations.']);
    expect(fetched).toEqual([]);
  });

  it('says the site could not be reached when the network is down', async () => {
    useJira();
    const { reader } = jira(() => {
      throw new TypeError('fetch failed');
    });

    expect((await myTickets(db, { jira: reader })).problems).toEqual(['Nolzu could not reach you.atlassian.net. Check the site address and the network.']);
  });
});
