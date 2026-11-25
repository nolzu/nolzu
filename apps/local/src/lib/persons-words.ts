import type { DatabaseSync } from 'node:sqlite';
import { ASK_THREAD, isAskThread, isFeedbackRef } from '@nolzu/core';
import { NOT_A_PASS } from '@nolzu/core/node';
import type { Stage } from '@nolzu/protocol';
import type { PersonsWords, PromptInput } from '@nolzu/runner';

/**
 * What the person said on a card, for the prompt of a fresh run: each question a run asked with the
 * answer, the line typed on a move (Accept anyway, a Send back note) and their own Discussion messages.
 *
 * An answer is stored as two messages on the run that asked, the question and then the person's reply
 * (`answer` in `loop.ts`), so a person's message right after its run's question is that answer and
 * not a Discussion message. A question with no such pair, asked before answers were stored or never
 * answered, has a null answer.
 */
export function personsWords(db: DatabaseSync, key: string, stages: readonly Stage[]): Pick<PersonsWords, 'questions' | 'moves' | 'messages'> {
  const asked = db.prepare("SELECT id, phase, question FROM runs WHERE card_key = ? AND trim(coalesce(question, '')) != '' ORDER BY id").all(key) as unknown as {
    id: number;
    phase: string;
    question: string;
  }[];
  const all = db.prepare('SELECT thread, author, body, run_id AS runId FROM messages WHERE card_key = ? ORDER BY id').all(key) as unknown as {
    thread: string;
    author: string;
    body: string;
    runId: number | null;
  }[];

  const answers = new Map<number, string>();
  const messages: { thread: string; text: string }[] = [];
  all.forEach((message, at) => {
    if (message.author !== 'person') return;
    const before = all.slice(0, at).findLast((one) => one.thread === message.thread);
    const id = message.runId ?? -1;
    const question = asked.find((run) => run.id === id)?.question.trim();
    if (before?.author === 'agent' && before.runId === id && question !== undefined && before.body === question && !answers.has(id)) {
      answers.set(id, message.body);
    } else if (!isFeedbackRef(message.thread)) {
      // Every Ask discussion reads as Ask, not as its id. A pull request comment's discussion is left
      // out: it opens with the reviewer's words, which are not the person's.
      messages.push({ thread: isAskThread(message.thread) ? ASK_THREAD : message.thread, text: message.body });
    }
  });

  const label = (id: string | null): string => stages.find((stage) => stage.id === id)?.label ?? id ?? 'the start';
  const index = (id: string | null): number => stages.findIndex((stage) => stage.id === id);
  const moves = (
    db.prepare("SELECT from_stage AS fromStage, to_stage AS toStage, reason FROM card_events WHERE card_key = ? AND trim(coalesce(reason, '')) != '' ORDER BY id").all(key) as unknown as {
      fromStage: string | null;
      toStage: string;
      reason: string;
    }[]
  ).map((move) => ({ from: label(move.fromStage), to: label(move.toStage), back: index(move.toStage) < index(move.fromStage), reason: move.reason }));

  return {
    questions: asked.map((run) => ({ phase: run.phase, question: run.question, answer: answers.get(run.id) ?? null })),
    moves,
    messages,
  };
}

/**
 * The card's runs before `before`, for the wrap-up, which looks for what cost time: how often each
 * phase ran, in the order the phases first ran, and each QA verdict that was not PASS, oldest first.
 * An Ask run and a pass such as the plain summary move no work, so they are left out.
 */
export function cardHistory(db: DatabaseSync, key: string, before: number): NonNullable<PromptInput['history']> {
  const runs = db.prepare(`SELECT phase, count(*) AS count FROM runs WHERE card_key = ? AND id < ? AND ${NOT_A_PASS} GROUP BY phase ORDER BY min(id)`).all(key, before) as unknown as {
    phase: string;
    count: number;
  }[];
  const verdicts = db
    .prepare("SELECT verdict, verdict_reason AS reason FROM runs WHERE card_key = ? AND id < ? AND verdict IS NOT NULL AND verdict != 'PASS' ORDER BY id")
    .all(key, before) as unknown as { verdict: string; reason: string | null }[];
  return { runs: runs.map(({ phase, count }) => ({ phase, count })), verdicts: verdicts.map(({ verdict, reason }) => ({ verdict, reason })) };
}
