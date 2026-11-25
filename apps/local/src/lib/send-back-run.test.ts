import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeSetting } from '@nolzu/core/node';
import type { Job } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { moveTo, sendBack } from '../routes/api/board/writes.ts';
import { createLoop, type Loop } from './loop.ts';

// Send back with comments on the real loop with the fake engine: the card goes back to Implement by
// Fix it's path, and the implement session goes on with every open diff comment once. The ones sent
// before stay out, and only a start marks the sent ones.
let dir = '';
let loop: Loop;
let spawned: Job[] = [];
let replay: (job: Job, signal: AbortSignal) => AsyncIterable<string>;

const IMPLEMENT_SESSION = 'c5d9e2f1-7a3b-4c8d-9e0f-3b4a5c6d7e03';
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-send-back-'));
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  spawned = [];
  replay = loop.engine.spawn.bind(loop.engine);
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    spawned.push(job);
    return replay(job, signal);
  };
});

afterEach(() => {
  loop.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (key: string, stage: string, state = 'idle') =>
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, ?, ?)").run(key, stage, state, `${key} title`);
const card = (key: string) => loop.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: string };
const runs = (key: string) => loop.db.prepare('SELECT phase, state FROM runs WHERE card_key = ? ORDER BY id').all(key) as { phase: string; state: string }[];
const sentAt = (key: string) => (loop.db.prepare('SELECT body, sent_at FROM diff_comments WHERE card_key = ? ORDER BY id').all(key) as { body: string; sent_at: string | null }[]).map((row) => [row.body, row.sent_at]);

function comment(key: string, line: number, lineText: string, body: string, sent: string | null = null): void {
  loop.db
    .prepare('INSERT INTO diff_comments (card_key, repo, file, line, line_text, body, commit_sha, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(key, '.', 'src/RecipeCard.svelte', line, lineText, body, 'abc123', '2026-10-15T08:00:00.000Z', sent);
}

async function settled(): Promise<void> {
  await vi.waitFor(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queue = loop.scheduler.queue();
    expect(queue.running.length + queue.waiting.length).toBe(0);
  }, WAIT);
}

// A card whose Implement run ended ready, so its session is there to go on in.
async function implemented(key: string): Promise<void> {
  addCard(key, 'plan', 'ready');
  expect(await moveTo(loop, key, 'implement')).toBeNull();
  await settled();
  expect(card(key)).toEqual({ stage: 'implement', state: 'ready' });
  spawned = [];
}

const count = (text: string, part: string) => text.split(part).length - 1;

it('goes on in the implement session with each open comment once, with its line, and leaves out the sent ones', async () => {
  await implemented('APP-1');
  comment('APP-1', 3, '    <img />', 'Use the placeholder from assets.');
  comment('APP-1', 5, '    <div class="img-missing"></div>', 'Name the class after what it shows.');
  comment('APP-1', 1, '<article>', 'Already sent last time.', '2026-10-14T08:00:00.000Z');

  expect(await loop.sendBack('APP-1')).toBe(true);
  await vi.waitFor(() => expect(card('APP-1')).toEqual({ stage: 'implement', state: 'ready' }), WAIT);
  await settled();

  expect(spawned.map((job) => job.phase)).toEqual(['implement']);
  const job = spawned[0]!;
  expect(job.resumeFrom).toBe(IMPLEMENT_SESSION);
  expect(job.prompt).toContain('left 2 comments');
  expect(count(job.prompt, 'Use the placeholder from assets.')).toBe(1);
  expect(count(job.prompt, 'Name the class after what it shows.')).toBe(1);
  // Each with its file, its line and the line's text. No checkout here, so each says it is outdated.
  expect(job.prompt).toContain('In the project folder, src/RecipeCard.svelte, made on line 3.');
  expect(job.prompt).toContain('The line it was made on: <img />');
  expect(job.prompt).toContain('made on line 5.');
  expect(job.prompt).not.toContain('Already sent last time.');
  // No QA after it: the card waits ready on Implement.
  expect(runs('APP-1').map((run) => run.phase)).toEqual(['implement', 'implement']);

  const rows = sentAt('APP-1');
  expect(rows[0]?.[1]).not.toBeNull();
  expect(rows[1]?.[1]).not.toBeNull();
  expect(rows[2]).toEqual(['Already sent last time.', '2026-10-14T08:00:00.000Z']);
});

it('moves a card in Review back to Implement first, as the person who pressed', async () => {
  await implemented('APP-1');
  loop.db.prepare("UPDATE cards SET stage = 'review', state = 'idle' WHERE key = 'APP-1'").run();
  comment('APP-1', 3, '    <img />', 'Use the placeholder from assets.');

  expect(await loop.sendBack('APP-1')).toBe(true);
  await vi.waitFor(() => expect(card('APP-1')).toEqual({ stage: 'implement', state: 'ready' }), WAIT);

  expect(spawned[0]?.resumeFrom).toBe(IMPLEMENT_SESSION);
  const moves = loop.db.prepare("SELECT from_stage, to_stage, who, started_phase FROM card_events WHERE card_key = 'APP-1' ORDER BY id").all();
  expect(moves.at(-1)).toEqual({ from_stage: 'review', to_stage: 'implement', who: 'you', started_phase: null });
});

