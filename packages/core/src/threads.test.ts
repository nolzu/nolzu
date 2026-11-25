import { describe, expect, it } from 'vitest';
import { ASK_THREAD, askThreads, canSend, isAskThread, isDeliveryPhase, isFeedbackRef, resumeCommand, type RunRow, sendLabel, threadLabel, threadsFor } from './threads.ts';

const run = (id: number, phase: string, sessionId: string | null = `s-${id}`, engine = 'claude-code'): RunRow => ({
  id,
  phase,
  sessionId,
  engine,
});

describe('threadsFor', () => {
  it('gives a card one thread per phase that ran, plus ask', () => {
    const threads = threadsFor([run(2, 'plan'), run(1, 'refine')]);

    expect(threads.map((thread) => thread.id)).toEqual(['plan', 'refine', ASK_THREAD]);
    expect(threads.map((thread) => thread.label)).toEqual(['Plan', 'Refine', 'Ask']);
  });

  // A phase that never ran has no session, so a thread for it would be a box that cannot send.
  it('gives no thread to a phase that never ran', () => {
    expect(threadsFor([run(1, 'refine')]).map((thread) => thread.id)).toEqual(['refine', ASK_THREAD]);
  });

  // The conversation a person is looking at is the newest one. The caller orders newest first.
  it('keeps the newest run of a phase that ran twice', () => {
    const threads = threadsFor([run(3, 'implement', 's-3'), run(2, 'implement', 's-2')]);

    expect(threads.filter((thread) => thread.id === 'implement')).toHaveLength(1);
    expect(threads[0]?.sessionId).toBe('s-3');
    expect(threads[0]?.runId).toBe(3);
  });

  // The summary pass has no stage and nobody talks to it. Its session is not the phase's, so a
  // thread on it would resume the wrong conversation.
  it('makes no thread for the summary pass, the commit message pass or a triage', () => {
    expect(threadsFor([run(4, 'feedback'), run(3, 'commit-message'), run(2, 'extract-summary'), run(1, 'plan')]).map((thread) => thread.id)).toEqual([
      'plan',
      ASK_THREAD,
    ]);
  });

  it('carries the session and the profile the run recorded', () => {
    const [thread] = threadsFor([run(1, 'plan', 's-1', 'codex#work')]);

    expect(thread).toMatchObject({ sessionId: 's-1', engine: 'codex#work', runId: 1 });
  });

  it('adds a thread per review action', () => {
    const threads = threadsFor([run(1, 'implement')], ['F1', 'F2']);

    expect(threads.map((thread) => thread.id)).toEqual(['implement', 'F1', 'F2', ASK_THREAD]);
    expect(threads.find((thread) => thread.id === 'F1')?.kind).toBe('review');
  });

  it('gives an ask thread even to a card that has run nothing', () => {
    expect(threadsFor([]).map((thread) => thread.id)).toEqual([ASK_THREAD]);
  });

  // An Ask run belongs to the ask discussion that started it, so it makes no phase thread of its own,
  // and each discussion goes on in the session its own run kept.
  it('gives each ask discussion the session of its own Ask run, and an Ask run no thread of its own', () => {
    const threads = threadsFor([run(4, 'ask', 's-4'), run(3, 'ask', 's-3'), run(1, 'plan')], [], ['ask-2', ASK_THREAD], { 'ask-2': run(4, 'ask', 's-4'), ask: run(3, 'ask', 's-3', 'codex#work') });

    expect(threads.map((thread) => thread.id)).toEqual(['plan', 'ask-2', ASK_THREAD]);
    expect(threads[1]).toMatchObject({ kind: 'ask', sessionId: 's-4', engine: 'claude-code', runId: 4 });
    expect(threads[2]).toMatchObject({ kind: 'ask', sessionId: 's-3', engine: 'codex#work', runId: 3 });
    expect(threadsFor([], [], ['ask-2'])[0]).toMatchObject({ sessionId: null, engine: null, runId: null });
  });
});

