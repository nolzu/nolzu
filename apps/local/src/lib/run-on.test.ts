import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, setCardModels, startRun, writeSetting } from '@nolzu/core/node';
import { DEFAULT_PROFILE, type EngineProfile } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runOnOffer } from './run-on.ts';

// What each vendor offers on the machine this test stands for. Codex and Cursor answer with a list,
// so a profile of theirs is a login Nolzu could spawn and the refusal below is the phase rule and
// not a missing CLI.
const OFFERS = { 'claude-code': ['haiku', 'sonnet', 'opus'], codex: ['gpt-5.1-codex'], cursor: ['composer-1'] };

const SECOND: EngineProfile = { id: 'claude-code#work', label: 'Claude work', vendor: 'claude-code', configDir: '/tmp/nolzu-test-claude-work' };
const CODEX: EngineProfile = { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/nolzu-test-codex-work' };
const CURSOR: EngineProfile = { id: 'cursor#work', label: 'Cursor work', vendor: 'cursor', configDir: '/tmp/nolzu-test-cursor-work' };

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-run-on-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (stage: string) => db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', ?, 'failed', 'Add a search box')").run(stage);
// Whether the wall starts here, as the server hands it over from the runner's probe.
const WALL = { ready: true } as const;
const NO_WALL = { ready: false, reason: 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.' } as const;
const offer = (wall: typeof WALL | typeof NO_WALL = WALL) => runOnOffer(db, 'APP-1', OFFERS, wall);

it('offers the other login of a vendor that can run the phase', () => {
  addCard('implement');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, SECOND]);

  expect(offer()).toEqual({ profiles: [{ id: 'claude-code#work', label: 'Claude work' }], note: null });
});

// Retry sits next to these buttons and starts the same phase on the same login, so offering it
// again would be two buttons for one thing.
it('leaves out the login the phase runs on now', () => {
  addCard('implement');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, SECOND]);
  setCardModels(db, 'APP-1', { implement: { engine: 'claude-code#work', model: 'sonnet' } });

  expect(offer()?.profiles).toEqual([{ id: DEFAULT_PROFILE.id, label: DEFAULT_PROFILE.label }]);
});

// Implement is the one phase these two vendors can run at all, and a card whose row sits on one of
// them can be moved back to Claude Code. The other vendor is still left out, because the model this
// row would run is not on its list, which the last test in this file is about.
it('offers the Claude Code login back to a card whose row runs on Codex', () => {
  addCard('implement');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX, CURSOR]);
  setCardModels(db, 'APP-1', { implement: { engine: 'codex#work', model: 'gpt-5.1-codex' } });

  expect(offer()?.profiles.map((one) => one.id)).toEqual([DEFAULT_PROFILE.id]);
});

/**
 * The ceiling this names: where the wall cannot start, QA on Cursor is refused before the process
 * starts, so a card whose only other login is Cursor has no useful offer. It says the reason where
 * the button would be, which is what the spawn would have said after the click. Codex runs QA under
 * its own sandbox there, so it is still offered.
 */
it('offers Codex but not Cursor for QA where the wall cannot start', () => {
  addCard('qa');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);

  const said = offer(NO_WALL);

  expect(said?.profiles).toEqual([]);
  expect(said?.note).toContain("only Nolzu's wall holds Cursor to reading");
  expect(said?.note).toContain(NO_WALL.reason);
  expect(offer(WALL)?.note ?? '').not.toContain('wall');

  // Codex offers the model its preset row names, so the wall is the one thing that could refuse it.
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX, CURSOR]);
  expect(runOnOffer(db, 'APP-1', { ...OFFERS, codex: ['gpt-5.6-terra'] }, NO_WALL)?.profiles).toEqual([{ id: CODEX.id, label: CODEX.label }]);
});

