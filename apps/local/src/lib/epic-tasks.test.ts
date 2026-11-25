import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { boardFor, createQueue } from '@nolzu/core';
import { boardSnapshot, openDatabase, relatedCards, unlinkCards, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketAdapter } from '@nolzu/protocol';
import { addTasks, createCardFrom, getTicket, postTasks, readTicket } from './create-card.ts';
import { overviewFor } from './overview.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-epic-'));
  db = openDatabase(dir);
  writeSetting(db, 'localKeyPrefix', 'RECI');
  // The epic "Start from an idea" writes: the idea's first line as the title, on the Epics board's
  // first stage.
  await createCardFrom(db, {}, { input: '', title: 'A recipe box for the family', board: 'epics' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const row = (key: string) => db.prepare('SELECT board, stage, state, title, source FROM cards WHERE key = ?').get(key) as Record<string, unknown> | undefined;
const keys = (board: string) =>
  (db.prepare('SELECT key FROM cards WHERE board = ? ORDER BY rowid').all(board) as { key: string }[]).map((one) => one.key);
const delivered = (key: string) => {
  const snap = boardSnapshot(db, { wall: { ready: true }, board: boardFor('epics', 'pull-request'), queue: createQueue(3), models: { 'claude-code': ['sonnet'] } });
  return snap.cards.find((card) => card.key === key)?.delivered;
};

it('makes one Delivery card per task, each linked back to the epic', () => {
  const made = addTasks(db, 'RECI-1', ['Add a recipe', 'Search by ingredient', 'Print a shopping list']);

  // The epic and its tasks share one key counter, so RECI-1 gives RECI-2 and on.
  expect(made.keys).toEqual(['RECI-2', 'RECI-3', 'RECI-4']);
  expect(row('RECI-2')).toEqual({ board: 'delivery', stage: 'inbox', state: 'idle', title: 'Add a recipe', source: 'local' });
  expect(row('RECI-4')).toMatchObject({ board: 'delivery', stage: 'inbox', title: 'Print a shopping list' });
  expect(relatedCards(db, 'RECI-1').map((card) => card.key)).toEqual(['RECI-2', 'RECI-3', 'RECI-4']);
  expect(delivered('RECI-1')).toEqual({ done: 0, total: 3 });
});

it('cuts a long typed task to a short title and keeps the whole line as its text', () => {
  const task = 'Search the recipes by ingredient, by title and by the time a recipe takes, with the newest first';
  const [key = ''] = addTasks(db, 'RECI-1', [task]).keys;
  const made = db.prepare('SELECT title, summary FROM cards WHERE key = ?').get(key) as { title: string; summary: string };

  expect(made.title.length).toBeLessThanOrEqual(80);
  expect(made.title.endsWith('…')).toBe(true);
  expect(made.summary).toBe(task);
});

it('drops an empty line rather than making a card with no title', () => {
  const made = addTasks(db, 'RECI-1', ['Add a recipe', '  ', '']);

  expect(made.keys).toEqual(['RECI-2']);
  expect(keys('delivery')).toEqual(['RECI-2']);
});

it('writes the whole list or none of it', () => {
  // Nothing in the product can make the third write fail, so the test makes it fail. The list is one
  // transaction, so the two cards before it go back and the keys they took are given back as well.
  db.exec("CREATE TRIGGER refuse_third BEFORE INSERT ON cards WHEN new.key = 'RECI-4' BEGIN SELECT RAISE(ABORT, 'no room'); END");

  expect(() => addTasks(db, 'RECI-1', ['Add a recipe', 'Search by ingredient', 'Print a shopping list'])).toThrow();

  db.exec('DROP TRIGGER refuse_third');
  expect(keys('delivery')).toEqual([]);
  expect(db.prepare('SELECT count(*) AS n FROM card_links').get()).toEqual({ n: 0 });
  expect(delivered('RECI-1')).toBeNull();
  // No number is missing either, so the first task of the next try is still RECI-2.
  expect(addTasks(db, 'RECI-1', ['Add a recipe']).keys).toEqual(['RECI-2']);
});

it('refuses a card that is not an epic, and says which board delivers tasks', () => {
  const task = addTasks(db, 'RECI-1', ['Add a recipe']).keys[0] ?? '';

  expect(() => addTasks(db, task, ['Search by ingredient'])).toThrow('RECI-2 is not on the Epics board. An epic delivers tasks, a card on another board does not.');
  expect(keys('delivery')).toEqual(['RECI-2']);
});

it('refuses a key that is on no card', () => {
  expect(() => addTasks(db, 'RECI-9', ['Add a recipe'])).toThrow('There is no card RECI-9 here, so it has nothing to deliver.');
});

it('refuses a list with no title in it', () => {
  expect(() => addTasks(db, 'RECI-1', ['   ', ''])).toThrow('A task needs a title. Write one task per line, then add them again.');
  expect(keys('delivery')).toEqual([]);
});

it('drops a task that was unlinked from the epic', () => {
  addTasks(db, 'RECI-1', ['Add a recipe', 'Search by ingredient']);

  expect(unlinkCards(db, 'RECI-1', 'RECI-3')).toBe(true);

  expect(delivered('RECI-1')).toEqual({ done: 0, total: 1 });
  // The card is still on the Delivery board. Only the link to the epic is gone.
  expect(row('RECI-3')).toMatchObject({ board: 'delivery' });
});

it('shows the epic its tasks on the overview, and shows a Delivery card none', () => {
  addTasks(db, 'RECI-1', ['Add a recipe', 'Search by ingredient']);
  db.prepare("UPDATE cards SET stage = 'closed' WHERE key = 'RECI-2'").run();

  expect(overviewFor(db, 'RECI-1')?.tasks).toEqual([
    { key: 'RECI-2', title: 'Add a recipe', done: true },
    { key: 'RECI-3', title: 'Search by ingredient', done: false },
  ]);
  expect(overviewFor(db, 'RECI-2')?.tasks).toBeNull();
});

const request = (body: unknown) => new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) });