describe('canSend', () => {
  const threads = () => threadsFor([run(1, 'plan', 's-1', 'codex#work'), run(2, 'refine', null)]);

  it('takes a message to a thread whose phase kept a session', () => {
    const answer = canSend(threads(), 'plan', 'try the other index');

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    // The profile the run recorded, not whatever the action table says now. A session lives inside
    // one login, so a resume on another profile would find nothing to continue.
    expect(answer.thread.engine).toBe('codex#work');
    expect(answer.thread.sessionId).toBe('s-1');
  });

  // The three refusals are the three states a person reaches.
  it('refuses a thread that is not on this card', () => {
    const answer = canSend(threads(), 'qa', 'hello');

    expect(answer).toMatchObject({ ok: false });
    if (answer.ok) return;
    expect(answer.reason).toContain('no qa thread');
  });

  it('refuses a thread whose phase kept no session', () => {
    const answer = canSend(threads(), 'refine', 'hello');

    expect(answer).toMatchObject({ ok: false });
    if (answer.ok) return;
    expect(answer.reason).toContain('no session to continue');
  });

  // A review thread is a review action to read and no conversation to continue, so nothing recorded a
  // session for it. Given one, the composer offers to send a message into a session that is not there.
  it('refuses a review thread, which keeps no session of its own', () => {
    const withReview = threadsFor([run(1, 'implement')], ['F1']);
    expect(withReview.find((thread) => thread.id === 'F1')?.sessionId).toBeNull();

    const answer = canSend(withReview, 'F1', 'have another look at the import');

    expect(answer).toMatchObject({ ok: false });
    if (answer.ok) return;
    expect(answer.reason).toContain('no session to continue');
  });

  it('refuses an empty message, and one that is only spaces', () => {
    expect(canSend(threads(), 'plan', '')).toMatchObject({ ok: false });
    expect(canSend(threads(), 'plan', '   \n ')).toMatchObject({ ok: false });
  });

  // An ask discussion with no session yet takes a message, which starts its read-only session.
  it('takes a message in an ask discussion with no session, which starts one', () => {
    expect(canSend(threads(), ASK_THREAD, 'where does the list come from?')).toMatchObject({ ok: true, thread: { kind: 'ask', sessionId: null } });
    // And an empty one is still refused.
    expect(canSend(threads(), ASK_THREAD, '   ')).toMatchObject({ ok: false });
  });

  // Discuss on a PR comment row: a read-only session under its ref, started by the first message and
  // continued in the Ask run that ref already has.
  it('takes a message in a pull request comment thread, which starts or continues its read-only session', () => {
    const fresh = threadsFor([run(1, 'implement')], [], [ASK_THREAD], {}, ['T3']);
    expect(fresh.map((thread) => thread.id)).toEqual(['implement', 'T3', ASK_THREAD]);
    expect(canSend(fresh, 'T3', 'is the reviewer right?')).toMatchObject({ ok: true, thread: { kind: 'feedback', label: 'T3', sessionId: null } });
    expect(sendLabel(fresh[1]!)).toBe('Starts a read-only session about T3 that reads the card and its code.');

    const going = threadsFor([run(1, 'implement')], [], [ASK_THREAD], { T3: { id: 7, phase: 'ask', sessionId: 's-9', engine: 'claude' } }, ['T3']);
    expect(going[1]).toMatchObject({ id: 'T3', kind: 'feedback', sessionId: 's-9', runId: 7 });
  });

  it('hands back the phase thread a message continues', () => {
    expect(canSend(threads(), 'plan', 'go on')).toMatchObject({ ok: true, thread: { id: 'plan', sessionId: 's-1' } });
  });
});

describe('sendLabel', () => {
  it('names the session and the profile a message would continue', () => {
    const [thread] = threadsFor([run(1, 'plan', 's-1', 'codex#work')]);

    expect(sendLabel(thread!)).toContain('s-1');
    expect(sendLabel(thread!)).toContain('codex#work');
  });

  it('says a new ask discussion starts a read-only session', () => {
    const threads = threadsFor([]);

    expect(sendLabel(threads[0]!)).toMatch(/starts a read-only session/i);
  });

  it('says so when a phase thread has nothing to continue', () => {
    const [refine] = threadsFor([run(1, 'refine', null)]);

    expect(sendLabel(refine!)).toContain('no session');
  });
});

it('labels a thread in the words the tab shows', () => {
  expect(threadLabel('wrapup')).toBe('Wrap-up');
  expect(threadLabel(ASK_THREAD)).toBe('Ask');
  // A review ref is its own label, and a phase this version does not know reads as itself.
  expect(threadLabel('F1')).toBe('F1');
});

/**
 * The threads of the phases the other four boards run.
 *
 * The label comes off the protocol's one map now, so a phase named by a stage gets its own words
 * here with no second table to remember. Before this the label was a private list of five, and a
 * PR review thread was headed `pr-review`.
 */
it('labels a thread of a phase no Delivery board has', () => {
  expect(threadLabel('pr-review')).toBe('PR review');
  expect(threadLabel('investigate')).toBe('Investigate');
  expect(threadLabel('architecture')).toBe('Architecture');
});

/**
 * Whether a phase starts a run, which is what both callers of this ask.
 *
 * A false here is a thread the composer refuses and a phase summary dropped in silence, so the five
 * phases the other boards run have to answer true. `extract-summary` is the contrast: it is a pass
 * with a row on the model table and no stage, and nobody talks to it.
 */
