import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliveryBoard } from '../board.ts';
import {
  allCardMoves,
  boardOfCard,
  cardModels,
  cardPreset,
  cardRepos,
  createCard,
  createLocalTicket,
  deleteCardRows,
  deletedKey,
  followPreset,
  linkCards,
  moveCard,
  peekLocalKey,
  relatedCards,
  reposOfCard,
  setCardModels,
  setCardRepos,
  setCardTitle,
  setExtraContext,
  setMinimized,
  unlinkCards,
} from './cards.ts';
import { boardVersion, openDatabase } from './db.ts';
import { migrations } from './migrations.ts';
import { writeSetting } from './settings-store.ts';

const board = deliveryBoard('pull-request');
let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-cards-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function addCard(stage: string, state: string) {
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', ?, ?, 'Add a search box')").run(
    stage,
    state,
  );
}

const card = () => db.prepare("SELECT stage, state FROM cards WHERE key = 'APP-1'").get();
const events = () => db.prepare('SELECT from_stage, to_stage, who, started_phase FROM card_events ORDER BY id').all();

it('refuses to move a running card in either direction', async () => {
  addCard('refine', 'running');
  const startRun = vi.fn();

  await expect(moveCard(db, board, 'APP-1', 'plan', startRun)).rejects.toThrow(/running/);
  await expect(moveCard(db, board, 'APP-1', 'inbox', startRun)).rejects.toThrow(/running/);
  expect(card()).toEqual({ stage: 'refine', state: 'running' });
  expect(events()).toEqual([]);
  expect(startRun).not.toHaveBeenCalled();
});

it('writes the event, queues the card and starts the phase on a forward move into an agent stage', async () => {
  addCard('inbox', 'idle');
  const startRun = vi.fn(() => {
    expect(card()).toEqual({ stage: 'refine', state: 'queued' });
  });

  await moveCard(db, board, 'APP-1', 'refine', startRun);
  expect(events()).toEqual([{ from_stage: 'inbox', to_stage: 'refine', who: 'you', started_phase: 'refine' }]);
  expect(startRun).toHaveBeenCalledWith('APP-1', 'refine');
});