// The last run of the phase, ended in `state` on `engine`.
const ran = (engine: string, state: string) => {
  const id = startRun(db, { cardKey: 'APP-1', phase: 'implement', engine, model: 'sonnet', effort: 'medium', sessionId: null, logPath: '', lane: null });
  db.prepare('UPDATE runs SET state = ? WHERE id = ?').run(state, id);
};
// What the Claude Code login read before its run failed: the weekly window refused.
const AT_LIMIT = { 'claude-code': { seenAt: 1, windows: [{ name: 'seven_day', used: 1, resetsAt: 2, status: 'rejected' }] } };
const CODEX_GPT = { ...OFFERS, codex: ['gpt-5.6-terra'] };

// A second login of the same vendor right at its limit reads as a way around that limit, which the
// vendor's terms forbid. Another vendor's login is a different account under different terms.
it('offers only another vendor after a run stopped on a usage limit', () => {
  addCard('implement');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, SECOND, CODEX]);
  writeSetting(db, 'engineLimits', AT_LIMIT);
  ran('claude-code', 'failed');

  expect(runOnOffer(db, 'APP-1', CODEX_GPT, WALL)).toEqual({ profiles: [{ id: CODEX.id, label: CODEX.label }], note: null });
});

it('offers both logins after a stop that was not a usage limit', () => {
  addCard('implement');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, SECOND, CODEX]);
  ran('claude-code', 'failed');

  expect(runOnOffer(db, 'APP-1', CODEX_GPT, WALL)?.profiles.map((one) => one.id)).toEqual([SECOND.id, CODEX.id]);
  // A reading of this login with room left is no limit either.
  writeSetting(db, 'engineLimits', { 'claude-code': { seenAt: 1, windows: [{ name: 'five_hour', used: 0.4, resetsAt: 2, status: 'allowed' }] } });
  expect(runOnOffer(db, 'APP-1', CODEX_GPT, WALL)?.profiles.map((one) => one.id)).toEqual([SECOND.id, CODEX.id]);
  // A full reading of another login is not this run's limit, and a stopped run did not fail on one.
  writeSetting(db, 'engineLimits', { 'claude-code#work': AT_LIMIT['claude-code'] });
  expect(runOnOffer(db, 'APP-1', CODEX_GPT, WALL)?.profiles.map((one) => one.id)).toEqual([SECOND.id, CODEX.id]);
  writeSetting(db, 'engineLimits', AT_LIMIT);
  ran('claude-code', 'stopped');
  expect(runOnOffer(db, 'APP-1', CODEX_GPT, WALL)?.profiles.map((one) => one.id)).toEqual([SECOND.id, CODEX.id]);
});

it('says so in one sentence when the limit leaves no login to offer', () => {
  addCard('implement');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, SECOND]);
  writeSetting(db, 'engineLimits', AT_LIMIT);
  ran('claude-code', 'failed');

  expect(offer()).toEqual({ profiles: [], note: 'The run stopped on a Claude Code usage limit, so no other Claude Code login is offered.' });
});

// The model of a row belongs to its own profile. A login that does not offer the model this phase
// would run cannot start it, and picking a model is what repairs that.
it('offers no login whose vendor does not offer the model the phase would run', () => {
  addCard('implement');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);

  const said = offer();

  expect(said?.profiles).toEqual([]);
  // The model itself comes from that vendor's own preset row, which is per vendor, so the
  // name is not pinned here. What this test is about is the refusal and the sentence that repairs it.
  expect(said?.note).toContain('is gone.');
  expect(said?.note).toContain('Codex work does not offer it');
});

it('offers nothing and says nothing when this machine holds one profile', () => {
  addCard('implement');

  expect(offer()).toBeNull();
});

it('offers nothing on a stage that starts no run, and nothing for a card that is not there', () => {
  addCard('review');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, SECOND]);

  expect(offer()).toBeNull();
  expect(runOnOffer(db, 'APP-2', OFFERS, WALL)).toBeNull();
});

/**
 * The offer reads the phase off the card's own board.
 *
 * Architecture is a stage of Epics and of no other board. Read against Delivery, an Epics card
 * sitting on it finds no stage and is offered nothing, so the second login is out of reach for a
 * phase that runs perfectly well on it.
 */
