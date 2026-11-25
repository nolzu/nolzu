import type { DatabaseSync } from 'node:sqlite';
import { gateFile, gateOf, type OutputCheck } from '@nolzu/core';
import { NOT_A_PASS, outputCheckOf } from '@nolzu/core/node';
import { readCardFile } from '@nolzu/runner';
import { addMessage } from './discussion.ts';
import { cardFolder } from './files.ts';

// The gate of a card: the review block of the phase that ran last, its questions marked `blocks: yes`,
// and what the output check found on that run. The Overview draws it and a forward move reads it.

export interface GateQuestion {
  id: string;
  question: string;
  // The default the next phase builds on, or null when the line names none.
  answer: string | null;
  // The person's choice as it was stored, or null while it waits on one.
  settled: string | null;
}

export interface CardGate {
  runId: number;
  phase: string;
  // The main file in the card folder, or null for a phase with no review block heading.
  file: string | null;
  lines: string[] | null;
  questions: GateQuestion[];
  check: OutputCheck | null;
}

// A choice is a person's message on the phase's thread, tied to the run that wrote the file, which
// starts with the question's id. One typed in the Discussion in that shape counts too.
const choiceFor = (bodies: readonly string[], id: string) => bodies.find((body) => new RegExp(`^${id}\\s*:`, 'i').test(body.trim())) ?? null;

/**
 * The gate of the card's newest run, once that run has ended. Null while it runs, for a card with no
 * run, and when there is neither a main file nor a check problem to show. A file in the shape from
 * before the review block gives no lines and no questions.
 */
export function gateFor(db: DatabaseSync, key: string, env: Record<string, string | undefined> = process.env): CardGate | null {
  const run = db.prepare(`SELECT id, phase, ended_at FROM runs WHERE card_key = ? AND ${NOT_A_PASS} ORDER BY id DESC LIMIT 1`).get(key) as
    | { id: number; phase: string; ended_at: string | null }
    | undefined;
  if (run === undefined || run.ended_at === null) return null;
  const file = gateFile(run.phase);
  const folder = file === null ? null : cardFolder(db, key, env);
  const read = folder === null || file === null ? null : readCardFile(folder, file);
  const gate = gateOf(run.phase, read?.ok === true ? read.bytes.toString('utf8') : '');
  const check = outputCheckOf(db, run.id);
  // A phase with no review block, such as Research or a PR review, shows only what its check found.
  if (read?.ok !== true && (check?.problems.length ?? 0) === 0) return null;
  const bodies = (db.prepare("SELECT body FROM messages WHERE card_key = ? AND author = 'person' AND run_id = ? ORDER BY id").all(key, run.id) as { body: string }[]).map((one) => one.body);
  return {
    runId: run.id,
    phase: run.phase,
    file: read?.ok === true ? file : null,
    lines: gate.lines,
    questions: gate.blocking.map((one) => ({ id: one.id, question: one.question, answer: one.answer, settled: choiceFor(bodies, one.id) })),
    check,
  };
}

/**
 * Why a move that starts `next` waits, or null when nothing blocks it. A move that runs the same phase
 * again is how a person disagrees with it, so it passes. It never blocks for good: one press on the
 * Overview settles each question.
 */
export function waitsOn(db: DatabaseSync, key: string, next: string, env: Record<string, string | undefined> = process.env): string | null {
  const gate = gateFor(db, key, env);
  const open = gate === null || gate.phase === next ? [] : gate.questions.filter((one) => one.settled === null);
  const [first] = open;
  if (first === undefined) return null;
  if (open.length === 1) {
    return `${key} waits on the open question ${first.id}, "${first.question}", which the next phase builds on. Open the card, take the default or answer it, then move it again.`;
  }
  return `${key} waits on ${open.length} open questions (${open.map((one) => one.id).join(', ')}), which the next phase builds on. Open the card, take the default or answer each one, then move it again.`;
}

// Long enough for a reasoned answer, short enough that the prompt block that carries it stays small.
export const CHOICE_LIMIT = 2000;

const answer = (status: number, body: object): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The person's choice on a blocking question: `{ id }` takes the default, `{ id, answer }` answers it.
 * Stored as their message on the phase's thread, so the Discussion shows it and the next run's prompt
 * carries it with the person's other words.
 */
export async function settleQuestion(db: DatabaseSync, key: string, request: Request, env: Record<string, string | undefined> = process.env): Promise<Response> {
  let asked: { id?: unknown; answer?: unknown };
  try {
    asked = (await request.json()) as { id?: unknown; answer?: unknown };
  } catch {
    asked = {};
  }
  if (typeof asked.id !== 'string' || (asked.answer !== undefined && typeof asked.answer !== 'string')) {
    return answer(400, { message: 'A choice needs the id of the question, and an answer when it does not take the default.' });
  }
  const gate = gateFor(db, key, env);
  const question = gate?.questions.find((one) => one.id === asked.id);
  if (gate == null || question === undefined) return answer(404, { message: `${key} has no open question ${asked.id} that waits on a choice.` });
  const typed = typeof asked.answer === 'string' ? asked.answer.trim() : null;
  if (typed === '') return answer(400, { message: `Write the answer to ${question.id}, or take the default.` });
  if (typed !== null && typed.length > CHOICE_LIMIT) return answer(400, { message: `The answer is over ${CHOICE_LIMIT} characters. Put the long part in the Discussion.` });
  if (typed === null && question.answer === null) return answer(400, { message: `${question.id} names no default, so write an answer.` });
  const said = typed === null ? `I take the default: ${question.answer}.` : `My answer: ${typed}`;
  addMessage(db, key, gate.phase, 'person', `${question.id}: ${question.question} ${said}`, gate.runId);
  return answer(200, { ok: true });
}