// The Evidence screen is the first reader of the table. It reads the moves of every card at once,
// where every other reader here works on one card.
it('reads back every move, oldest first, with the phase the move started', async () => {
  addCard('inbox', 'idle');
  await moveCard(db, board, 'APP-1', 'refine', vi.fn());
  db.prepare("UPDATE cards SET state = 'idle' WHERE key = 'APP-1'").run();
  await moveCard(db, board, 'APP-1', 'inbox', vi.fn());

  expect(allCardMoves(db).map((one) => ({ from: one.fromStage, to: one.toStage, who: one.who, phase: one.startedPhase }))).toEqual([
    { from: 'inbox', to: 'refine', who: 'you', phase: 'refine' },
    { from: 'refine', to: 'inbox', who: 'you', phase: null },
  ]);
  // The column default stamps it in UTC, which is the day the screen groups by.
  expect(allCardMoves(db)[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

it('writes an event and starts nothing on a move back', async () => {
  addCard('plan', 'ready');
  const startRun = vi.fn();

  await moveCard(db, board, 'APP-1', 'inbox', startRun);
  expect(events()).toEqual([{ from_stage: 'plan', to_stage: 'inbox', who: 'you', started_phase: null }]);
  expect(card()).toEqual({ stage: 'inbox', state: 'idle' });
  expect(startRun).not.toHaveBeenCalled();
});

it('leaves the card failed and movable when startRun throws', async () => {
  addCard('inbox', 'idle');
  const startRun = () => {
    throw new Error('The engine did not start.');
  };

  await expect(moveCard(db, board, 'APP-1', 'refine', startRun)).rejects.toThrow('The engine did not start.');
  expect(card()).toEqual({ stage: 'refine', state: 'failed' });
  await moveCard(db, board, 'APP-1', 'inbox', vi.fn());
  expect(card()).toEqual({ stage: 'inbox', state: 'idle' });
});

it('keeps a card written before the migration, and calls it local', () => {
  // Its own directory: the suite's database is already migrated, and reopening that one at an
  // older version is refused, as it should be.
  const older = mkdtempSync(join(tmpdir(), 'nolzu-cards-v1-'));
  try {
    const before = openDatabase(older, migrations.slice(0, 1));
    before.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-9', 'delivery', 'inbox', 'Older card')").run();
    before.close();

    const after = openDatabase(older);
    try {
      const card = after.prepare("SELECT source, source_ref FROM cards WHERE key = 'APP-9'").get() as {
        source: string;
        source_ref: string | null;
      };
      expect(card.source).toBe('local');
      expect(card.source_ref).toBe(null);
    } finally {
      after.close();
    }
  } finally {
    rmSync(older, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('hands out the local keys in order for one project and prefix', () => {
  const first = createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Add a search box', description: 'The list is long.' });
  const second = createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Sort the list', description: '' });

  expect([first.key, second.key]).toEqual(['APP-1', 'APP-2']);
  const row = db.prepare('SELECT title, summary, source, board, stage FROM cards WHERE key = ?').get(first.key) as {
    title: string;
    summary: string | null;
    source: string;
    board: string;
    stage: string;
  };
  expect(row.title).toBe('Add a search box');
  // A new card starts in the inbox of the delivery board. Anywhere else and it is either invisible
  // or one drag away from starting a phase nobody asked for.
  expect(row.board).toBe('delivery');
  expect(row.stage).toBe('inbox');
  // A local ticket is the card: the description it was written with is the card's summary.
  expect(row.summary).toBe('The list is long.');
  expect(row.source).toBe('local');
});

// Each Research kind counts under its own prefix, whatever prefix the caller passed, so every writer of
// a local card numbers a question as Q-1 and an investigation as INV-1.
it('numbers a question and an investigation under their own prefixes', () => {
  const question = createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Where is the title checked?', description: '', board: 'questions' });
  const investigation = createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Why do uploads fail?', description: '', board: 'investigations' });
  const delivery = createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Add a search box', description: '' });

  expect([question.key, investigation.key, delivery.key]).toEqual(['Q-1', 'INV-1', 'APP-1']);
  expect(peekLocalKey(db, 1, 'Q').key).toBe('Q-2');
});

it('counts per project, so two projects do not share a counter', () => {
  createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'First', description: '' });
  createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Second', description: '' });
  createLocalTicket(db, { projectId: 2, prefix: 'WEB', title: 'Another project', description: '' });

  // The ticket counters only. Other counters live in this table too, and this test is about two
  // projects not sharing one, not about everything that counts.
  expect(db.prepare("SELECT name, value FROM seq WHERE name LIKE 'ticket:%' ORDER BY name").all()).toEqual([
    { name: 'ticket:1:APP', value: 2 },
    { name: 'ticket:2:WEB', value: 1 },
  ]);
});

it('gives a second project with the same prefix the next free key', () => {
  createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'First', description: '' });

  // One database holds one board and a card key is unique across it, so the second project's counter
  // steps over the key the first one holds rather than failing on it.
  expect(createLocalTicket(db, { projectId: 2, prefix: 'APP', title: 'Second', description: '' }).key).toBe('APP-2');
});

it('refuses a key that is already on the board, and names it', () => {
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'inbox', title: 'First' });

  const again = () => createCard(db, { key: 'APP-1', board: 'delivery', stage: 'inbox', title: 'Second' });

  // sqlite has a word for this and it does not read as a sentence anyone can act on.
  expect(again).toThrow(/APP-1/);
  expect(again).not.toThrow(/UNIQUE|constraint/i);
});

// sqlite cannot add a word to a CHECK later without rebuilding the table, so the three the board
// draws are in it from the start. Without the check any writer can put an unknown word in, and the
// decision chip then loses its word.
it('takes the three review decisions and refuses a fourth word', () => {
  createCard(db, { key: 'recipes#42', board: 'prreview', stage: 'incoming', title: 'Cache the recipe list' });
  const decision = db.prepare('UPDATE cards SET pr_decision = ? WHERE key = ?');

  for (const word of ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', null]) decision.run(word, 'recipes#42');
  expect(() => decision.run('MERGED', 'recipes#42')).toThrow(/CHECK/);
});

it('links two cards once, whichever way round they are given', () => {
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'inbox', title: 'First' });
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'inbox', title: 'Second' });

  linkCards(db, 'APP-1', 'APP-2');
  linkCards(db, 'APP-1', 'APP-2');
  linkCards(db, 'APP-2', 'APP-1');

  expect(db.prepare('SELECT a, b FROM card_links').all()).toEqual([{ a: 'APP-1', b: 'APP-2' }]);
});