it('offers a phase that only the card own board has', () => {
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('EPIC-1', 'epics', 'architecture', 'failed', 'A search that finds recipes')").run();
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, SECOND]);

  expect(runOnOffer(db, 'EPIC-1', OFFERS, WALL)?.profiles).toEqual([{ id: SECOND.id, label: SECOND.label }]);
});

// A stage that starts no phase has nothing to offer another login, whatever board it is on.
it('offers nothing for a stage that starts no phase', () => {
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('EPIC-2', 'epics', 'in-delivery', 'idle', 'A search that finds recipes')").run();
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);

  expect(runOnOffer(db, 'EPIC-2', OFFERS, WALL)).toBeNull();
});

// The other side, unchanged: a Delivery card on the same stage id does have a phase there, so it
// gets an answer rather than nothing. Whether that answer offers a login or says why is the rest of
// this file.
it('answers for a Delivery card on the same stage id', () => {
  addCard('plan');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);

  expect(runOnOffer(db, 'APP-1', OFFERS, WALL)).not.toBeNull();
});

// A project folder that is not a repository runs on Claude Code only, and the offer says so before
// the click, with the sentence the job builder would give after it.
it('offers no Codex login when the project folder is not a repository', () => {
  addCard('implement');
  writeSetting(db, 'projectPath', '/work/recipes');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
  writeSetting(db, 'repos', [{ path: 'api', base: null }]);
  // Codex offers the model its preset row names, so the folder is the one reason left to refuse it.
  const offer = () => runOnOffer(db, 'APP-1', { ...OFFERS, codex: ['gpt-5.6-terra'] }, WALL);

  expect(offer()).toEqual({
    profiles: [],
    note: 'The project folder is not a git repository, and Claude Code is the one engine known to run in a folder like that. Run this phase on a Claude Code profile.',
  });

  writeSetting(db, 'repos', [{ path: '.', base: null }, { path: 'api', base: null }]);
  expect(offer()).toEqual({ profiles: [{ id: CODEX.id, label: CODEX.label }], note: null });
});

// A card on another preset resolves its rows under that preset, and under no other card's.
it('reads the preset of the card asked about and not of another card', () => {
  addCard('implement');
  db.prepare("INSERT INTO cards (key, board, stage, state, title, preset) VALUES ('APP-2', 'delivery', 'implement', 'failed', 'Other', 'heavy')").run();
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);

  const heavy = runOnOffer(db, 'APP-2', OFFERS, WALL)?.note;

  expect(heavy).toContain('gpt-5.6-sol is gone.');
  expect(offer()?.note).not.toContain('gpt-5.6-sol');
});

// A card with rows of its own must not decide what another card is offered: the other card still
// has the login that the first one moved away from.
it('reads the rows of the card asked about and not of another card', () => {
  addCard('implement');
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-2', 'delivery', 'implement', 'failed', 'Other')").run();
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, SECOND]);
  setCardModels(db, 'APP-1', { implement: { engine: 'claude-code#work', model: 'sonnet' } });

  expect(runOnOffer(db, 'APP-2', OFFERS, WALL)?.profiles).toEqual([{ id: 'claude-code#work', label: 'Claude work' }]);
});

// Every phase runs on every engine where the wall starts, so a failed QA card offers the Cursor login
// to run QA again. Without the wall the same login is refused, with the reason.
it('offers Cursor for QA where the wall starts, and not where it cannot', () => {
  addCard('qa');
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
  // The model Cursor's preset runs QA on, so the offer turns on the wall alone.
  const models = { ...OFFERS, cursor: [...OFFERS.cursor, 'gpt-5.3-codex'] };

  expect(runOnOffer(db, 'APP-1', models, WALL)).toEqual({ profiles: [{ id: CURSOR.id, label: CURSOR.label }], note: null });
  expect(runOnOffer(db, 'APP-1', models, NO_WALL)?.note).toContain("only Nolzu's wall holds Cursor to reading");
});
