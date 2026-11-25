import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Thread } from '@nolzu/core';
import { DEFAULT_PROFILE } from '@nolzu/protocol';
import { bumpVersion, createCard, followPreset, openDatabase, saveRun, startRun, writeSetting } from '@nolzu/core/node';
import { parseRunLine } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMessage, answerOf, cleanSubject, discussionFor, messagesIn, oneLine, recordPhaseSummary, renameThread, saveSubject, sendMessage, wantsSubject, withTools } from './discussion.ts';

let dir: string;
let db: DatabaseSync;
// What each vendor offers. The composer's list follows the profile the thread's session lives in.
const MODELS = { 'claude-code': ['haiku', 'sonnet'] };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-discussion-'));
  db = openDatabase(join(dir, 'nolzu.db'));
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'plan', title: 'A card', summary: null, source: 'local', sourceRef: null });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// A finished run of one phase, which is what gives a thread its session.
const ran = (phase: string, sessionId: string | null, engine = 'claude-code'): number => {
  const id = startRun(db, { cardKey: 'APP-1', phase, engine, model: 'sonnet', effort: 'medium', sessionId, logPath: '', lane: null });
  saveRun(db, id, {
    sessionId,
    model: 'sonnet',
    costUsd: null,
    durationMs: null,
    tokens: null,
    question: null,
    failureReason: null,
    failureStatus: null,
    state: 'complete',
    cardState: 'ready',
    retry: null,
  });
  return id;
};

describe('discussionFor', () => {
  // An answer from Before you approve is stored on the phase's thread but goes to no agent: the next
  // phase reads it when the card moves, so the Discussion marks it with that phase.
  it('marks an answer from Before you approve with the phase that reads it', () => {
    const id = ran('refine', 's-1');
    addMessage(db, 'APP-1', 'refine', 'person', 'Q1: Match ingredients? I take the default: no.', id);
    addMessage(db, 'APP-1', 'refine', 'person', 'Q2: Keep the text? My answer: yes, until reload.', id);
    addMessage(db, 'APP-1', 'refine', 'person', 'Q1: why did you pick titles only?', id);

    const found = discussionFor(db, 'APP-1', 'refine', MODELS).messages;

    expect(found.map((message) => message.forNext ?? null)).toEqual(['Plan', 'Plan', null]);
  });

  it('gives a thread per phase that ran, and shows the first by default', () => {
    ran('refine', 's-1');
    ran('plan', 's-2');

    const found = discussionFor(db, 'APP-1', null, MODELS);

    // Newest first, so the phase a person is looking at is the one that opens.
    expect(found.threads.map((thread) => thread.id)).toEqual(['plan', 'refine', 'ask']);
    expect(found.current).toBe('plan');
  });

  it('opens the thread the URL names', () => {
    ran('refine', 's-1');
    ran('plan', 's-2');

    expect(discussionFor(db, 'APP-1', 'refine', MODELS).current).toBe('refine');
  });

  // A thread that is not on this card falls back, the same way an unknown tab falls back to the
  // overview, rather than showing an empty panel with no way back.
  it('falls back when the URL names a thread the card does not have', () => {
    ran('plan', 's-2');

    expect(discussionFor(db, 'APP-1', 'qa', MODELS).current).toBe('plan');
  });

  it('carries the profile the run recorded onto the thread', () => {
    ran('plan', 's-2', 'codex#work');

    const [thread] = discussionFor(db, 'APP-1', null, MODELS).threads;

    expect(thread).toMatchObject({ sessionId: 's-2', engine: 'codex#work' });
  });

  // The message continues that thread's own session, which lives in one login, so the composer
  // offers that login's models and not the ones of the profile the action table names now.
  it('offers the models of the profile the thread session lives in', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/nolzu-discussion-codex' }]);
    ran('plan', 's-2', 'codex#work');

    expect(discussionFor(db, 'APP-1', null, { ...MODELS, codex: ['gpt-9'] }).models).toEqual(['gpt-9']);
  });

  it('shows only the messages of the thread that is open', () => {
    ran('refine', 's-1');
    ran('plan', 's-2');
    addMessage(db, 'APP-1', 'plan', 'person', 'about the plan', null);
    addMessage(db, 'APP-1', 'refine', 'person', 'about the brief', null);

    expect(discussionFor(db, 'APP-1', 'plan', MODELS).messages.map((one) => one.body)).toEqual(['about the plan']);
  });

  it('gives a card that ran nothing the ask thread alone', () => {
    const found = discussionFor(db, 'APP-1', null, MODELS);

    expect(found.threads.map((thread) => thread.id)).toEqual(['ask']);
    expect(found.messages).toEqual([]);
  });
});