it('answers 201 with the new keys', async () => {
  const told = vi.fn();

  const answer = await postTasks(db, told, 'RECI-1', request({ titles: ['Add a recipe', 'Search by ingredient'] }));

  expect(answer.status).toBe(201);
  expect(await answer.json()).toEqual({ keys: ['RECI-2', 'RECI-3'] });
  // The open boards are told: two cards arrived on Delivery and the epic's count moved.
  expect(told).toHaveBeenCalledOnce();
});

it('answers 400 for a body that is no list of titles', async () => {
  const told = vi.fn();

  for (const body of [{}, { titles: 'Add a recipe' }, { titles: [1, 2] }]) {
    const answer = await postTasks(db, told, 'RECI-1', request(body));
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { message: string }).message).toBe('The tasks need a list of titles, one title per task.');
  }
  expect(told).not.toHaveBeenCalled();
  expect(keys('delivery')).toEqual([]);
});

it('answers 409 with the sentence the write was refused with', async () => {
  const answer = await postTasks(db, vi.fn(), 'RECI-9', request({ titles: ['Add a recipe'] }));

  expect(answer.status).toBe(409);
  expect(((await answer.json()) as { message: string }).message).toBe('There is no card RECI-9 here, so it has nothing to deliver.');
});

// A task of the plan keeps the key its row showed, or the one the person typed over it.
it('makes each task under the key its row sent, and a task with no key under the next one', () => {
  const made = addTasks(db, 'RECI-1', ['Add a recipe', 'Search by ingredient', 'Print a shopping list'], ['RECI-7', 'PROJ-123', '']);

  expect(made.keys).toEqual(['RECI-7', 'PROJ-123', 'RECI-2']);
  expect(row('PROJ-123')).toEqual({ board: 'delivery', stage: 'inbox', state: 'idle', title: 'Search by ingredient', source: 'local' });
  expect(relatedCards(db, 'RECI-1').map((card) => card.key)).toEqual(['PROJ-123', 'RECI-2', 'RECI-7']);
});