it('links a pair given the other way round', () => {
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'inbox', title: 'First' });
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'inbox', title: 'Second' });

  linkCards(db, 'APP-2', 'APP-1');

  // The table's check refuses the mirror image, and the insert ignores a refusal, so a pair that
  // is not put in order first is dropped without a word.
  expect(db.prepare('SELECT a, b FROM card_links').all()).toEqual([{ a: 'APP-1', b: 'APP-2' }]);
});

it('refuses to link a card to itself', () => {
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'inbox', title: 'First' });

  expect(() => linkCards(db, 'APP-1', 'APP-1')).toThrow(/APP-1/);
});

it('refuses a link to a card that is not on the board, and names it', () => {
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'inbox', title: 'First' });

  const link = () => linkCards(db, 'APP-1', 'PROJ-9');

  expect(link).toThrow(/PROJ-9/);
  expect(link).not.toThrow(/FOREIGN KEY|constraint/i);
  expect(db.prepare('SELECT a, b FROM card_links').all()).toEqual([]);
});

const minimized = () => (db.prepare("SELECT minimized FROM cards WHERE key = 'APP-1'").get() as { minimized: number }).minimized;

it('minimizes a card and restores it', () => {
  addCard('plan', 'idle');

  setMinimized(db, 'APP-1', true);
  expect(minimized()).toBe(1);
  setMinimized(db, 'APP-1', false);
  expect(minimized()).toBe(0);
});

// A value and not a toggle, so two windows that press at the same moment end in the state both
// asked for, and a request sent twice changes nothing the second time.
it('stays minimized when asked twice', () => {
  addCard('plan', 'idle');

  setMinimized(db, 'APP-1', true);
  setMinimized(db, 'APP-1', true);

  expect(minimized()).toBe(1);
});

// Parking a card is not a move, so the run that holds the card has no say in it.
it.each(['queued', 'running'])('minimizes a %s card, and leaves its stage and state alone', (state) => {
  addCard('refine', state);

  setMinimized(db, 'APP-1', true);

  expect(minimized()).toBe(1);
  expect(card()).toEqual({ stage: 'refine', state });
});

it('moves the board version, so an open board hears about it', () => {
  addCard('plan', 'idle');
  const before = boardVersion(db);

  setMinimized(db, 'APP-1', true);

  expect(boardVersion(db)).toBeGreaterThan(before);
});

// An answer and not a throw. A caller that caught a throw here would also catch a database that
// cannot be written, and tell the person their card does not exist.
it('answers false for a card that is not on the board, and leaves the version alone', () => {
  const before = boardVersion(db);

  expect(setMinimized(db, 'APP-404', true)).toBe(false);
  expect(boardVersion(db)).toBe(before);
});

it('answers true for a card it changed', () => {
  addCard('plan', 'idle');

  expect(setMinimized(db, 'APP-1', true)).toBe(true);
});

describe('related cards and extra context', () => {
  const add = (key: string) => createCard(db, { key, board: 'delivery', stage: 'inbox', title: `${key} title` });

  it('finds a card linked in either direction, never the card itself and never twice', () => {
    for (const key of ['PROJ-120', 'PROJ-123', 'PROJ-130', 'PROJ-140']) add(key);
    linkCards(db, 'PROJ-123', 'PROJ-130');
    linkCards(db, 'PROJ-120', 'PROJ-123');

    expect(relatedCards(db, 'PROJ-123')).toEqual([
      { key: 'PROJ-120', title: 'PROJ-120 title' },
      { key: 'PROJ-130', title: 'PROJ-130 title' },
    ]);
    expect(relatedCards(db, 'PROJ-140')).toEqual([]);
  });

  it('removes a link from either side, and says whether there was one', () => {
    add('APP-1');
    add('APP-2');
    linkCards(db, 'APP-1', 'APP-2');

    expect(unlinkCards(db, 'APP-2', 'APP-1')).toBe(true);
    expect(relatedCards(db, 'APP-1')).toEqual([]);
    expect(unlinkCards(db, 'APP-1', 'APP-2')).toBe(false);
  });

  it('stores the extra context, clears it to null on an empty text, and says whether the card is there', () => {
    add('APP-1');
    const stored = () => (db.prepare("SELECT extra_context FROM cards WHERE key = 'APP-1'").get() as { extra_context: string | null }).extra_context;

    expect(setExtraContext(db, 'APP-1', 'Keep the old list page.')).toBe(true);
    expect(stored()).toBe('Keep the old list page.');
    expect(setExtraContext(db, 'APP-1', '  ')).toBe(true);
    expect(stored()).toBeNull();
    expect(setExtraContext(db, 'APP-9', 'x')).toBe(false);
  });
});

