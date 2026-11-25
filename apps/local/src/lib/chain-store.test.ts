import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAIN_SUGGEST_AFTER } from './chain.ts';
import { cardChain, chainView, saveCardChain, writeChain } from './chain-store.ts';

// The suggestion over a fixture database: the rows the loop writes when a person moves a card through
// Plan, read back the way Now reads them.
let dir = '';
let db: DatabaseSync;
let minute = 0;
let made = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-chain-store-'));
  db = openDatabase(dir);
  minute = 0;
  made = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const at = () => new Date(Date.UTC(2026, 9, 14, 9, minute++)).toISOString();

function moved(key: string, from: string, to: string, who = 'you'): void {
  const started = to === 'plan' ? 'plan' : to === 'implement' ? 'implement' : null;
  db.prepare('INSERT INTO card_events (card_key, from_stage, to_stage, who, started_phase, at) VALUES (?, ?, ?, ?, ?, ?)').run(key, from, to, who, started, at());
}

function planRun(key: string): void {
  db.prepare("INSERT INTO runs (card_key, phase, engine, state, started_at, ended_at) VALUES (?, 'plan', 'claude-code', 'complete', ?, ?)").run(key, at(), at());
}

// A card through Plan: in, the plan runs, then the person moves it on or back.
function planned(board = 'delivery', out = 'implement', runs = 1): string {
  const key = `APP-${++made}`;
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, ?, ?, 'idle', 'Add a search box')").run(key, board, out);
  moved(key, 'refine', 'plan');
  for (let n = 0; n < runs; n++) planRun(key);
  moved(key, 'plan', out);
  return key;
}

const approve = (count: number) => {
  for (let n = 0; n < count; n++) planned();
};

const post = (body: unknown) => {
  const changed = vi.fn();
  return { changed, response: writeChain({ db, changed }, new Request('http://localhost/api/chain', { method: 'POST', body: JSON.stringify(body) })) };
};

describe('chainView', () => {
  it('suggests the chain with the count of plans approved as they came', () => {
    approve(9);

    expect(chainView(db)).toEqual({ on: false, approved: 9 });
  });

  it('suggests nothing below the threshold', () => {
    approve(CHAIN_SUGGEST_AFTER - 1);

    expect(chainView(db)).toEqual({ on: false, approved: null });
  });

  it('counts neither a sent-back plan nor one that ran twice', () => {
    approve(CHAIN_SUGGEST_AFTER);
    planned('delivery', 'refine');
    approve(CHAIN_SUGGEST_AFTER - 1);
    expect(chainView(db).approved).toBeNull();

    approve(1);
    planned('delivery', 'implement', 2);
    expect(chainView(db).approved).toBeNull();
  });

  // Epics has a Plan too, and no chain to offer.
  it('reads Delivery plans alone', () => {
    for (let n = 0; n < CHAIN_SUGGEST_AFTER; n++) planned('epics', 'review');

    expect(chainView(db).approved).toBeNull();
  });

  it('shows the chain as on, and no suggestion, once the person turned it on', () => {
    approve(9);
    writeSetting(db, 'chainBoards', ['delivery']);

    expect(chainView(db)).toEqual({ on: true, approved: null });
  });
});