it('refuses a key a card holds, and writes none of the list', () => {
  addTasks(db, 'RECI-1', ['Add a recipe']);

  expect(() => addTasks(db, 'RECI-1', ['Search by ingredient', 'Print a shopping list'], ['RECI-3', 'RECI-2'])).toThrow('RECI-2 is already on the board. Open that card, or use another key.');
  expect(keys('delivery')).toEqual(['RECI-2']);
});

it('tells the epic the key its next task would get', () => {
  addTasks(db, 'RECI-1', ['Add a recipe']);

  expect(overviewFor(db, 'RECI-1')?.nextKey).toBe('RECI-3');
  expect(overviewFor(db, 'RECI-2')?.nextKey).toBeUndefined();
});

it('answers 201 with the keys the rows sent', async () => {
  const answer = await postTasks(db, vi.fn(), 'RECI-1', request({ titles: ['Add a recipe'], keys: ['RECI-5'] }));

  expect(answer.status).toBe(201);
  expect(await answer.json()).toEqual({ keys: ['RECI-5'] });
});

it('answers 400 for keys that are not one text per title', async () => {
  for (const keysSent of ['RECI-5', ['RECI-5'], [5, 6]]) {
    const answer = await postTasks(db, vi.fn(), 'RECI-1', request({ titles: ['Add a recipe', 'Search by ingredient'], keys: keysSent }));
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { message: string }).message).toBe('The keys need one key per title, or none.');
  }
  expect(keys('delivery')).toEqual([]);
});

// A task from the plan carries its step as the card text, under one line that names the epic, so the
// task's Refine starts from what Plan wrote and not from one line.
it('stores each task description under a line that names the epic, and keeps the step on the link', () => {
  const body = 'Add a recipe form.\n\n- Files: web/src/routes/new/+page.svelte\n- Undo: revert the page.';
  const made = addTasks(db, 'RECI-1', ['Add a recipe with a photo', 'Search by ingredient'], ['', ''], [body, ''], ['Add a recipe form.', '']);
  const text = (key: string) => (db.prepare('SELECT summary FROM cards WHERE key = ?').get(key) as { summary: string | null }).summary;

  expect(text(made.keys[0] ?? '')).toBe(`Part of RECI-1: A recipe box for the family.\n\n${body}`);
  // A task with no description is the bare title, as a typed list makes it.
  expect(text(made.keys[1] ?? '')).toBeNull();
  // The step is what the epic pairs the retitled task with, so it shows as added and not twice.
  expect(overviewFor(db, 'RECI-1')?.tasks).toEqual([
    { key: 'RECI-2', title: 'Add a recipe with a photo', done: false, step: 'Add a recipe form.' },
    { key: 'RECI-3', title: 'Search by ingredient', done: false },
  ]);
});

it('stores the description of a task under the key its row sent too', () => {
  addTasks(db, 'RECI-1', ['Add a recipe'], ['PROJ-123'], ['Add a recipe form.']);

  expect(db.prepare('SELECT summary FROM cards WHERE key = ?').get('PROJ-123')).toEqual({ summary: 'Part of RECI-1: A recipe box for the family.\n\nAdd a recipe form.' });
});

