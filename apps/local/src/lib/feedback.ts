import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { goneText, isFeedbackRef, type ModelsByVendor, resolveModels } from '@nolzu/core';
import { applyTriage, cardBase, cardDiscussions, cardModels, cardPreset, cardPullRows, projectProfiles, type StoredCardPull, type StoredDiscussion } from '@nolzu/core/node';
import { type Estimate, missingProfileText, parseTriage } from '@nolzu/protocol';
import { readCardText, removeCardFile, writeCardFile } from '@nolzu/runner';
import { addMessage, messagesIn } from './discussion.ts';
import { cardFolder } from './files.ts';
import { measured } from './project-models.ts';

/**
 * The files of a triage run (`feedback`). Nolzu reads GitHub itself, so the run needs no GitHub
 * access: the comments go into the card folder before the run starts, the way the review diff
 * does, and the verdicts come back as a file the loop applies when the run ends. Comment text
 * stays on this machine: these files sit in the card folder, and nothing here reaches the snapshot
 * or the hub.
 */

export const DISCUSSIONS_FILE = join('feedback', 'discussions.md');
export const TRIAGE_FILE = join('feedback', 'triage.md');
// What a Fix all run wrote about each comment, one line per ref.
export const FIXES_FILE = join('feedback', 'fixes.md');

// How much message text one discussion keeps. A bot thread can run to pages, and the newest messages
// are the ones a verdict turns on, so the oldest go first.
export const THREAD_BUDGET = 8000;
// How much of the plan or brief goes in for context. The run can read the whole file in the folder.
export const CONTEXT_BUDGET = 6000;
// The first of these the card has is its context: what the change was meant to do.
const CONTEXT_FILES = [join('plan', 'plan.md'), join('refine', 'refined.md'), join('implement', 'pr.md')];

export const isOpen = (row: Pick<StoredDiscussion, 'status'>): boolean => row.status !== 'done';

// The messages a discussion keeps: the newest ones that fit the budget, and always the newest.
export function keptMessages<M extends { body: string }>(messages: readonly M[], budget = THREAD_BUDGET): { kept: M[]; cut: number } {
  let used = 0;
  let from = messages.length;
  while (from > 0) {
    const size = messages[from - 1]?.body.length ?? 0;
    if (from < messages.length && used + size > budget) break;
    used += size;
    from -= 1;
  }
  return { kept: messages.slice(from), cut: from };
}

const quoted = (body: string): string =>
  body
    .trim()
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');