// A card can already hold the next number: an external PROJ-1 kept before the local prefix became
// PROJ. Taking that number again would fail every new card from then on.
it('skips a local key another card already holds', () => {
  createCard(db, { key: 'PROJ-1', board: 'delivery', stage: 'inbox', title: 'Kept from another system', source: 'external', sourceRef: 'PROJ-1' });

  const made = createLocalTicket(db, { projectId: 1, prefix: 'PROJ', title: 'Sort the list', description: '' });
  const next = createLocalTicket(db, { projectId: 1, prefix: 'PROJ', title: 'Group the list', description: '' });

  expect([made.key, next.key]).toEqual(['PROJ-2', 'PROJ-3']);
});

// Add card shows the key a card will get. The peek is the code that picks the key, so the preview and
// the card agree, a number another card holds included, and reading it takes no number.
it('peeks at the next local key without taking it, and the next card gets that key', () => {
  createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'First', description: '' });
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'inbox', title: 'Kept from another system', source: 'external', sourceRef: 'APP-2' });

  expect(peekLocalKey(db, 1, 'APP')).toEqual({ key: 'APP-3', n: 3 });
  expect(peekLocalKey(db, 1, 'APP').key).toBe('APP-3');
  expect(createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Second', description: '' }).key).toBe('APP-3');
  expect(peekLocalKey(db, 1, 'APP').key).toBe('APP-4');
  expect(peekLocalKey(db, 1, 'WEB').key).toBe('WEB-1');
});

// The chain suggestion and the small-card cost read the size. A card with none picked has none.
it('stores the size a card is made with, and none when no size was picked', () => {
  createCard(db, { key: 'PROJ-1', board: 'delivery', stage: 'inbox', title: 'Kept', size: 'large' });
  createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Small one', description: '', size: 'small' });
  createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'No size', description: '' });

  expect(db.prepare('SELECT key, size FROM cards ORDER BY key').all()).toEqual([
    { key: 'APP-1', size: 'small' },
    { key: 'APP-2', size: null },
    { key: 'PROJ-1', size: 'large' },
  ]);
  expect(() => db.prepare("UPDATE cards SET size = 'huge' WHERE key = 'APP-1'").run()).toThrow();
});

describe('the models a card stores', () => {
  beforeEach(() => createCard(db, { key: 'APP-7', board: 'delivery', stage: 'inbox', title: 'Sort' }));

  it('reads nothing stored as null, and reads back what was written', () => {
    expect(cardModels(db, 'APP-7')).toBeNull();

    setCardModels(db, 'APP-7', { plan: { engine: 'claude-code', model: 'opus' } });

    expect(cardModels(db, 'APP-7')).toEqual({ plan: { engine: 'claude-code', model: 'opus' } });
  });

  // A card saved before Mockups became Design holds the row under the old name.
  it('reads a stored mockups row as the design row', () => {
    db.prepare('UPDATE cards SET models_json = ? WHERE key = ?').run(JSON.stringify({ mockups: { engine: 'claude-code', model: 'opus' } }), 'APP-7');

    expect(cardModels(db, 'APP-7')).toEqual({ design: { engine: 'claude-code', model: 'opus' } });
  });

  it('stores an empty table as null', () => {
    setCardModels(db, 'APP-7', { plan: { engine: 'claude-code', model: 'opus' } });
    setCardModels(db, 'APP-7', null);

    expect(db.prepare("SELECT models_json FROM cards WHERE key = 'APP-7'").get()).toEqual({ models_json: null });
  });

  // A hand edited value must not stop the card from running. It inherits everything instead.
  it('reads a stored value that no longer parses as nothing stored', () => {
    db.prepare("UPDATE cards SET models_json = '{\"plan\":{\"effort\":\"max\"}}' WHERE key = 'APP-7'").run();
    expect(cardModels(db, 'APP-7')).toBeNull();
    db.prepare("UPDATE cards SET models_json = 'not json' WHERE key = 'APP-7'").run();
    expect(cardModels(db, 'APP-7')).toBeNull();
  });

  it('keeps a row whose engine this version does not run', () => {
    setCardModels(db, 'APP-7', { plan: { engine: 'codex', model: 'gpt-9' } });

    expect(cardModels(db, 'APP-7')).toEqual({ plan: { engine: 'codex', model: 'gpt-9' } });
  });

  it('says whether the card was there', () => {
    expect(setCardModels(db, 'APP-9', null)).toBe(false);
    expect(setCardModels(db, 'APP-7', null)).toBe(true);
  });
});