// What the composer names beside the session line.
describe('discussionFor, the resume command and the model', () => {
  it('copies a command that names the worktree, the resume flag and the session', () => {
    writeSetting(db, 'projectPath', '/home/dev/recipes');
    ran('implement', 's-2');

    expect(discussionFor(db, 'APP-1', null, MODELS).resume).toBe("cd '/home/dev/recipes/worktrees/APP-1' && claude --resume 's-2'");
  });

  // A refine on several repositories can start in the project folder, and the run records that.
  it('names the folder the session started in when the run recorded one', () => {
    writeSetting(db, 'projectPath', '/home/dev/recipes');
    const id = ran('refine', 's-5');
    db.prepare('UPDATE runs SET cwd = ? WHERE id = ?').run('/home/dev/recipes', id);

    expect(discussionFor(db, 'APP-1', null, MODELS).resume).toBe("cd '/home/dev/recipes' && claude --resume 's-5'");
  });

  // A read-only phase on Codex starts in the card folder, and the command has to start where the run did.
  it('starts a Codex refine resume in the card folder, with the profile login folder', () => {
    writeSetting(db, 'projectPath', '/home/dev/recipes');
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/home/dev/.codex-work' }]);
    ran('refine', 's-3', 'codex#work');

    expect(discussionFor(db, 'APP-1', null, MODELS).resume).toBe(
      "cd '/home/dev/recipes/.tasks/APP-1' && CODEX_HOME='/home/dev/.codex-work' codex resume 's-3'",
    );
  });

  it('reads where a Codex session started from its own card', () => {
    writeSetting(db, 'projectPath', '/home/dev/recipes');
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/home/dev/.codex-work' }]);
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'plan', title: 'Other', summary: null, source: 'local', sourceRef: null });
    const row = (cardKey: string) => startRun(db, { cardKey, phase: 'refine', engine: 'codex#work', model: 'gpt-5.6-terra', effort: 'low', sessionId: 'shared', logPath: '', lane: null });
    db.prepare('UPDATE runs SET in_card_folder = 0 WHERE id = ?').run(row('APP-1'));
    row('APP-2'); // an old row: in_card_folder is NULL

    expect(discussionFor(db, 'APP-2', null, MODELS).resume).toContain("cd '/home/dev/recipes/.tasks/APP-2'");
  });

  it('offers no command for a thread with no session, or with no project set', () => {
    writeSetting(db, 'projectPath', '/home/dev/recipes');
    ran('plan', null);
    expect(discussionFor(db, 'APP-1', null, MODELS).resume).toBeNull();

    writeSetting(db, 'projectPath', null);
    ran('implement', 's-4');
    expect(discussionFor(db, 'APP-1', null, MODELS).resume).toBeNull();
  });

  // A card on another preset names that preset's model, and not the model of another card.
  it('names the model of the preset the card follows', () => {
    for (const key of ['APP-1', 'APP-2']) {
      if (key === 'APP-2') createCard(db, { key, board: 'delivery', stage: 'plan', title: 'Other', summary: null, source: 'local', sourceRef: null });
      const id = startRun(db, { cardKey: key, phase: 'plan', engine: 'claude-code', model: 'sonnet', effort: 'medium', sessionId: `s-${key}`, logPath: '', lane: null });
      saveRun(db, id, { sessionId: `s-${key}`, model: 'sonnet', costUsd: null, durationMs: null, tokens: null, question: null, failureReason: null, failureStatus: null, state: 'complete', cardState: 'ready', retry: null });
    }
    followPreset(db, 'APP-2', 'heavy');
    const offers = { 'claude-code': ['haiku', 'sonnet', 'opus'] };

    expect(discussionFor(db, 'APP-1', null, offers).phaseModel).toBe('sonnet');
    expect(discussionFor(db, 'APP-2', null, offers).phaseModel).toBe('opus');
  });

  // The model a message runs on when the person picks none: the table, under the thread's profile.
  it('names the model the phase runs on when no model is picked', () => {
    writeSetting(db, 'models', { plan: { model: 'haiku' } });
    ran('plan', 's-2');

    expect(discussionFor(db, 'APP-1', null, MODELS).phaseModel).toBe('haiku');
    // An ask discussion runs the ask row, haiku on Claude Code.
    expect(discussionFor(db, 'APP-1', 'ask', MODELS).phaseModel).toBe('haiku');
  });

  // The project row was chosen under the default profile, so a thread on another profile does not
  // run it. Without the pin this would name the row's model.
  it('names the model of the thread profile, not a row chosen under another profile', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/nolzu-discussion-pin' }]);
    writeSetting(db, 'models', { plan: { model: 'haiku' } });
    ran('plan', 's-2', 'codex#work');

    expect(discussionFor(db, 'APP-1', null, { ...MODELS, codex: ['gpt-5.6-terra'] }).phaseModel).toBe('gpt-5.6-terra');
  });

  // Two threads on two profiles: the command and the model follow the open one, not the first one listed.
  it('builds the command and the model from the open thread when there are several', () => {
    writeSetting(db, 'projectPath', '/home/dev/recipes');
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: null }]);
    writeSetting(db, 'models', { plan: { model: 'haiku' }, implement: { model: 'sonnet' } });
    ran('refine', 's-3', 'codex#work');
    ran('implement', 's-4');

    expect(discussionFor(db, 'APP-1', 'refine', MODELS).resume).toBe("cd '/home/dev/recipes/.tasks/APP-1' && codex resume 's-3'");
    const implement = discussionFor(db, 'APP-1', 'implement', MODELS);
    expect(implement.resume).toBe("cd '/home/dev/recipes/worktrees/APP-1' && claude --resume 's-4'");
    expect(implement.phaseModel).toBe('sonnet');
  });
});