/** The comments file itself, from the card's open discussions, its pull requests and its context. */
export function discussionsFile(input: { key: string; title: string; context: { file: string; text: string } | null; pulls: readonly StoredCardPull[]; discussions: readonly StoredDiscussion[] }): string {
  const parts = [`# Open discussions on ${input.key}: ${input.title}`];
  if (input.context === null) parts.push('The card has no plan or brief in its folder, so judge each comment against the code alone.');
  else {
    const text = input.context.text.trim();
    const cut = text.length > CONTEXT_BUDGET;
    parts.push(`## What the change is for\n\nFrom ${input.context.file}${cut ? `, its first ${CONTEXT_BUDGET} characters` : ''}:\n\n${quoted(cut ? text.slice(0, CONTEXT_BUDGET) : text)}`);
  }
  for (const row of input.discussions.filter(isOpen)) {
    const pull = input.pulls.find((one) => one.id === row.pull);
    const where = row.path === null ? '' : ` on ${row.path}${row.line === null ? '' : `:${row.line}`}`;
    const kind = row.kind === 'thread' ? 'review thread' : row.kind === 'review' ? "review's own text" : 'comment';
    const facts = [
      `Kind: ${kind}${where}`,
      ...(pull === undefined ? [] : [`Pull request: ${pull.repo}#${pull.number}`]),
      `Status: ${row.status}`,
      ...(row.outdated ? ['Outdated: the line has changed since the comment.'] : []),
      ...(row.verdict === null ? [] : [`Earlier verdict: ${row.verdict}`]),
      ...(row.summary === null ? [] : [`Earlier summary: ${row.summary}`]),
      ...(row.reason === null ? [] : [`Earlier reason: ${row.reason}`]),
      ...(row.fixNote === null ? [] : [`Fix note: ${row.fixNote}`]),
    ];
    const { kept, cut } = keptMessages(row.messages);
    const messages = kept.map((one) => `${one.author ?? 'Deleted account'}${one.mine ? " (the person's own)" : ''}, ${one.createdAt}:\n${quoted(one.body)}`);
    const said = cut === 0 ? [] : [`${cut} older ${cut === 1 ? 'message was' : 'messages were'} cut to keep this file short. The newest ${kept.length} follow.`];
    parts.push([`## ${row.ref}`, facts.join('\n'), ...said, ...messages].join('\n\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

// One discussion as a Fix, Fix all, Discuss or QA the fixes hands it on: where it is, every message
// whole with its author and time, what the newest triage said, and why the last fix did not hold.
export function discussionBlock(row: StoredDiscussion, pull: Pick<StoredCardPull, 'repo' | 'number'> | undefined): string {
  const where = row.path === null ? '' : `, on ${row.path}${row.line === null ? '' : `:${row.line}`}`;
  const kind = row.kind === 'thread' ? 'A review thread' : row.kind === 'review' ? "A review's own text" : 'A comment';
  const facts = [
    `${row.ref}: ${kind}${pull === undefined ? '' : ` on ${pull.repo}#${pull.number}`}${where}.`,
    ...(row.outdated ? ['The line has changed since the comment, so look for the code it was about.'] : []),
    ...(row.verdict === null ? [] : [`Triage verdict: ${row.verdict}`]),
    ...(row.summary === null ? [] : [`Triage summary: ${row.summary}`]),
    ...(row.reason === null ? [] : [`Triage reason: ${row.reason}`]),
    ...(row.fixNote === null ? [] : [`An earlier fix said: ${row.fixNote}`]),
    ...(row.fixFailed === null ? [] : [`Why the last fix did not hold: ${row.fixFailed}`]),
  ];
  const messages = row.messages.map((one) => `${one.author ?? 'Deleted account'}${one.mine ? " (the person's own)" : ''}, ${one.createdAt}:\n${quoted(one.body)}`);
  return [facts.join('\n'), ...messages].join('\n\n');
}

/**
 * What a Fix tells the card's Implement session: the discussion with every message and its triage, to
 * change the code for it, and the three things a fix never does. The comment text stays on this
 * machine: it goes to the local engine as the run's message and nowhere else.
 */
export function fixFeedbackMessage(row: StoredDiscussion, pull: Pick<StoredCardPull, 'repo' | 'number'> | undefined): string {
  return [
    `A reviewer left this on the pull request of your change. Change the code so it answers it. If you find the reviewer is wrong, change nothing and say why in your summary.`,
    discussionBlock(row, pull),
    'Do not commit, do not push and do not reply on GitHub. The person reads your change on the Changes tab, commits and pushes it, and answers the reviewer. Then finish the way the implement skill says.',
  ].join('\n\n');
}

/**
 * What Fix all tells the card's Implement session: every discussion triage wants fixed, to change the
 * code for each, and the file that says what happened to each one, because one plain summary cannot
 * be split across several rows.
 */
export function fixAllMessage(rows: readonly StoredDiscussion[], pulls: readonly Pick<StoredCardPull, 'id' | 'repo' | 'number'>[]): string {
  const example = rows[0]?.ref ?? 'T1';
  return [
    `Reviewers left these ${rows.length === 1 ? 'comment' : `${rows.length} comments`} on the pull request of your change. Change the code so it answers each of them. If you find a reviewer is wrong, change nothing for that comment and say why on its line in the file below.`,
    ...rows.map((row) => discussionBlock(row, pulls.find((one) => one.id === row.pull))),
    `When you are done, write \`<card folder>/feedback/fixes.md\` with one line per comment and nothing else: its ref, a colon, and what you changed or why you changed nothing, such as \`${example}: The search lower-cases both sides now.\``,
    'Do not commit, do not push and do not reply on GitHub. The person reads your change on the Changes tab, commits and pushes it, and answers the reviewers. Then finish the way the implement skill says.',
  ].join('\n\n');
}

/**
 * The notes of a Fix all run by ref, from the file it wrote, or null when it wrote none. A line that
 * is no `T<n>: note` is skipped, and the first line of a ref wins.
 */
export function readFixNotes(taskDir: string): Map<string, string> | null {
  const text = readCardText(taskDir, FIXES_FILE);
  if (text === null) return null;
  const notes = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const found = /^\s*(?:[-*]\s+)?`?(T\d+)`?\s*:\s*(.*\S)\s*$/.exec(line);
    if (found !== null && !notes.has(found[1] ?? '')) notes.set(found[1] ?? '', found[2] ?? '');
  }
  return notes;
}

/**
 * The first message of a Discuss thread: the discussion and its triage, so the read-only session the
 * person's first question starts knows what it is about. Nothing it answers changes the row.
 */
export function discussMessage(row: StoredDiscussion, pull: Pick<StoredCardPull, 'repo' | 'number'> | undefined): string {
  return [`I want to talk about this comment on the pull request. Read the code it is about. Change nothing.`, discussionBlock(row, pull)].join('\n\n');
}

/**
 * Discuss on a row of the PRs tab: the thread under its ref, opened with `discussMessage` the first
 * time and left as it is after that. No run starts here; the person's first message starts the
 * read-only session, as in an Ask discussion. Answers the thread, or the sentence it was refused with.
 */
export function openDiscussion(db: DatabaseSync, key: string, ref: string): { ok: true; thread: string } | { ok: false; reason: string } {
  const row = isFeedbackRef(ref) ? cardDiscussions(db, key).find((one) => one.ref === ref) : undefined;
  if (row === undefined) return { ok: false, reason: `${key} has no comment ${ref}. Read the comments again.` };
  if (messagesIn(db, key, ref).length === 0) addMessage(db, key, ref, 'person', discussMessage(row, cardPullRows(db, key).find((one) => one.id === row.pull)), null);
  return { ok: true, thread: ref };
}

/**
 * Writes the comments file into the card folder before a triage run and takes away the triage file
 * an earlier run left, so a run that writes none applies nothing old. Answers how many discussions
 * went in, and throws when there are none, so no engine starts on an empty file.
 */
export function writeFeedbackFile(db: DatabaseSync, key: string, title: string, taskDir: string): number {
  const discussions = cardDiscussions(db, key);
  const open = discussions.filter(isOpen).length;
  if (open === 0) throw new Error(`${key} has no open discussion to triage. Read comments on its PRs tab first, or reopen one.`);
  // Read, removed and written inside the card folder only, never through a link a run left there.
  const texts = CONTEXT_FILES.map((file) => ({ file, text: readCardText(taskDir, file) }));
  const found = texts.find((one) => one.text !== null);
  const context = found === undefined ? null : { file: found.file, text: found.text ?? '' };
  removeCardFile(taskDir, TRIAGE_FILE);
  writeCardFile(taskDir, DISCUSSIONS_FILE, discussionsFile({ key, title, context, pulls: cardPullRows(db, key), discussions }));
  return open;
}

/**
 * Applies the triage file in the card folder to the card's rows, or answers why it did not. The file
 * is taken whole or not at all, so a refusal changes no row.
 */
export function applyTriageFile(db: DatabaseSync, key: string, taskDir: string): { ok: true; applied: number; ignored: number } | { ok: false; problem: string } {
  const text = readCardText(taskDir, TRIAGE_FILE);
  if (text === null) return { ok: false, problem: 'The triage run wrote no triage.md, so no row has a verdict from it.' };
  const read = parseTriage(text);
  if (!read.ok) return read;
  return { ok: true, ...applyTriage(db, key, read.blocks) };
}

/** The sentence the PRs tab shows when the triage file in the card folder does not parse, or null. */
export function triageProblem(taskDir: string): string | null {
  const text = readCardText(taskDir, TRIAGE_FILE);
  if (text === null) return null;
  const read = parseTriage(text);
  // A file edited by hand after a good triage is refused too, and the rows still show what that
  // triage gave them, so the sentence says the rows kept their verdicts and not that none applied.
  return read.ok ? null : `${read.problem} Each row keeps the verdict it had before.`;
}

export interface TriageOffer {
  // What the run starts on, which the tab draws as every other start is drawn, "Claude Code · haiku · low".
  starts: { engine: string; model: string; effort: string; severalProfiles?: boolean };
  // What earlier triage runs on that model cost, or nothing before one was measured.
  estimate: Estimate | undefined;
  // Why a run would be refused now, such as a login this machine does not hold, or null.
  refusal: string | null;
  // The sentence for a triage file in the card folder that does not parse, or null.
  problem: string | null;
}

/** What the Run triage button on the PRs tab says before the press: the model, the cost and any refusal. */
export function triageOfferFor(db: DatabaseSync, key: string, models: ModelsByVendor): TriageOffer {
  const profiles = projectProfiles(db);
  const row = resolveModels(cardModels(db, key), cardBase(db, key), cardPreset(db, key), models, profiles).feedback;
  const refusal = row.missingProfile ? missingProfileText(row.engine) : (row.refusal ?? (row.gone ? goneText(row.model) : null));
  const folder = cardFolder(db, key);
  // A run that has not ended may still be writing the file, and half a file is no refusal yet.
  const state = (db.prepare('SELECT state FROM cards WHERE key = ?').get(key) as { state: string } | undefined)?.state;
  const ended = state !== 'queued' && state !== 'running' && state !== 'blocked';
  const starts = { engine: row.engine, model: row.model, effort: row.effort, ...(profiles.length > 1 ? { severalProfiles: true } : {}) };
  return { starts, estimate: measured(db, 'feedback', row, profiles), refusal, problem: folder === null || !ended ? null : triageProblem(folder) };
}