describe('writeChain', () => {
  it('turns the chain on for Delivery and tells every open Now', async () => {
    const { changed, response } = post({ board: 'delivery', on: true });

    expect((await response).status).toBe(200);
    expect(getSetting(db, 'chainBoards')).toEqual(['delivery']);
    expect(changed).toHaveBeenCalledOnce();
  });

  // The suggestion is the only place the chain is turned on, so off must not hide it, or a press by
  // mistake could not be undone until five more plans went through.
  it('turns it off again and offers the suggestion at once', async () => {
    approve(9);
    writeSetting(db, 'chainBoards', ['delivery']);

    expect((await post({ board: 'delivery', on: false }).response).status).toBe(200);
    expect(getSetting(db, 'chainBoards')).toEqual([]);
    expect(getSetting(db, 'chainNotNow')).toBe(0);
    expect(chainView(db)).toEqual({ on: false, approved: 9 });
  });

  it('keeps Not now across a reload, and suggests again after enough new plans', async () => {
    approve(9);

    expect((await post({ notNow: true }).response).status).toBe(200);
    db.close();
    db = openDatabase(dir);
    expect(chainView(db).approved).toBeNull();
    expect(getSetting(db, 'chainBoards')).toEqual([]);

    approve(CHAIN_SUGGEST_AFTER);
    expect(chainView(db).approved).toBe(9 + CHAIN_SUGGEST_AFTER);
  });

  it.each([[{}], [{ board: 'delivery' }], [{ board: 'recipes', on: true }], [{ notNow: 'yes' }]])('refuses %j and changes nothing', async (body) => {
    const { changed, response } = post(body);

    expect((await response).status).toBe(400);
    expect(await (await response).json()).toEqual({ message: 'A chain change needs a board and on or off, or Not now.' });
    expect(getSetting(db, 'chainBoards')).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('refuses a board with no chain to turn on', async () => {
    const answer = await post({ board: 'epics', on: true }).response;

    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ message: 'The Epics board has no chain to turn on.' });
    expect(getSetting(db, 'chainBoards')).toEqual([]);
  });
});

// The chain is a tick on the card, shown only where the person turned the chain on for its board,
// and stored as the size the chain always read.
describe('the card tick', () => {
  const card = (key: string, board: string, size: string | null = null) => db.prepare("INSERT INTO cards (key, board, stage, state, title, size) VALUES (?, ?, 'inbox', 'idle', 'Add a search box', ?)").run(key, board, size);
  const size = (key: string) => (db.prepare('SELECT size FROM cards WHERE key = ?').get(key) as { size: string | null }).size;
  const tick = (key: string, body: unknown) => {
    const changed = vi.fn();
    return { changed, response: saveCardChain({ db, changed }, key, new Request(`http://localhost/api/card/${key}/chain`, { method: 'PATCH', body: JSON.stringify(body) })) };
  };

  it('draws the tick only on a board the chain is on for', () => {
    card('APP-1', 'delivery', 'small');
    card('APP-2', 'epics');
    expect(cardChain(db, 'APP-1')).toBeNull();
    writeSetting(db, 'chainBoards', ['delivery']);
    expect(cardChain(db, 'APP-1')).toEqual({ ticked: true });
    expect(cardChain(db, 'APP-2')).toBeNull();
    expect(cardChain(db, 'APP-9')).toBeNull();
  });

  // A size from an older version that is not small reads as not ticked.
  it('reads any other size as not ticked', () => {
    writeSetting(db, 'chainBoards', ['delivery']);
    card('APP-1', 'delivery', 'large');
    card('APP-2', 'delivery');
    expect(cardChain(db, 'APP-1')).toEqual({ ticked: false });
    expect(cardChain(db, 'APP-2')).toEqual({ ticked: false });
  });

  it('stores the tick as small and the untick as no size, and tells the loop', async () => {
    card('APP-1', 'delivery');
    const on = tick('APP-1', { on: true });
    expect((await on.response).status).toBe(200);
    expect(size('APP-1')).toBe('small');
    expect(on.changed).toHaveBeenCalledTimes(1);

    expect((await tick('APP-1', { on: false }).response).status).toBe(200);
    expect(size('APP-1')).toBeNull();
  });

  it.each([
    ['APP-1', { on: 'yes' }, 400, 'Send on as true or false.'],
    ['APP-9', { on: true }, 404, 'There is no card APP-9, so there is nothing to tick.'],
    ['APP-2', { on: true }, 400, 'The Epics board has no chain to tick.'],
  ])('refuses %s with %j and changes nothing', async (key, body, status, message) => {
    card('APP-1', 'delivery');
    card('APP-2', 'epics');
    const { changed, response } = tick(key, body);

    expect((await response).status).toBe(status);
    expect(await (await response).json()).toEqual({ message });
    expect(changed).not.toHaveBeenCalled();
    expect([size('APP-1'), size('APP-2')]).toEqual([null, null]);
  });
});