it('starts a fresh Implement run with the comments after the card prompt when no implement session is left', async () => {
  addCard('APP-2', 'review', 'idle');
  comment('APP-2', 3, '    <img />', 'Use the placeholder from assets.');

  expect(await loop.sendBack('APP-2')).toBe(true);
  await vi.waitFor(() => expect(card('APP-2')).toEqual({ stage: 'implement', state: 'ready' }), WAIT);

  const job = spawned[0]!;
  expect(job.phase).toBe('implement');
  expect(job.resumeFrom).toBeNull();
  expect(job.prompt.split('\n')[0]).toContain('/implement/instructions.md`');
  expect(count(job.prompt, 'Use the placeholder from assets.')).toBe(1);
  expect(sentAt('APP-2')[0]?.[1]).not.toBeNull();
});

it('leaves the comments open when the start fails, and the card failed with the reason', async () => {
  await implemented('APP-1');
  // The profile that holds the session is gone from this machine, so the resume cannot be built.
  loop.db.prepare("UPDATE runs SET engine = 'gone-login' WHERE card_key = 'APP-1'").run();
  comment('APP-1', 3, '    <img />', 'Use the placeholder from assets.');

  expect(await loop.sendBack('APP-1')).toBe(false);

  expect(card('APP-1').state).toBe('failed');
  expect(spawned).toEqual([]);
  expect(sentAt('APP-1')).toEqual([['Use the placeholder from assets.', null]]);
});

it('refuses a card that is running, one before Implement, and one with no open comment, and writes nothing', async () => {
  addCard('APP-3', 'plan', 'ready');
  comment('APP-3', 3, '    <img />', 'Too early.');
  await expect(loop.sendBack('APP-3')).rejects.toThrow('APP-3 sits in plan, so there is no Implement run to send comments back to.');

  addCard('APP-4', 'qa', 'running');
  comment('APP-4', 3, '    <img />', 'While QA runs.');
  await expect(loop.sendBack('APP-4')).rejects.toThrow('APP-4 is running. Wait for the run to end, then send the comments back.');

  addCard('APP-5', 'review', 'idle');
  comment('APP-5', 3, '    <img />', 'Sent.', '2026-10-14T08:00:00.000Z');
  await expect(loop.sendBack('APP-5')).rejects.toThrow('APP-5 has no open comments to send back.');

  expect(spawned).toEqual([]);
  expect(sentAt('APP-3')).toEqual([['Too early.', null]]);
  expect(sentAt('APP-4')).toEqual([['While QA runs.', null]]);
  expect(card('APP-3')).toEqual({ stage: 'plan', state: 'ready' });
  expect(card('APP-5')).toEqual({ stage: 'review', state: 'idle' });
});

// The route the buttons post to: the loop's sentence on a refusal, and ok once the run is queued.
it('answers the send back route with the refusal, or with ok once Implement is queued', async () => {
  addCard('APP-9', 'review', 'idle');
  const refused = await sendBack(loop, 'APP-9');
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ message: 'APP-9 has no open comments to send back. Comment on a line on the Changes tab first.' });

  comment('APP-9', 3, '    <img />', 'Use the placeholder from assets.');
  expect((await sendBack(loop, 'APP-9')).status).toBe(200);
  await vi.waitFor(() => expect(card('APP-9')).toEqual({ stage: 'implement', state: 'ready' }), WAIT);
});

// The line a comment points at is read from the card's own checkout of the repository it names, so
// two cards with the same file at different lines, and a comment on a child repository, each get
// their own line number.
it('points each comment at its line in its own card and its own repository checkout', async () => {
  const project = join(dir, 'project');
  const put = (path: string, lines: string[]) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join('\n')}\n`);
  };
  mkdirSync(project);
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'first']]) {
    execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', ...args], { cwd: project });
  }
  writeSetting(loop.db, 'projectPath', project);
  await implemented('APP-1');
  await implemented('APP-2');
  put(join(project, 'worktrees', 'APP-1', 'src/RecipeCard.svelte'), ['<article>', '  <p />', '  <p />', '  <p />', '    <img />']);
  put(join(project, 'worktrees', 'APP-2', 'src/RecipeCard.svelte'), ['<article>', '', '', '', '', '', '', '    <img />']);
  put(join(project, 'worktrees', 'APP-1', 'api', 'src/RecipeCard.svelte'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', '    <img />']);
  const at = (key: string, repo: string) =>
    loop.db
      .prepare('INSERT INTO diff_comments (card_key, repo, file, line, line_text, body, commit_sha, created_at) VALUES (?, ?, ?, 3, ?, ?, ?, ?)')
      .run(key, repo, 'src/RecipeCard.svelte', '    <img />', `Comment on ${key} in ${repo}.`, 'abc123', '2026-10-15T08:00:00.000Z');
  at('APP-1', '.');
  at('APP-1', 'api');
  at('APP-2', '.');

  await loop.sendBack('APP-1');
  await loop.sendBack('APP-2');
  await vi.waitFor(() => expect(spawned.length).toBe(2), WAIT);

  const prompt = (comment: string) => spawned.find((job) => job.prompt.includes(comment))!.prompt;
  expect(prompt('Comment on APP-1 in ..')).toContain('In the project folder, src/RecipeCard.svelte, line 5 (made on line 3).');
  expect(prompt('Comment on APP-1 in api.')).toContain('In the api repository, src/RecipeCard.svelte, line 10 (made on line 3).');
  expect(prompt('Comment on APP-2 in ..')).toContain('In the project folder, src/RecipeCard.svelte, line 8 (made on line 3).');
});