it('posts descriptions and steps, and answers 400 when they do not go one per title', async () => {
  const answer = await postTasks(db, vi.fn(), 'RECI-1', request({ titles: ['Add a recipe'], keys: [''], descriptions: ['Add a recipe form.'], steps: ['Recipe form'] }));
  expect(answer.status).toBe(201);
  expect(db.prepare('SELECT step FROM card_links WHERE a = ? AND b = ?').get('RECI-1', 'RECI-2')).toEqual({ step: 'Recipe form' });
  expect(db.prepare('SELECT summary FROM cards WHERE key = ?').get('RECI-2')).toEqual({ summary: 'Part of RECI-1: A recipe box for the family.\n\nAdd a recipe form.' });

  for (const body of [{ descriptions: ['one'] }, { steps: 'one' }, { descriptions: [1, 2] }]) {
    const refused = await postTasks(db, vi.fn(), 'RECI-1', request({ titles: ['Add a recipe', 'Search by ingredient'], ...body }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toBe('The descriptions, steps, refs and notes need one text per title, or none.');
  }
});

// A task row can link a ticket of the project's ticket system. The reader is a stub,
// so no test reaches a ticket system.
describe('a task linked to a ticket', () => {
  const asked: string[] = [];
  const jira: TicketAdapter = {
    name: 'jira',
    title: 'Jira',
    async get(refs) {
      return refs.map((ref) => {
        const key = ref.kind === 'external' ? ref.key : '';
        asked.push(key);
        const ticket = key === 'PROJ-123' || key === 'PROJ-124' ? { key, title: `${key} in Jira`, body: `What ${key} says.`, state: 'open' as const, url: null, parentKey: null } : null;
        return { ref, notFound: key !== 'PROJ-500', ticket };
      });
    },
    search: async () => [],
  };
  const sources = { external: jira };
  const message = async (answer: Response) => ((await answer.json()) as { message: string }).message;

  beforeEach(() => {
    asked.length = 0;
    writeSetting(db, 'ticketSystem', 'jira');
    writeSetting(db, 'jiraSite', 'https://example.atlassian.net');
    writeSetting(db, 'projectPath', dir);
  });

  it('reads a key or a link through the reader and names the ticket by its own title', async () => {
    expect(await readTicket(db, { external: jira }, ' PROJ-123 ')).toEqual({ key: 'PROJ-123', title: 'PROJ-123 in Jira', summary: 'What PROJ-123 says.', source: 'jira' });
    expect((await readTicket(db, { external: jira }, 'https://example.atlassian.net/browse/PROJ-124')).key).toBe('PROJ-124');
    const answer = await getTicket(db, 'PROJ-123', sources);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ key: 'PROJ-123', title: 'PROJ-123 in Jira' });
  });

  it('refuses a ref that names no ticket, a ticket that is a card already, and a project with no ticket system', async () => {
    expect(await message(await getTicket(db, 'PROJ-9', sources))).toBe('PROJ-9 is not in Jira. The key may be wrong, the ticket may be gone, or this account may not see that project.');
    expect(await message(await getTicket(db, 'PROJ-500', sources))).toBe('PROJ-500 could not be read from Jira. The call failed, so the ticket may still be there. Try again.');
    expect(await message(await getTicket(db, 'the search box', sources))).toBe('"the search box" is not a Jira key. Paste a key, such as PROJ-123, or a link to the ticket.');
    expect(await message(await getTicket(db, 'RECI-1', sources))).toBe('"RECI-1" is not a Jira key. Paste a key, such as PROJ-123, or a link to the ticket.');
    expect(await message(await getTicket(db, 'https://other.atlassian.net/browse/PROJ-123', sources))).toContain('That link is on other.atlassian.net');
    addTasks(db, 'RECI-1', ['Search'], ['PROJ-124']);
    expect(await message(await getTicket(db, 'PROJ-124', sources))).toBe('PROJ-124 is a card on the delivery board already. Open that card, or link another ticket.');
    expect(asked).not.toContain('PROJ-124');
    await expect(readTicket(db, { external: null }, 'PROJ-123')).rejects.toThrow('This project keeps local tickets, so a task has no ticket system to link to.');
  });

  it("makes a linked row the ticket's card, a plain row a local card, and writes each one's notes", async () => {
    const answer = await postTasks(
      db,
      vi.fn(),
      'RECI-1',
      request({ titles: ['Filter by title', 'Test the filter'], keys: ['', ''], descriptions: ['The api filters.', 'A test proves it.'], steps: ['Add filterRecipes', 'Test it'], refs: ['PROJ-123', ''], notes: ['- Files: api/list.ts', '- Files: api/list.test.ts'] }),
      sources,
    );

    expect(answer.status).toBe(201);
    expect(await answer.json()).toEqual({ keys: ['PROJ-123', 'RECI-2'] });
    expect(db.prepare('SELECT title, summary, source, source_ref FROM cards WHERE key = ?').get('PROJ-123')).toEqual({ title: 'PROJ-123 in Jira', summary: 'What PROJ-123 says.', source: 'jira', source_ref: 'PROJ-123' });
    expect(db.prepare('SELECT summary, source FROM cards WHERE key = ?').get('RECI-2')).toEqual({ summary: 'Part of RECI-1: A recipe box for the family.\n\nA test proves it.', source: 'local' });
    expect(readFileSync(join(dir, '.tasks', 'PROJ-123', 'from-epic.md'), 'utf8')).toBe('- Files: api/list.ts\n');
    expect(readFileSync(join(dir, '.tasks', 'RECI-2', 'from-epic.md'), 'utf8')).toBe('- Files: api/list.test.ts\n');
    expect(db.prepare('SELECT step FROM card_links WHERE a = ? AND b = ?').get('PROJ-123', 'RECI-1')).toEqual({ step: 'Add filterRecipes' });
  });

  // The cards are in once the transaction ends, so a note that cannot be written comes back to say so.
  it('says which tasks lost their notes when the folder cannot be found or written', () => {
    writeFileSync(join(dir, 'a-file'), 'x');
    const made = addTasks(db, 'RECI-1', ['Filter', 'Test', 'Print'], [], [], [], [], ['a', 'b', ''], (key) => (key === 'RECI-2' ? null : join(dir, 'a-file', key)));

    expect(made).toEqual({ keys: ['RECI-2', 'RECI-3', 'RECI-4'], note: "The epic's notes could not be written for RECI-2, RECI-3. Add them to the extra context of those cards." });
    expect(keys('delivery')).toEqual(['RECI-2', 'RECI-3', 'RECI-4']);
    expect(addTasks(db, 'RECI-1', ['Share'], [], [], [], [], ['c'], () => null).note).toBe("The epic's notes could not be written for RECI-5. Add them to the extra context of that card.");
  });

  it('adds nothing when one ref does not read, and refuses a key linked on two rows', async () => {
    const failed = await postTasks(db, vi.fn(), 'RECI-1', request({ titles: ['Filter', 'Test', 'Print'], refs: ['PROJ-123', '', 'PROJ-9'], notes: ['a', 'b', 'c'] }), sources);
    expect(failed.status).toBe(409);
    expect(await message(failed)).toContain('PROJ-9 is not in Jira.');
    const twice = await postTasks(db, vi.fn(), 'RECI-1', request({ titles: ['Filter', 'Test'], refs: ['PROJ-123', 'https://example.atlassian.net/browse/PROJ-123'] }), sources);
    expect(twice.status).toBe(409);
    expect(await message(twice)).toBe('PROJ-123 is linked on two tasks. Unlink it from one of them, then add them again.');
    expect(keys('delivery')).toEqual([]);
    expect(existsSync(join(dir, '.tasks', 'RECI-2'))).toBe(false);
    expect(existsSync(join(dir, '.tasks', 'PROJ-123'))).toBe(false);
  });
});