// More than one ask discussion on a card.
describe('discussionFor, ask discussions', () => {
  it('lists each discussion apart, newest first, and each keeps its own messages', () => {
    addMessage(db, 'APP-1', 'ask', 'person', 'first question', null);
    addMessage(db, 'APP-1', 'ask-2', 'person', 'second question', null);

    const found = discussionFor(db, 'APP-1', 'ask-2', MODELS);

    expect(found.threads.map((thread) => thread.id)).toEqual(['ask-2', 'ask']);
    expect(found.current).toBe('ask-2');
    expect(found.messages.map((one) => one.body)).toEqual(['second question']);
    expect(discussionFor(db, 'APP-1', 'ask', MODELS).messages.map((one) => one.body)).toEqual(['first question']);
    expect(found.next).toBe('ask-3');
  });

  // The discussions of another card are not this card's, so they neither show nor push the next id.
  it('counts only the discussions of its own card', () => {
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'plan', title: 'Another card', summary: null, source: 'local', sourceRef: null });
    addMessage(db, 'APP-2', 'ask-5', 'person', 'elsewhere', null);

    const found = discussionFor(db, 'APP-1', null, MODELS);

    expect(found.threads.map((thread) => thread.id)).toEqual(['ask']);
    expect(found.next).toBe('ask-2');
  });

  // A new discussion is the next id, and it opens empty: nothing of the earlier ones is in it.
  it('opens a new discussion with no earlier message', () => {
    addMessage(db, 'APP-1', 'ask', 'person', 'first question', null);

    const found = discussionFor(db, 'APP-1', 'ask-2', MODELS);

    expect(found.current).toBe('ask-2');
    expect(found.messages).toEqual([]);
  });

  // A new discussion has no session yet, so its first message starts one on the ask row's profile.
  it('hands the first message of a new discussion to the loop, which starts its session', async () => {
    const calls: { thread: Thread }[] = [];
    const answer = await sendMessage(
      db,
      'APP-1',
      new Request('http://localhost/api/card/APP-1/message', { method: 'POST', body: JSON.stringify({ thread: 'ask-2', text: 'a new question' }) }),
      (_key, thread) => (calls.push({ thread }), true),
      MODELS,
    );

    expect(answer.status).toBe(200);
    expect(calls.map((one) => one.thread)).toEqual([expect.objectContaining({ id: 'ask-2', kind: 'ask', sessionId: null, engine: 'claude-code' })]);
    expect(messagesIn(db, 'APP-1', 'ask-2').map((one) => one.body)).toEqual(['a new question']);
  });
});

describe('sendMessage', () => {
  const post = (body: unknown) =>
    new Request('http://localhost/api/card/APP-1/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  // The resume, recorded rather than run. What it was handed is the thing worth asserting: a
  // message that continued the wrong session or the wrong login is the bug this path can have.
  const recorder = () => {
    const calls: { key: string; thread: Thread; text: string }[] = [];
    return {
      calls,
      resume: (key: string, thread: Thread, text: string) => (calls.push({ key, thread, text }), true),
    };
  };

  it('stores the message and continues that thread on its own profile', async () => {
    ran('plan', 's-2', 'codex#work');
    const { calls, resume } = recorder();

    const answer = await sendMessage(db, 'APP-1', post({ thread: 'plan', text: '  use the other index  ' }), resume, MODELS);

    expect(answer.status).toBe(200);
    // The effect: the thread holds it, trimmed, as the person's own.
    expect(messagesIn(db, 'APP-1', 'plan').map((one) => [one.author, one.body])).toEqual([['person', 'use the other index']]);
    expect(calls[0]?.thread.sessionId).toBe('s-2');
    expect(calls[0]?.thread.engine).toBe('codex#work');
  });

  // A person's words are never lost to a run that would not start, so the message is stored first
  // and the thread shows it with whatever the run said.
  // False means the card is failed with the reason. Answering 200 here let the composer say
  // "Sent. Waiting for the board", which is a busy state that lies.
  it('says the run did not start, and keeps the message', async () => {
    ran('plan', 's-2');

    const answer = await sendMessage(db, 'APP-1', post({ thread: 'plan', text: 'go on' }), () => false, MODELS);

    expect(answer.status).toBe(500);
    expect(await answer.json()).toMatchObject({ message: expect.stringContaining('marked failed') });
    expect(messagesIn(db, 'APP-1', 'plan')).toHaveLength(1);
  });

  // Every refusal, and none of them stores anything: a message nobody could send is not a message
  // in the thread.
  it('refuses a thread that is not there, one with no session, and an empty message', async () => {
    ran('plan', 's-2');
    ran('refine', null);
    const { calls, resume } = recorder();

    const noThread = await sendMessage(db, 'APP-1', post({ thread: 'qa', text: 'hello' }), resume, MODELS);
    const noSession = await sendMessage(db, 'APP-1', post({ thread: 'refine', text: 'hello' }), resume, MODELS);
    const empty = await sendMessage(db, 'APP-1', post({ thread: 'plan', text: '   ' }), resume, MODELS);

    expect([noThread.status, noSession.status, empty.status]).toEqual([400, 400, 400]);
    expect(await noSession.json()).toMatchObject({ message: expect.stringContaining('no session') });
    expect(calls).toEqual([]);
    expect(messagesIn(db, 'APP-1', 'plan')).toEqual([]);
    expect(messagesIn(db, 'APP-1', 'refine')).toEqual([]);
  });

  // The ask thread belongs to no phase and starts a read-only session of its own,
  // so the message is kept and handed on like any other.
  it('keeps a message in the ask thread and hands it on to start its session', async () => {
    const { calls, resume } = recorder();

    const answer = await sendMessage(db, 'APP-1', post({ thread: 'ask', text: 'where does the list come from?' }), resume, MODELS);

    expect(answer.status).toBe(200);
    expect(messagesIn(db, 'APP-1', 'ask').map((one) => one.body)).toEqual(['where does the list come from?']);
    expect(calls.map((one) => [one.thread.id, one.thread.sessionId, one.text])).toEqual([['ask', null, 'where does the list come from?']]);
  });

  // The loop throws for a card nothing may start on, and that sentence names the state. Without
  // this the page showed "refused with 500" and the reason was lost.
  it('hands back the loop sentence when the run is refused', async () => {
    ran('plan', 's-2');
    const refuse = () => {
      throw new Error('APP-1 is blocked. Answer the question on the overview first.');
    };

    const answer = await sendMessage(db, 'APP-1', post({ thread: 'plan', text: 'go on' }), refuse, MODELS);

    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ message: expect.stringContaining('is blocked') });
    // The words are kept, because they are the person's.
    expect(messagesIn(db, 'APP-1', 'plan')).toHaveLength(1);
  });

  // A model the engine does not offer would fail at the spawn, after the card was queued.
  it('refuses a model the engine does not offer, before anything is stored', async () => {
    ran('plan', 's-2');
    const { calls, resume } = recorder();

    const answer = await sendMessage(db, 'APP-1', post({ thread: 'plan', text: 'go on', model: 'gpt-9' }), resume, MODELS);

    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ message: expect.stringContaining('haiku, sonnet') });
    expect(messagesIn(db, 'APP-1', 'plan')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('passes the model on when the engine offers it', async () => {
    ran('plan', 's-2');
    const calls: string[] = [];

    await sendMessage(
      db,
      'APP-1',
      post({ thread: 'plan', text: 'try haiku', model: 'haiku' }),
      (_key, _thread, _text, model) => (calls.push(model ?? ''), true),
      MODELS,
    );

    expect(calls).toEqual(['haiku']);
  });

  it('refuses a body that is not JSON, rather than throwing', async () => {
    const answer = await sendMessage(db, 'APP-1', post('not json'), () => true, MODELS);

    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ message: expect.stringContaining('JSON') });
  });

  // The composer's list is the thread's own profile's, because the session lives inside that
  // login. A model of the other vendor would fail at the spawn, after the card was queued.
  describe('a thread on a second profile', () => {
    const CODEX = { id: 'codex#work', label: 'Codex work', vendor: 'codex' as const, configDir: '/tmp/nolzu-discussion-codex' };
    const BOTH = { ...MODELS, codex: ['gpt-9', 'gpt-9-mini'] };
    const both = () => writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);

    it('offers the models of the profile it runs on', () => {
      both();
      ran('plan', 's-2', 'codex#work');

      expect(discussionFor(db, 'APP-1', 'plan', BOTH).models).toEqual(['gpt-9', 'gpt-9-mini']);
    });

    it('refuses a model of the other vendor, and names what this thread offers', async () => {
      both();
      ran('plan', 's-2', 'codex#work');
      const { calls, resume } = recorder();

      const answer = await sendMessage(db, 'APP-1', post({ thread: 'plan', text: 'go on', model: 'haiku' }), resume, BOTH);

      expect(answer.status).toBe(400);
      expect(await answer.json()).toMatchObject({ message: expect.stringContaining('gpt-9, gpt-9-mini') });
      expect(calls).toEqual([]);
      expect(messagesIn(db, 'APP-1', 'plan')).toEqual([]);
    });

    // A login somebody removed. Nothing here knows what it offered, so the composer offers nothing
    // and a model sent anyway is refused with the profile named.
    it('offers no model for a thread whose profile was removed', async () => {
      both();
      ran('plan', 's-2', 'codex#gone');
      const { calls, resume } = recorder();

      expect(discussionFor(db, 'APP-1', 'plan', BOTH).models).toEqual([]);

      const answer = await sendMessage(db, 'APP-1', post({ thread: 'plan', text: 'go on', model: 'haiku' }), resume, BOTH);

      expect(answer.status).toBe(400);
      expect(await answer.json()).toMatchObject({ message: expect.stringContaining('codex#gone') });
      expect(calls).toEqual([]);
    });
  });
});

