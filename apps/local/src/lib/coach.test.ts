import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { boardFor } from '@nolzu/core';
import { createCard, getSetting, moveCard, openDatabase, writeSetting } from '@nolzu/core/node';
import { CoachNote } from '@nolzu/ui';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeNote, firstRun, markStep } from './coach.ts';
import { COACH_NOTE } from './getting-started.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-coach-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const post = (body: unknown) => new Request('http://localhost/api/notes', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
// The note as a page draws it, from what the setting holds right now.
const shows = () =>
  render(CoachNote, { props: { note: 'first-drag', seen: getSetting(db, 'seenNotes'), title: 'Dropping a card here is your approval', ondismiss: () => {} } }).body.includes('role="note"');

it('shows the note until it is closed, and never again after, also from a new connection', async () => {
  expect(shows()).toBe(true);

  const answered = await closeNote(db, post({ note: 'first-drag' }));

  expect(answered.status).toBe(200);
  expect(shows()).toBe(false);
  // Remembered in the database and not in this process, so a restart keeps the note closed.
  db.close();
  db = openDatabase(dir);
  expect(shows()).toBe(false);
});

it('stores a note closed twice once', async () => {
  await closeNote(db, post({ note: 'first-drag' }));
  await closeNote(db, post({ note: 'first-drag' }));

  expect(getSetting(db, 'seenNotes')).toEqual(['first-drag']);
});

// The list is what keeps every note shown once, so closing a second note keeps the first one closed.
it('keeps the notes closed before when another note is closed', async () => {
  await closeNote(db, post({ note: 'first-drag' }));
  await closeNote(db, post({ note: 'first-push' }));

  expect(getSetting(db, 'seenNotes')).toEqual(['first-drag', 'first-push']);
  expect(shows()).toBe(false);
});

it('refuses a body that names no note, and a name the setting does not take', async () => {
  for (const body of ['not json', {}, { note: 3 }]) {
    const answered = await closeNote(db, post(body));
    expect(answered.status).toBe(400);
    expect(await answered.json()).toEqual({ message: 'Closing a coach note needs the name of the note.' });
  }

  const refused = await closeNote(db, post({ note: 'First drag' }));
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ message: 'The closed coach notes are a list of note names, such as first-drag.' });
  expect(getSetting(db, 'seenNotes')).toEqual([]);
});

// The route is what Got it posts to, so it must hand the request to closeNote and not answer by itself.
it('stores the note through the notes route', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../routes/api/notes/+server.ts', import.meta.url), 'utf8');

  expect(source).toContain('closeNote(database(), request)');
});

// Getting started on a project New project made: each step turns done from the row or the mark its own
// event leaves, read fresh, and never from a click on the list.
describe('Getting started', () => {
  const done = () => firstRun(db, false).steps?.filter((step) => step.done).map((step) => step.id) ?? 'no list';
  const delivery = boardFor('delivery', 'pull-request');

  beforeEach(() => writeSetting(db, 'gettingStarted', []));

  it('shows no list on a project New project did not make', () => {
    writeSetting(db, 'gettingStarted', null);
    expect(firstRun(db, false).steps).toBeNull();
  });

  it('turns the first card done when a card is made', () => {
    expect(done()).toEqual([]);
    createCard(db, { key: 'RECI-1', board: 'delivery', stage: 'inbox', title: 'Add a search box' });
    expect(done()).toEqual(['card']);
    expect(firstRun(db, false).steps?.[1]?.label).toBe('Drag it to Refine');
  });

  // Research is a board now, so its first card is dragged to its Research column like any other.
  it('says Drag it to Research for a first card on Research', () => {
    createCard(db, { key: 'Q-1', board: 'questions', stage: 'inbox', title: 'What does this project do?' });
    expect(firstRun(db, false).steps?.[1]?.label).toBe('Drag it to Research');
  });

  it('turns the drag done when a person moves a card onto a column that starts a run, and not on a move back or a chain', async () => {
    createCard(db, { key: 'RECI-1', board: 'delivery', stage: 'refine', title: 'Add a search box' });
    await moveCard(db, delivery, 'RECI-1', 'inbox', () => undefined);
    await moveCard(db, delivery, 'RECI-1', 'refine', () => undefined, 'auto');
    expect(done()).toEqual(['card']);
    expect(firstRun(db, false).coach).toBe(COACH_NOTE);

    db.prepare("UPDATE cards SET state = 'idle'").run();
    await moveCard(db, delivery, 'RECI-1', 'plan', () => undefined);
    expect(done()).toEqual(['card', 'drag']);
    // The note explained the drop, which has happened now.
    expect(firstRun(db, false).coach).toBeNull();
  });

  it('turns the summary and the push done from their marks, once each, and marks nothing without a list', () => {
    expect(markStep(db, 'summary')).toBe(true);
    expect(markStep(db, 'summary')).toBe(false);
    expect(done()).toEqual(['summary']);
    expect(markStep(db, 'push')).toBe(true);
    expect(done()).toEqual(['summary', 'push']);

    writeSetting(db, 'gettingStarted', null);
    expect(markStep(db, 'push')).toBe(false);
    expect(getSetting(db, 'gettingStarted')).toBeNull();
  });

  it('goes away when all four are done', async () => {
    createCard(db, { key: 'RECI-1', board: 'delivery', stage: 'inbox', title: 'Add a search box' });
    await moveCard(db, delivery, 'RECI-1', 'refine', () => undefined);
    markStep(db, 'summary');
    expect(firstRun(db, false).steps).not.toBeNull();
    markStep(db, 'push');
    expect(firstRun(db, false).steps).toBeNull();
  });

  it('keeps the coach note closed after Got it and a reload', async () => {
    createCard(db, { key: 'RECI-1', board: 'delivery', stage: 'inbox', title: 'Add a search box' });
    expect(firstRun(db, false).coach).toBe(COACH_NOTE);

    await closeNote(db, post({ note: COACH_NOTE }));
    db.close();
    db = openDatabase(dir);

    expect(firstRun(db, false).coach).toBeNull();
  });
});