// A project of local tickets links a task to a GitHub issue, read through a `gh` of our own with the
// shape the real one answers (see create-card.test.ts), so no test reaches GitHub.
describe('a task linked to a GitHub issue', () => {
  const ISSUE = '{"data":{"t0":{"issueOrPullRequest":{"__typename":"Issue","number":12,"title":"Search by ingredient","body":"Match ingredients too.","state":"OPEN","url":"https://github.com/cook/recipes/issues/12","parent":null}}}}';
  const GONE = '{"data":{"t0":{"issueOrPullRequest":null}},"errors":[{"type":"NOT_FOUND","path":["t0","issueOrPullRequest"],"message":"Could not resolve to an issue or pull request with the number of 12."}]}';
  const gh = (answer: string, defaultOwner: string | null = 'cook') => ({
    github: async () => ({ run: async () => ({ code: 0, stdout: answer, stderr: '' }), defaultOwner }),
  });
  const message = async (answer: Response) => ((await answer.json()) as { message: string }).message;

  it('reads a link, owner/repo#N or repo#N, and names the issue by its own title', async () => {
    expect(await readTicket(db, gh(ISSUE), 'recipes#12')).toEqual({ key: 'recipes#12', title: 'Search by ingredient', summary: 'Match ingredients too.', source: 'github', ref: 'cook/recipes#12' });
    expect((await readTicket(db, gh(ISSUE, null), 'https://github.com/cook/recipes/issues/12')).ref).toBe('cook/recipes#12');
    const answer = await getTicket(db, ' cook/recipes#12 ', gh(ISSUE));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ key: 'recipes#12', title: 'Search by ingredient', ref: 'cook/recipes#12' });
  });

  it('refuses what is no issue, an issue that is gone or a card already, and a machine with no gh', async () => {
    expect(await message(await getTicket(db, 'PROJ-123', gh(ISSUE)))).toBe('"PROJ-123" is not a GitHub issue. Paste a link to the issue, or type it as repo#12 or owner/repo#12.');
    expect(await message(await getTicket(db, 'recipes#12', gh(GONE)))).toBe('GitHub has no issue cook/recipes#12. The number may belong to a pull request, the issue may be gone, or this login may not open that repository.');
    expect(await message(await getTicket(db, 'recipes#12', gh(ISSUE, null)))).toContain('Type the owner as well, as in owner/recipes#12.');
    await expect(readTicket(db, { github: null }, 'recipes#12')).rejects.toThrow('Nolzu cannot read GitHub issues on this machine.');
    await createCardFrom(db, gh(ISSUE), { input: 'cook/recipes#12' });
    expect(await message(await getTicket(db, 'recipes#12', gh(ISSUE)))).toBe('recipes#12 is a card on the delivery board already. Open that card, or link another issue.');
  });

  it("makes a linked row the issue's card, with its own text and full name, linked back to the epic", async () => {
    const answer = await postTasks(db, vi.fn(), 'RECI-1', request({ titles: ['Search', 'Print'], refs: ['cook/recipes#12', ''], descriptions: ['Find by ingredient.', 'A shopping list.'] }), gh(ISSUE));

    expect(answer.status).toBe(201);
    expect(await answer.json()).toEqual({ keys: ['recipes#12', 'RECI-2'] });
    expect(db.prepare('SELECT board, title, summary, source, source_ref FROM cards WHERE key = ?').get('recipes#12')).toEqual({
      board: 'delivery',
      title: 'Search by ingredient',
      summary: 'Match ingredients too.',
      source: 'github',
      source_ref: 'cook/recipes#12',
    });
    expect(relatedCards(db, 'RECI-1').map((one) => one.key)).toContain('recipes#12');
  });

  // The page sends back the full name Link read, so a project whose origin names no owner, or another
  // one, still adds the issue the person linked.
  it('adds the issue under the owner Link read, not one guessed from the origin', async () => {
    const asked: string[][] = [];
    const sources = { github: async () => ({ run: async (args: readonly string[]) => (asked.push([...args]), { code: 0, stdout: ISSUE, stderr: '' }), defaultOwner: 'someone-else' }) };
    const read = (await (await getTicket(db, 'cook/recipes#12', sources)).json()) as { ref: string };
    const answer = await postTasks(db, vi.fn(), 'RECI-1', request({ titles: ['Search'], refs: [read.ref] }), sources);

    expect(answer.status).toBe(201);
    expect(db.prepare('SELECT source_ref FROM cards WHERE key = ?').get('recipes#12')).toEqual({ source_ref: 'cook/recipes#12' });
    expect(asked.at(-1)?.join(' ')).toContain('cook');
    expect(asked.at(-1)?.join(' ')).not.toContain('someone-else');
  });
});