describe('recordPhaseSummary', () => {
  const summarised = (phase: string, summary: string | null): number => {
    const id = ran(phase, 's-2');
    loopDb().prepare('UPDATE runs SET plain_summary = ? WHERE id = ?').run(summary, id);
    return id;
  };
  const loopDb = () => db;

  // What makes the thread a conversation rather than a notebook: the phase's own words land in
  // its thread, so a person reads the answer where they asked.
  it('puts the phase summary in its thread, as the agent', () => {
    const runId = summarised('plan', 'I named the index recipes_title_idx.');

    recordPhaseSummary(db, { runId, cardKey: 'APP-1', phase: 'plan' });

    expect(messagesIn(db, 'APP-1', 'plan').map((one) => [one.author, one.body, one.runId])).toEqual([
      ['agent', 'I named the index recipes_title_idx.', runId],
    ]);
  });

  // Both of the other paths. A run that wrote no summary leaves the thread as it was, rather than
  // showing an empty message, and the summary pass has no thread to write into at all.
  it('writes nothing for a run with no summary, or one with no thread', () => {
    const empty = summarised('plan', '   ');
    const none = summarised('plan', null);
    const pass = summarised('extract-summary', 'the summary of the summary');

    recordPhaseSummary(db, { runId: empty, cardKey: 'APP-1', phase: 'plan' });
    recordPhaseSummary(db, { runId: none, cardKey: 'APP-1', phase: 'plan' });
    recordPhaseSummary(db, { runId: pass, cardKey: 'APP-1', phase: 'extract-summary' });

    expect(messagesIn(db, 'APP-1', 'plan')).toEqual([]);
    expect(messagesIn(db, 'APP-1', 'extract-summary')).toEqual([]);
  });

  // The conversation, in order: what the person asked, then what the phase answered.
  it('reads back after the person message, in the order they happened', () => {
    const runId = summarised('plan', 'Done, the plan names it now.');
    addMessage(db, 'APP-1', 'plan', 'person', 'use the other index', runId);

    recordPhaseSummary(db, { runId, cardKey: 'APP-1', phase: 'plan' });

    expect(messagesIn(db, 'APP-1', 'plan').map((one) => one.author)).toEqual(['person', 'agent']);
  });
});