// A card that switches preset drops its own rows, so it follows that preset and
// nothing it set before.
describe('the preset a card follows', () => {
  beforeEach(() => createCard(db, { key: 'APP-7', board: 'delivery', stage: 'inbox', title: 'Sort' }));

  it('follows the project until a preset is picked for it', () => {
    expect(cardPreset(db, 'APP-7')).toBe('default');
    writeSetting(db, 'modelPreset', 'light');
    expect(cardPreset(db, 'APP-7')).toBe('light');
  });

  it('clears the card rows in the same write that moves it onto a preset', () => {
    setCardModels(db, 'APP-7', { plan: { engine: 'claude-code', model: 'opus' } });
    const before = boardVersion(db);

    expect(followPreset(db, 'APP-7', 'heavy')).toBe(true);

    expect(cardPreset(db, 'APP-7')).toBe('heavy');
    expect(cardModels(db, 'APP-7')).toBeNull();
    expect(boardVersion(db)).toBe(before + 1);
  });

  // The project's own preset is stored as nothing, so the card follows the project again.
  it('stores the project preset as nothing, so a later project change reaches the card', () => {
    followPreset(db, 'APP-7', 'heavy');
    followPreset(db, 'APP-7', 'default');

    expect(db.prepare("SELECT preset FROM cards WHERE key = 'APP-7'").get()).toEqual({ preset: null });
    writeSetting(db, 'modelPreset', 'light');
    expect(cardPreset(db, 'APP-7')).toBe('light');
  });

  it('says whether the card was there, and refuses a preset name it does not know', () => {
    expect(followPreset(db, 'APP-9', 'heavy')).toBe(false);
    expect(() => db.prepare("UPDATE cards SET preset = 'turbo' WHERE key = 'APP-7'").run()).toThrow();
  });
});