it('counts every phase a stage can start, and no pass', () => {
  for (const phase of ['refine', 'plan', 'implement', 'qa', 'wrapup', 'architecture', 'design', 'investigate', 'research', 'pr-review']) {
    expect(isDeliveryPhase(phase), phase).toBe(true);
  }
  for (const other of ['extract-summary', 'optimize', 'assess', ASK_THREAD, 'F1']) {
    expect(isDeliveryPhase(other), other).toBe(false);
  }
});

/**
 * A card keeps more than one ask discussion.
 *
 * `ask` is the first, so a card written before this keeps its notes. A new one is `ask-<n>`, one past
 * the highest stored, and it exists once a message is in it.
 */
describe('askThreads', () => {
  it('always has the first discussion, even on a card with no message', () => {
    expect(askThreads([], null)).toEqual({ ids: [ASK_THREAD], next: 'ask-2' });
  });

  it('lists the stored discussions newest first, and offers one past the highest', () => {
    expect(askThreads(['ask', 'ask-3', 'plan', 'ask-2', 'F1'], null)).toEqual({ ids: ['ask-3', 'ask-2', ASK_THREAD], next: 'ask-4' });
  });

  // The new one is listed while it is open, so the sidebar can mark it before anything is written.
  it('lists the next discussion while the URL opens it, and no other unknown one', () => {
    expect(askThreads(['ask'], 'ask-2').ids).toEqual(['ask-2', ASK_THREAD]);
    expect(askThreads(['ask'], 'ask-9').ids).toEqual([ASK_THREAD]);
  });

  it('knows an ask id from every other thread id', () => {
    for (const id of ['ask', 'ask-2', 'ask-10']) expect(isAskThread(id), id).toBe(true);
    for (const id of ['ask-1', 'ask-0', 'ask-02', 'ask-', 'asked', 'plan', 'F1']) expect(isAskThread(id), id).toBe(false);
    for (const id of ['T1', 'T12']) expect(isFeedbackRef(id), id).toBe(true);
    for (const id of ['T0', 'T01', 't1', 'T', 'F1', 'ask']) expect(isFeedbackRef(id), id).toBe(false);
  });
});

describe('threadsFor with several ask discussions', () => {
  it('gives each discussion its own thread, newest first, after the phases', () => {
    const threads = threadsFor([run(1, 'plan')], [], ['ask-2', ASK_THREAD]);

    expect(threads.map((thread) => [thread.id, thread.kind, thread.label])).toEqual([
      ['plan', 'phase', 'Plan'],
      ['ask-2', 'ask', 'Ask 2'],
      [ASK_THREAD, 'ask', 'Ask'],
    ]);
  });

  // Each one is a session of its own, so the second one takes a message as the first does.
  it('takes a message in a later discussion as well', () => {
    const threads = threadsFor([], [], ['ask-2', ASK_THREAD]);

    expect(canSend(threads, 'ask-2', 'a second question')).toMatchObject({ ok: true, thread: { id: 'ask-2', kind: 'ask' } });
  });
});

/**
 * The command that continues a phase's session in a terminal.
 *
 * Each flag was read off the vendor's own help: `claude --resume`, `codex resume` and `cursor-agent
 * --resume`. The folder is the one the run started in, because Claude Code
 * files a session under it.
 */
describe('resumeCommand', () => {
  const folder = '/home/dev/recipes/worktrees/APP-1';

  it('names the folder, the engine resume flag and the session', () => {
    expect(resumeCommand({ vendor: 'claude-code', sessionId: 's-1', folder, configDir: null })).toBe(
      "cd '/home/dev/recipes/worktrees/APP-1' && claude --resume 's-1'",
    );
    expect(resumeCommand({ vendor: 'codex', sessionId: 's-1', folder, configDir: null })).toBe(
      "cd '/home/dev/recipes/worktrees/APP-1' && codex resume 's-1'",
    );
    expect(resumeCommand({ vendor: 'cursor', sessionId: 's-1', folder, configDir: null })).toBe(
      "cd '/home/dev/recipes/worktrees/APP-1' && cursor-agent --resume 's-1'",
    );
  });

  // A session lives inside one login, so a profile with its own folder has to be named, or the
  // engine looks in its default folder and finds nothing.
  it('sets the profile config folder when the profile has one', () => {
    expect(resumeCommand({ vendor: 'codex', sessionId: 's-1', folder, configDir: '/home/dev/.codex-work' })).toBe(
      "cd '/home/dev/recipes/worktrees/APP-1' && CODEX_HOME='/home/dev/.codex-work' codex resume 's-1'",
    );
  });


});