// The agent's tool calls, read from the log of the run that made them.
describe('withTools', () => {
  // Claude Code lines, the way a run writes them: one call per line, the answer on a later line.
  const use = (id: string, name: string, input: object) =>
    JSON.stringify({ type: 'assistant', message: { id: `msg-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
  const answer = (id: string, content: string, error = false) =>
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: error }] } });

  // A finished run with its log file and the summary it posted. Null lines leave no file behind.
  const logged = (phase: string, sessionId: string, lines: string[] | null): number => {
    const id = ran(phase, sessionId);
    const path = join(dir, `run-${id}.ndjson`);
    if (lines !== null) writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
    db.prepare('UPDATE runs SET log_path = ?, cwd = ? WHERE id = ?').run(path, '/work/APP-1', id);
    addMessage(db, 'APP-1', phase, 'agent', `What ${phase} did.`, id);
    return id;
  };
  const view = (thread: string) => withTools(db, discussionFor(db, 'APP-1', thread, MODELS), parseRunLine);

  it('reads each thread its own run rows, from that run log', async () => {
    logged('refine', 's-1', [use('t1', 'Glob', { pattern: 'api/src/**' }), answer('t1', 'api/src/recipes.ts')]);
    logged('plan', 's-2', [use('t2', 'Read', { file_path: '/work/APP-1/api/src/recipes.ts' }), answer('t2', 'export const recipes = [];\n')]);

    const refine = await view('refine');
    const plan = await view('plan');

    expect(refine.messages[0]?.tools).toEqual([
      { name: 'Glob', subject: 'api/src/**', input: JSON.stringify({ pattern: 'api/src/**' }, null, 2), result: { bytes: 18, error: false } },
    ]);
    // The path reads from the checkout the run worked in, as the card's activity line reads it.
    expect(plan.messages[0]?.tools?.map((call) => [call.name, call.subject, call.result])).toEqual([['Read', 'api/src/recipes.ts', { bytes: 27, error: false }]]);
  });

  // One thread, two runs of it: each agent message shows the calls of the run that wrote it.
  it('gives each agent message in one thread the rows of its own run, not of the first', async () => {
    logged('plan', 's-2', [use('t1', 'Read', { file_path: 'first.ts' }), answer('t1', 'one')]);
    logged('plan', 's-2', [use('t2', 'Grep', { pattern: 'second' }), answer('t2', 'two')]);

    const messages = (await view('plan')).messages;

    expect(messages.map((message) => message.tools?.map((call) => call.subject))).toEqual([['first.ts'], ['second']]);
  });

  // Two calls in a row, answered on later lines: each answer goes to its own call, oldest first.
  it('pairs answers that come after several calls with their calls in order', async () => {
    logged('plan', 's-2', [use('t1', 'Read', { file_path: 'a.ts' }), use('t2', 'Bash', { command: 'pnpm test' }), answer('t1', 'one'), answer('t2', 'failed', true)]);

    const [message] = (await view('plan')).messages;

    expect(message?.tools?.map((call) => [call.name, call.subject, call.result])).toEqual([
      ['Read', 'a.ts', { bytes: 3, error: false }],
      ['Bash', 'pnpm test', { bytes: 6, error: true }],
    ]);
  });

  it('gives the person messages no tool rows, and a call with no answer no result', async () => {
    const run = logged('plan', 's-2', [use('t1', 'Read', { file_path: 'a.ts' })]);
    addMessage(db, 'APP-1', 'plan', 'person', 'why this file?', run);

    const messages = (await view('plan')).messages;

    expect(messages[0]?.tools?.[0]?.result).toBeNull();
    expect(messages[1]).not.toHaveProperty('tools');
  });

  // The log is the one place the calls are kept. Gone, the row says so rather than showing none,
  // which would read as a run that called no tool.
  it('marks the tool rows of a run whose log is gone', async () => {
    logged('plan', 's-2', null);
    const never = ran('refine', 's-1');
    addMessage(db, 'APP-1', 'refine', 'agent', 'What refine did.', never);

    expect((await view('plan')).messages[0]?.tools).toBeNull();
    expect((await view('refine')).messages[0]?.tools).toBeNull();
  });

  // Codex answers a command on the call's own line, and a file change gets no answer at all. The log is
  // read with the parser of the run's own engine, and an answer goes to the call on its line, never to
  // the change still waiting before it.
  it('reads a Codex run with its own parser and gives an answer to the call on its line', async () => {
    const id = ran('plan', 's-2', 'codex#work');
    const path = join(dir, `run-${id}.ndjson`);
    const item = (body: object) => JSON.stringify({ type: 'item.completed', item: body });
    writeFileSync(
      path,
      `${[
        item({ id: 'item_1', type: 'file_change', changes: [{ path: 'notes.md', kind: 'add' }], status: 'completed' }),
        item({ id: 'item_2', type: 'command_execution', command: 'rg -n listRecipes', aggregated_output: 'list.ts:1\n', exit_code: 0, status: 'completed' }),
      ].join('\n')}\n`,
    );
    db.prepare('UPDATE runs SET log_path = ?, cwd = ? WHERE id = ?').run(path, '/work/APP-1', id);
    addMessage(db, 'APP-1', 'plan', 'agent', 'What plan did.', id);

    const [message] = (await view('plan')).messages;

    expect(message?.tools?.map((call) => [call.name, call.subject, call.result])).toEqual([
      ['file_change', 'notes.md', null],
      ['command_execution', 'rg -n listRecipes', { bytes: 10, error: false }],
    ]);
  });
});

// Send resumes a run, so it shows what a run of this phase costs, and only where runs measured it
//.
describe('discussionFor, the estimate beside Send', () => {
  it('gives an estimate only for a model this project has measured runs of', () => {
    writeSetting(db, 'models', { plan: { model: 'sonnet', effort: 'medium' } });
    ran('plan', 's-1');

    expect(discussionFor(db, 'APP-1', 'plan', MODELS).estimates).toEqual({});

    for (let i = 0; i < 4; i += 1) ran('plan', `s-${i + 2}`);
    const found = discussionFor(db, 'APP-1', 'plan', MODELS);

    expect(found.phaseEffort).toBe('medium');
    expect(found.estimates.sonnet).toMatchObject({ from: 'history', runs: 5 });
    expect(found.estimates).not.toHaveProperty('haiku');
  });

  // An ask discussion shows what a new Ask session takes, from Ask runs only, and only once they measured
  // one. Plan runs say nothing about it, and the ask row has no measured preset figure.
  it('gives an ask discussion the estimate of Ask runs only, and only where they were measured', () => {
    for (let i = 0; i < 5; i += 1) ran('plan', `s-${i}`);

    const before = discussionFor(db, 'APP-1', 'ask', MODELS);
    expect(before.estimates).toEqual({});
    expect(before.phaseEffort).toBe('low');

    for (let i = 0; i < 5; i += 1) {
      const id = ran('ask', `a-${i}`);
      db.prepare("UPDATE runs SET effort = 'low', asked_model = 'haiku', started_at = '2026-10-15T10:00:00.000Z', ended_at = '2026-10-15T10:00:20.000Z' WHERE id = ?").run(id);
    }
    bumpVersion(db);
    const after = discussionFor(db, 'APP-1', 'ask', MODELS);
    expect(after.estimates.haiku).toMatchObject({ from: 'history', runs: 5 });
    expect(after.estimates).not.toHaveProperty('sonnet');
  });
});

describe('discussionFor, the thread list', () => {
  it('counts the messages of each thread and names when its run started', () => {
    const run = ran('plan', 's-2');
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run('2026-10-15T15:34:00.000Z', run);
    addMessage(db, 'APP-1', 'plan', 'person', 'why?', run);
    addMessage(db, 'APP-1', 'plan', 'agent', 'because.', run);

    const [plan, ask] = discussionFor(db, 'APP-1', null, MODELS).threads;

    expect(plan).toMatchObject({ id: 'plan', count: 2, at: '2026-10-15T15:34:00.000Z' });
    expect(ask).toMatchObject({ id: 'ask', count: 0, at: null });
  });

  // A phase gets its thread when it runs, so the board's other phases are listed to say so.
  it('lists the board phases that have not run yet, in board order', () => {
    ran('refine', 's-1');
    ran('implement', null);

    expect(discussionFor(db, 'APP-1', null, MODELS).later).toEqual([
      { id: 'plan', label: 'Plan' },
      { id: 'qa', label: 'QA' },
      { id: 'wrapup', label: 'Wrap-up' },
    ]);
  });

  // The list keeps the board's phase order, threads and greyed phases together.
  it('names the board phases in the order they run', () => {
    ran('implement', 's-3');

    expect(discussionFor(db, 'APP-1', null, MODELS).order).toEqual(['refine', 'plan', 'implement', 'qa', 'wrapup']);
  });

  // The trail's words: the time on the day it is, a short day before it otherwise.
  it('says when a run started and a message came in the trail words', () => {
    const run = ran('plan', 's-2');
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run('2026-10-17T15:34:00', run);
    addMessage(db, 'APP-1', 'plan', 'person', 'why?', run);
    db.prepare('UPDATE messages SET at = ?').run('2026-10-21T09:05:00');

    const found = discussionFor(db, 'APP-1', null, MODELS, new Date('2026-10-21T12:00:00'));

    expect(found.threads[0]).toMatchObject({ id: 'plan', when: 'Sat 15:34' });
    expect(found.messages[0]).toMatchObject({ when: '09:05' });
  });
});

// A line above the first message of each run, from the run row and the files of the phase's folder.
describe('discussionFor, the run divider', () => {
  beforeEach(() => writeSetting(db, 'projectPath', dir));

  it('puts the divider on the first message of each run, with the figures the row holds and the files the phase wrote', () => {
    const plan = ran('plan', 's-2');
    db.prepare('UPDATE runs SET started_at = ?, duration_ms = ?, cost_estimate = ? WHERE id = ?').run('2026-10-21T15:31:00', 72_000, 0.11, plan);
    mkdirSync(join(dir, '.tasks', 'APP-1', 'plan'), { recursive: true });
    mkdirSync(join(dir, '.tasks', 'APP-1', 'refine'), { recursive: true });
    writeFileSync(join(dir, '.tasks', 'APP-1', 'plan', 'plan.md'), '# Plan');
    writeFileSync(join(dir, '.tasks', 'APP-1', 'refine', 'ticket.md'), '# Ticket');
    addMessage(db, 'APP-1', 'plan', 'agent', 'The plan is ready.', plan);
    addMessage(db, 'APP-1', 'plan', 'person', 'why the api?', plan);
    const resumed = ran('plan', 's-2');
    addMessage(db, 'APP-1', 'plan', 'agent', 'Two reasons.', resumed);
    addMessage(db, 'APP-1', 'plan', 'person', 'a note before any run', null);

    const messages = discussionFor(db, 'APP-1', 'plan', MODELS, new Date('2026-10-21T16:00:00')).messages;

    expect(messages.map((message) => message.divider?.phase ?? null)).toEqual(['Plan', null, 'Plan', null]);
    expect(messages[0]!.divider).toEqual({ phase: 'Plan', started: '15:31', durationMs: 72_000, costUsd: 0.11, wrote: ['plan/plan.md'] });
    expect(messages[2]!.divider).toMatchObject({ durationMs: null, costUsd: null, wrote: ['plan/plan.md'] });
  });

  it('lists the files of the card it is on, not of another card', () => {
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'plan', title: 'Other', summary: null, source: 'local', sourceRef: null });
    const id = startRun(db, { cardKey: 'APP-2', phase: 'plan', engine: 'claude-code', model: 'sonnet', effort: 'medium', sessionId: 's-9', logPath: '', lane: null });
    mkdirSync(join(dir, '.tasks', 'APP-1', 'plan'), { recursive: true });
    mkdirSync(join(dir, '.tasks', 'APP-2', 'plan'), { recursive: true });
    writeFileSync(join(dir, '.tasks', 'APP-1', 'plan', 'one.md'), '# One');
    writeFileSync(join(dir, '.tasks', 'APP-2', 'plan', 'two.md'), '# Two');
    addMessage(db, 'APP-2', 'plan', 'agent', 'Done.', id);

    expect(discussionFor(db, 'APP-2', 'plan', MODELS).messages[0]!.divider?.wrote).toEqual(['plan/two.md']);
  });

  it('says the phase wrote nothing when its folder is not there', () => {
    const plan = ran('plan', 's-2');
    addMessage(db, 'APP-1', 'plan', 'agent', 'Done.', plan);

    expect(discussionFor(db, 'APP-1', 'plan', MODELS).messages[0]!.divider?.wrote).toEqual([]);
  });

  // A message into a phase thread queues its phase again. The run row says so from the queue on, so a
  // reload while it answers still holds Send.
  it('is busy while the phase thread newest run is queued or running, and not once it ends', () => {
    ran('refine', 's-1');
    ran('plan', 's-2');
    const again = startRun(db, { cardKey: 'APP-1', phase: 'plan', engine: 'claude-code', model: 'sonnet', effort: 'medium', sessionId: 's-2', logPath: '', lane: null });

    expect(discussionFor(db, 'APP-1', 'plan', MODELS).asking).toBe(true);
    expect(discussionFor(db, 'APP-1', 'refine', MODELS).asking).toBe(false);
    db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(again);
    expect(discussionFor(db, 'APP-1', 'plan', MODELS).asking).toBe(true);
    db.prepare("UPDATE runs SET state = 'failed' WHERE id = ?").run(again);
    expect(discussionFor(db, 'APP-1', 'plan', MODELS).asking).toBe(false);
  });
});

// An Ask discussion is a read-only session of its own: its runs name it, it goes on
// in the session they kept, and it is busy while its newest run goes.
describe('discussionFor, an ask discussion', () => {
  const asked = (thread: string, sessionId: string | null, state: string): number => {
    const id = startRun(db, { cardKey: 'APP-1', phase: 'ask', engine: 'claude-code', model: 'haiku', effort: 'low', sessionId, logPath: '', lane: null, thread });
    db.prepare('UPDATE runs SET state = ?, started_at = ? WHERE id = ?').run(state, '2026-10-15T15:40:00.000Z', id);
    return id;
  };

  it('goes on in the session its own Ask run kept, and an Ask run makes no thread of its own', () => {
    ran('plan', 's-2');
    addMessage(db, 'APP-1', 'ask-2', 'person', 'second', null);
    const first = asked('ask', 'a-1', 'complete');
    asked('ask-2', 'a-2', 'complete');

    const found = discussionFor(db, 'APP-1', 'ask', MODELS);

    expect(found.threads.map((one) => one.id)).toEqual(['plan', 'ask-2', 'ask']);
    expect(found.threads.find((one) => one.id === 'ask')).toMatchObject({ kind: 'ask', sessionId: 'a-1', engine: 'claude-code', runId: first, at: '2026-10-15T15:40:00.000Z' });
    expect(found.threads.find((one) => one.id === 'ask-2')).toMatchObject({ sessionId: 'a-2' });
    expect(found.asking).toBe(false);
  });

  it('is busy while its newest Ask run goes, and keeps the session a failed run did not have', () => {
    asked('ask', 'a-1', 'complete');
    asked('ask', null, 'running');

    const found = discussionFor(db, 'APP-1', 'ask', MODELS);

    expect(found.asking).toBe(true);
    expect(found.threads.find((one) => one.id === 'ask')?.sessionId).toBe('a-1');
    expect(discussionFor(db, 'APP-1', 'ask-2', MODELS).asking).toBe(false);
  });

  // Another card has an ask discussion of the same name: its messages, session and running run are its own.
  it('reads only its own card: another card ask discussion adds no count, session or busy state', () => {
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'plan', title: 'Other', summary: null, source: 'local', sourceRef: null });
    addMessage(db, 'APP-2', 'ask', 'person', 'other question', null);
    const other = startRun(db, { cardKey: 'APP-2', phase: 'ask', engine: 'claude-code', model: 'haiku', effort: 'low', sessionId: 'other-session', logPath: '', lane: null, thread: 'ask' });
    db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(other);

    const found = discussionFor(db, 'APP-1', 'ask', MODELS);

    expect(found.threads.find((one) => one.id === 'ask')).toMatchObject({ count: 0, sessionId: null, runId: null });
    expect(found.asking).toBe(false);
    expect(discussionFor(db, 'APP-2', 'ask', MODELS)).toMatchObject({ asking: true });
    expect(discussionFor(db, 'APP-2', 'ask', MODELS).threads.find((one) => one.id === 'ask')).toMatchObject({ count: 1, sessionId: 'other-session' });
  });

  // A new discussion has no session, so it names the profile its first message will start on.
  it('names the engine a new discussion starts on, and offers its models', () => {
    const found = discussionFor(db, 'APP-1', 'ask', MODELS);

    expect(found.threads.find((one) => one.id === 'ask')).toMatchObject({ sessionId: null, engine: 'claude-code' });
    expect(found.models).toEqual(['haiku', 'sonnet']);
    expect(found.resume).toBeNull();
  });
});

describe('answerOf', () => {
  it('answers with the text after the last tool call, which is the last message', () => {
    expect(
      answerOf([
        { type: 'text', text: 'Reading the list.' },
        { type: 'tool', name: 'Read', input: { file_path: 'list.ts' } },
        { type: 'tool_result', bytes: 120, error: false },
        { type: 'text', text: 'The list comes from one file.' },
        { type: 'text', text: 'Nothing caches it.' },
        { type: 'complete', costUsd: 0.01, durationMs: 6000, tokens: null },
      ]),
    ).toBe('The list comes from one file.\nNothing caches it.');
    expect(answerOf([{ type: 'tool', name: 'Read', input: {} }])).toBe('');
  });
});

// An Ask discussion's name in the list: its subject, else the start of its first message, else its label.
describe('the subject of an ask discussion', () => {
  const subject = (thread = 'ask') => discussionFor(db, 'APP-1', thread, MODELS).threads.find((one) => one.id === thread);
  const rename = (body: object) =>
    renameThread(db, 'APP-1', new Request('http://localhost/api/card/APP-1/thread', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

  it('carries no subject and no opening before a message, then the first line of the first message', () => {
    expect(subject()).toMatchObject({ subject: null, opening: null, label: 'Ask' });

    addMessage(db, 'APP-1', 'ask', 'person', '\n  Where does   the list\ncome from?', null);
    addMessage(db, 'APP-1', 'ask', 'agent', 'From one file.', null);

    expect(subject()).toMatchObject({ subject: null, opening: 'Where does the list' });
  });

  it('carries the stored subject on an ask discussion only', () => {
    ran('plan', 's-2');
    addMessage(db, 'APP-1', 'plan', 'person', 'go on', null);
    addMessage(db, 'APP-1', 'ask', 'person', 'Where does the list come from?', null);
    saveSubject(db, 'APP-1', 'ask', 'Where the list comes from', false);

    expect(subject()).toMatchObject({ subject: 'Where the list comes from', opening: 'Where does the list come from?' });
    expect(subject('plan')).toMatchObject({ subject: null, opening: null });
  });

  // The pass writes once and never over a name; a person's name always wins.
  it('never lets the pass write over a name, and lets a person rename it', () => {
    saveSubject(db, 'APP-1', 'ask', 'First pass', false);
    saveSubject(db, 'APP-1', 'ask', 'Second pass', false);
    expect(db.prepare('SELECT subject, by_person AS byPerson FROM thread_subjects').get()).toEqual({ subject: 'First pass', byPerson: 0 });

    saveSubject(db, 'APP-1', 'ask', 'My name', true);
    saveSubject(db, 'APP-1', 'ask', 'Late pass', false);
    expect(db.prepare('SELECT subject, by_person AS byPerson FROM thread_subjects').get()).toEqual({ subject: 'My name', byPerson: 1 });
  });

  // A failed first try wrote an agent message too, and still the next answer gets a subject. One pass
  // per discussion, a failed one included.
  it('wants a subject while an ask discussion has none and no subject pass ran for it', () => {
    addMessage(db, 'APP-1', 'ask', 'person', 'q', null);
    addMessage(db, 'APP-1', 'ask', 'agent', 'The run failed before it answered.', null);
    expect(wantsSubject(db, 'APP-1', 'ask')).toBe(true);
    expect(wantsSubject(db, 'APP-1', 'plan')).toBe(false);
    startRun(db, { cardKey: 'APP-1', phase: 'thread-title', engine: 'claude-code', model: 'sonnet', effort: 'low', sessionId: null, logPath: '', lane: null, thread: 'ask' });
    expect(wantsSubject(db, 'APP-1', 'ask')).toBe(false);
    expect(wantsSubject(db, 'APP-1', 'ask-2')).toBe(true);
    saveSubject(db, 'APP-1', 'ask-2', 'Named', true);
    expect(wantsSubject(db, 'APP-1', 'ask-2')).toBe(false);
  });

  it('renames an ask discussion that holds a message, and refuses the rest with a sentence', async () => {
    addMessage(db, 'APP-1', 'ask', 'person', 'q', null);

    const done = await rename({ thread: 'ask', subject: '  Search   plan ' });
    expect(done.status).toBe(200);
    expect(subject()).toMatchObject({ subject: 'Search plan' });
    expect(db.prepare('SELECT by_person AS byPerson FROM thread_subjects').get()).toEqual({ byPerson: 1 });

    expect(await (await rename({ thread: 'plan', subject: 'x' })).json()).toEqual({ message: 'plan is not an Ask discussion, so it has no name to change.' });
    expect((await rename({ thread: 'ask', subject: '   ' })).status).toBe(400);
    expect((await rename({ thread: 'ask', subject: 'x'.repeat(81) })).status).toBe(400);
    expect((await rename({ thread: 'ask-2', subject: 'x' })).status).toBe(404);
  });
});

describe('cleanSubject', () => {
  it.each([
    ['Where the list comes from', 'Where the list comes from'],
    ['"Where the list comes from."', 'Where the list comes from'],
    ['Subject: Search by title\n\nMore words', 'Search by title'],
    ['## Search by title', 'Search by title'],
    ['\u201cSearch by title\u201d', 'Search by title'],
    ['   ', null],
    ['""', null],
  ])('reads %j as %j', (answer, subject) => {
    expect(cleanSubject(answer)).toBe(subject);
  });

  it('cuts a long line with an ellipsis', () => {
    expect(oneLine('a'.repeat(100))).toHaveLength(80);
    expect(oneLine('a'.repeat(100))?.endsWith('…')).toBe(true);
  });
});