describe('the repositories of a card', () => {
  beforeEach(() => createCard(db, { key: 'APP-7', board: 'delivery', stage: 'inbox', title: 'Sort' }));

  const twoRepos = () => writeSetting(db, 'repos', [{ path: 'api', base: null }, { path: 'web', base: null }]);
  const rootAndApi = () => writeSetting(db, 'repos', [{ path: '.', base: null }, { path: 'api', base: null }, { path: 'web', base: null }]);
  const columns = () => db.prepare("SELECT repos, repos_by FROM cards WHERE key = 'APP-7'").get();

  it('answers the project folder for a card on a single repository project, with no write', () => {
    expect(reposOfCard(db, 'APP-7')).toEqual(['.']);
    expect(columns()).toEqual({ repos: null, repos_by: null });
  });

  it('answers the one repository of a project that lists only one', () => {
    writeSetting(db, 'repos', [{ path: 'api', base: null }]);
    expect(reposOfCard(db, 'APP-7')).toEqual(['api']);
  });

  it('answers null for a card with no list on a project with several repositories', () => {
    twoRepos();
    expect(reposOfCard(db, 'APP-7')).toBeNull();
  });

  it('answers null for a card that is not there', () => {
    expect(reposOfCard(db, 'APP-9')).toBeNull();
  });

  // Nothing to work in yet, which is the same answer as a card with no list.
  it('answers null for a card on an empty workspace, even with an old list stored', () => {
    twoRepos();
    setCardRepos(db, 'APP-7', ['api'], 'person');
    writeSetting(db, 'repos', null);
    writeSetting(db, 'workspace', true);
    writeSetting(db, 'repos', []);

    expect(reposOfCard(db, 'APP-7')).toBeNull();
    expect(() => setCardRepos(db, 'APP-7', ['api'], 'person')).toThrow('The project has no repository api.');
  });

  it('puts the root repository first, even when the list leaves it out', () => {
    rootAndApi();
    setCardRepos(db, 'APP-7', ['web', 'api'], 'refine');

    expect(cardRepos(db, 'APP-7')).toEqual({ repos: ['web', 'api'], by: 'refine' });
    expect(reposOfCard(db, 'APP-7')).toEqual(['.', 'api', 'web']);
  });

  it('refuses a repository the project does not have, and writes nothing', () => {
    twoRepos();
    expect(() => setCardRepos(db, 'APP-7', ['api', 'docs'], 'person')).toThrow('The project has no repository docs.');
    expect(columns()).toEqual({ repos: null, repos_by: null });
  });

  it('lets a plan write replace a refine write', () => {
    twoRepos();
    expect(setCardRepos(db, 'APP-7', ['api'], 'refine')).toBe(true);
    expect(setCardRepos(db, 'APP-7', ['api', 'web'], 'plan')).toBe(true);

    expect(cardRepos(db, 'APP-7')).toEqual({ repos: ['api', 'web'], by: 'plan' });
  });

  it('keeps a list a person picked when refine or plan writes after it', () => {
    twoRepos();
    setCardRepos(db, 'APP-7', ['web'], 'person');

    expect(setCardRepos(db, 'APP-7', ['api'], 'plan')).toBe(false);
    expect(setCardRepos(db, 'APP-7', [], 'refine')).toBe(false);
    expect(cardRepos(db, 'APP-7')).toEqual({ repos: ['web'], by: 'person' });
    expect(setCardRepos(db, 'APP-7', ['api'], 'person')).toBe(true);
    expect(cardRepos(db, 'APP-7')).toEqual({ repos: ['api'], by: 'person' });
  });

  it('clears the list and who set it on an empty write', () => {
    twoRepos();
    setCardRepos(db, 'APP-7', ['api'], 'person');
    expect(setCardRepos(db, 'APP-7', [], 'person')).toBe(true);

    expect(columns()).toEqual({ repos: null, repos_by: null });
    expect(reposOfCard(db, 'APP-7')).toBeNull();
  });

  it('stores a repository named twice once', () => {
    twoRepos();
    setCardRepos(db, 'APP-7', ['api', 'api'], 'refine');
    expect(cardRepos(db, 'APP-7')?.repos).toEqual(['api']);
  });

  // A hand edit, or a repository later dropped from the project, must not stop the card.
  it('reads a stored list that no longer fits as what is left of it', () => {
    twoRepos();
    db.prepare(`UPDATE cards SET repos = '["docs","web"]', repos_by = 'plan' WHERE key = 'APP-7'`).run();
    expect(reposOfCard(db, 'APP-7')).toEqual(['web']);
    db.prepare(`UPDATE cards SET repos = '["docs"]' WHERE key = 'APP-7'`).run();
    expect(reposOfCard(db, 'APP-7')).toBeNull();
    db.prepare(`UPDATE cards SET repos = 'not json' WHERE key = 'APP-7'`).run();
    expect(cardRepos(db, 'APP-7')).toBeNull();
    expect(reposOfCard(db, 'APP-7')).toBeNull();
  });

  // A list with nobody behind it would let refine or plan replace a pick nobody can trace.
  it('reads a list with no one who set it as nothing stored', () => {
    twoRepos();
    db.prepare(`UPDATE cards SET repos = '["api"]', repos_by = NULL WHERE key = 'APP-7'`).run();
    expect(cardRepos(db, 'APP-7')).toBeNull();
  });

  it('says whether the card was there', () => {
    expect(setCardRepos(db, 'APP-9', [], 'person')).toBe(false);
  });

  it('moves the board version on a write and not on a kept list', () => {
    twoRepos();
    const before = boardVersion(db);
    setCardRepos(db, 'APP-7', ['api'], 'person');
    const after = boardVersion(db);
    expect(after).not.toBe(before);
    setCardRepos(db, 'APP-7', ['web'], 'plan');
    expect(boardVersion(db)).toBe(after);
  });
});

/**
 * Which board a card is on.
 *
 * Stage ids repeat across boards, so a reader that takes a card's stage against the wrong board's
 * stage list answers about another board's columns rather than answering nothing.
 */
describe('the board a card is on', () => {
  it('answers with the board the card was made on', () => {
    createCard(db, { key: 'EPIC-1', board: 'epics', stage: 'inbox', title: 'A search that finds recipes' });

    expect(boardOfCard(db, 'EPIC-1')).toBe('epics');
  });

  it('answers with nothing for a card that is not there', () => {
    expect(boardOfCard(db, 'APP-404')).toBeNull();
  });

  // The column is plain text with no check behind it, so a row written by an older or a newer
  // version can name a board this one does not know. Handed on, it would build a board with no
  // stages and the first stage lookup would throw somewhere far from here.
  it('answers with nothing for a board name this version does not know', () => {
    db.prepare('INSERT INTO cards (key, board, stage, state, title) VALUES (?, ?, ?, ?, ?)').run('OLD-1', 'roadmap', 'inbox', 'idle', 'A card from another version');

    expect(boardOfCard(db, 'OLD-1')).toBeNull();
  });
});

