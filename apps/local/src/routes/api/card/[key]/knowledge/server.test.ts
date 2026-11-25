import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCard, knowledgeChange, recordKnowledgeChanges, startRun } from '@nolzu/core/node';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// The route reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported. The loop is a stand-in whose snapshot holds no knowledge lane.
const data = mkdtempSync(join(tmpdir(), 'nolzu-card-knowledge-route-'));
process.env.NOLZU_DATA_DIR = data;
vi.mock('$lib/loop.ts', () => ({ loop: () => ({ snapshot: () => ({ lanes: [] }) }) }));

const { POST } = await import('./+server.ts');
const { database } = await import('$lib/db.ts');
const post = POST as unknown as (event: { params: { key: string }; request: Request }) => Promise<Response>;
const send = (key: string, change: unknown) => post({ params: { key }, request: new Request(`http://localhost/api/card/${key}/knowledge`, { method: 'POST', body: JSON.stringify({ change }) }) });

let theirs = 0;
let pending = 0;
beforeAll(() => {
  const db = database();
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'closed', title: 'Sort by cooking time' });
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'closed', title: 'Add a search box' });
  const runOf = (key: string) => startRun(db, { cardKey: key, phase: 'wrapup', engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  recordKnowledgeChanges(db, { cardKey: 'APP-2', runId: runOf('APP-2'), commitSha: 'a1b2c3d4e5f6', status: 'applied', files: [{ path: '.nolzu/knowledge/search.md', summary: null }] });
  recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: runOf('APP-1'), commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/api.md', summary: null }] });
  const ids = db.prepare('SELECT id, card_key FROM knowledge_changes ORDER BY id').all() as { id: number; card_key: string }[];
  theirs = ids.find((row) => row.card_key === 'APP-2')?.id ?? 0;
  pending = ids.find((row) => row.card_key === 'APP-1')?.id ?? 0;
});

afterAll(() => rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// The card page offers Revert only on its own card's change, so a post for another card's is refused
// and that change is left as it was.
it('refuses a change another card made, and leaves it applied', async () => {
  const answer = await send('APP-1', theirs);

  expect(answer.status).toBe(404);
  expect(await answer.json()).toEqual({ ok: false, message: `Knowledge change ${theirs} is not one APP-1 made.` });
  expect(knowledgeChange(database(), theirs)?.status).toBe('applied');
});

// The guard compares with the card of the page, not with a fixed key: the owner of a change may revert it.
it('lets a card revert its own change', async () => {
  const answer = await send('APP-2', theirs);

  expect(answer.status).not.toBe(404);
  expect(((await answer.json()) as { message: string }).message).not.toContain('is not one');
});

// The rules are the Knowledge screen's revert, sentence for sentence.
it('answers the revert rule sentence for a change that was never applied', async () => {
  const answer = await send('APP-1', pending);

  expect(answer.status).toBe(409);
  expect(await answer.json()).toEqual({ ok: false, message: 'The change to .nolzu/knowledge/api.md waits for review, so it was never applied. There is nothing to revert.' });
});

it('answers a post that names no change', async () => {
  const answer = await send('APP-1', 'all');

  expect(answer.status).toBe(409);
  expect(((await answer.json()) as { message: string }).message).toBe('That form named no change, so there was nothing to revert.');
});