/**
 * The card key, at the write.
 *
 * Every card this app makes goes through `createCard`, so a key that cannot name a card folder is
 * refused here and not at the six readers that need one. The row is what matters in these tests: a
 * refusal that still wrote the row would leave the board holding a card nothing can open.
 */
describe('a key a card cannot carry', () => {
  it('refuses a key with a line break and writes no row', () => {
    expect(() => createCard(db, { key: 'PROJ-1\nPROJ-2', board: 'delivery', stage: 'inbox', title: 'Pasted out of a ticket answer' })).toThrow(
      'A card key is one line of plain text, with no line break and no control character. No card was made.',
    );

    expect(db.prepare('SELECT count(*) AS n FROM cards').get()).toEqual({ n: 0 });
  });

  // The shape an issue card had before it was keyed by the last part of its path, which this guard
  // lets through on purpose. Such a card can never run, because `ensureWorktree` refuses a key it
  // cannot name a folder after, and that is where the refusal has always been.
  it('writes a row for a key with a slash, the way it always has', () => {
    createCard(db, { key: 'acme/app#42', board: 'delivery', stage: 'inbox', title: 'Search by ingredient' });

    expect(db.prepare('SELECT count(*) AS n FROM cards').get()).toEqual({ n: 1 });
  });

  it('refuses an empty key and writes no row', () => {
    expect(() => createCard(db, { key: '', board: 'delivery', stage: 'inbox', title: 'A ticket with no key' })).toThrow(
      'A card key cannot be empty. No card was made.',
    );

    expect(db.prepare('SELECT count(*) AS n FROM cards').get()).toEqual({ n: 0 });
  });

  // The shape is checked before the key is looked up, so the person reads what is wrong with the key
  // rather than that no card holds it yet.
  it('takes the keys the app makes for itself', () => {
    createCard(db, { key: 'PROJ-123', board: 'delivery', stage: 'inbox', title: 'A counted local key' });
    createCard(db, { key: 'recipes#42', board: 'prreview', stage: 'inbox', title: 'A pull request key' });

    expect(db.prepare('SELECT key FROM cards ORDER BY key').all()).toEqual([{ key: 'PROJ-123' }, { key: 'recipes#42' }]);
  });
});

describe('a local card title', () => {
  const row = (key: string) => db.prepare('SELECT title, summary, title_by FROM cards WHERE key = ?').get(key) as { title: string; summary: string | null; title_by: string | null };
  const idea = 'A habit tracker where a person ticks off each habit every day and sees a streak for each one over the last month';

  it('takes the first line as the title and keeps the whole text as the description', () => {
    const { key } = createLocalTicket(db, { projectId: 1, prefix: 'APP', title: idea, description: '' });
    expect(row(key).title.length).toBeLessThanOrEqual(80);
    expect(row(key).title.endsWith('…')).toBe(true);
    expect(row(key).summary).toBe(idea);

    const two = createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Habit tracker\nWith a streak per habit.', description: '' });
    expect(row(two.key)).toEqual({ title: 'Habit tracker', summary: 'Habit tracker\nWith a streak per habit.', title_by: null });
  });

  it('keeps a description the person wrote, with the cut text above it', () => {
    const { key } = createLocalTicket(db, { projectId: 1, prefix: 'APP', title: idea, description: 'Mobile first.' });
    expect(row(key).summary).toBe(`${idea}\n\nMobile first.`);
    const short = createLocalTicket(db, { projectId: 1, prefix: 'APP', title: 'Habit tracker', description: 'Mobile first.' });
    expect(row(short.key)).toMatchObject({ title: 'Habit tracker', summary: 'Mobile first.' });
  });

  it('takes the title Refine wrote and moves the old title into an empty description', () => {
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'refine', title: 'A long idea with no text' });
    const before = boardVersion(db);
    expect(setCardTitle(db, 'APP-1', 'Daily habit tracker', 'refine')).toBe(true);
    expect(row('APP-1')).toEqual({ title: 'Daily habit tracker', summary: 'A long idea with no text', title_by: 'refine' });
    expect(boardVersion(db)).toBeGreaterThan(before);

    // A second Refine replaces its own title, and the description stays.
    expect(setCardTitle(db, 'APP-1', 'Habit tracker with streaks', 'refine')).toBe(true);
    expect(row('APP-1')).toEqual({ title: 'Habit tracker with streaks', summary: 'A long idea with no text', title_by: 'refine' });
    expect(setCardTitle(db, 'APP-1', 'Habit tracker with streaks', 'refine')).toBe(false);
  });

  it('keeps a description that has text', () => {
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'refine', title: 'Old title', summary: 'The text.' });
    setCardTitle(db, 'APP-1', 'New title', 'refine');
    expect(row('APP-1').summary).toBe('The text.');
  });

  it('leaves a title the person set by hand', () => {
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'refine', title: 'Old title' });
    expect(setCardTitle(db, 'APP-1', 'My own title', 'person')).toBe(true);
    expect(setCardTitle(db, 'APP-1', 'Daily habit tracker', 'refine')).toBe(false);
    expect(row('APP-1')).toEqual({ title: 'My own title', summary: null, title_by: 'person' });
  });

  it('leaves a GitHub or Jira title alone', () => {
    createCard(db, { key: 'recipes#4', board: 'delivery', stage: 'refine', title: 'Issue title', source: 'github' });
    createCard(db, { key: 'PROJ-123', board: 'delivery', stage: 'refine', title: 'Jira title', source: 'jira' });
    expect(setCardTitle(db, 'recipes#4', 'Refined', 'refine')).toBe(false);
    expect(setCardTitle(db, 'PROJ-123', 'Refined', 'refine')).toBe(false);
    expect(row('recipes#4').title).toBe('Issue title');
    expect(row('PROJ-123')).toEqual({ title: 'Jira title', summary: null, title_by: null });
  });

  it('writes nothing for an empty title', () => {
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'refine', title: 'Old' });
    expect(setCardTitle(db, 'APP-1', '  \n ', 'refine')).toBe(false);
    expect(row('APP-1').title).toBe('Old');
  });

  it('caps a long title', () => {
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'refine', title: 'Old' });
    setCardTitle(db, 'APP-1', 'word '.repeat(40), 'refine');
    expect(row('APP-1').title.length).toBeLessThanOrEqual(80);
  });
});

describe('deleteCardRows', () => {
  it('refuses inside its transaction while a run of the card is queued or going', () => {
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'plan', title: 'Add a search box' });
    db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('APP-1', 'plan', 'claude', 'queued')").run();

    expect(deleteCardRows(db, 'APP-1')).toEqual({ refused: 'APP-1 has a run in the queue. Stop the run first, then delete the card.' });
    expect(db.isTransaction).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM cards').get()).toEqual({ n: 1 });
    expect(deleteCardRows(db, 'APP-9')).toEqual({ refused: 'There is no card APP-9 on the board, so there is nothing to delete.' });

    // The stored app state refuses nothing here: it outlives a restart and often nothing resets it. The
    // caller asks whether this process holds the app.
    db.prepare("UPDATE runs SET state = 'complete'").run();
    db.prepare("UPDATE cards SET stack_state = 'up' WHERE key = 'APP-1'").run();
    expect(deleteCardRows(db, 'APP-1')).toEqual({ logs: [] });
  });

  it('takes the pull requests, their discussions and the thread names with the card, and moves the board version', () => {
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'plan', title: 'Add a search box' });
    db.prepare("INSERT INTO card_pulls (card_key, repo, number, found_by) VALUES ('APP-1', 'cook/recipes', 4, 'branch')").run();
    db.prepare("INSERT INTO pr_discussions (card_key, pull_id, ref, kind, github_id) VALUES ('APP-1', 1, 'T1', 'thread', 'g1')").run();
    db.prepare("INSERT INTO pr_messages (discussion_id, github_id, body, created_at, mine, unread) VALUES (1, 'm1', 'nit', '2026-11-04', 0, 1)").run();
    db.prepare("INSERT INTO thread_subjects (card_key, thread, subject) VALUES ('APP-1', 'ask', 'Why this index')").run();
    const before = boardVersion(db);

    expect(deleteCardRows(db, 'APP-1')).toEqual({ logs: [] });

    for (const table of ['card_pulls', 'pr_discussions', 'pr_messages', 'thread_subjects']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    expect(boardVersion(db)).toBeGreaterThan(before);
    // The key the kept runs move to can never be a card key, so no card later takes their history.
    expect(() => createCard(db, { key: deletedKey('APP-1'), board: 'delivery', stage: 'inbox', title: 'x' })).toThrow('holds no space');
  });
});
