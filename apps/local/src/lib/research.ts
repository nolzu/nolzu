import type { DatabaseSync } from 'node:sqlite';
import { type DeliveryPhase, isResearchKind, RESEARCH_REPORTS, type ResearchKind } from '@nolzu/protocol';
import { createCardFrom } from './create-card.ts';
import { cardFolder } from './files.ts';
import type { Loop } from './loop.ts';
import { CONTEXT_LIMIT } from './overview.ts';
import { readCardText } from '@nolzu/runner';

// The server half of a Research card's presses on its card page. Each kind keeps its
// own phase and the file its skill writes.
export const RESEARCH_RUNS = {
  questions: { phase: 'research', report: RESEARCH_REPORTS.questions },
  investigations: { phase: 'investigate', report: RESEARCH_REPORTS.investigations },
} as const satisfies Record<ResearchKind, { phase: DeliveryPhase; report: string }>;

/**
 * The answer or the report of a Research card as its skill wrote it, or null when the file is not
 * there, and the plain summary of the newest finished run of the card's own phase.
 */
export function researchAnswer(db: DatabaseSync, key: string, kind: ResearchKind, env: Record<string, string | undefined> = process.env): { report: string | null; summary: string | null } {
  const { phase, report } = RESEARCH_RUNS[kind];
  const run = db.prepare("SELECT plain_summary FROM runs WHERE card_key = ? AND phase = ? AND state = 'complete' ORDER BY id DESC LIMIT 1").get(key, phase) as { plain_summary: string | null } | undefined;
  const folder = cardFolder(db, key, env);
  return { report: folder === null ? null : readCardText(folder, report), summary: run?.plain_summary ?? null };
}

const card = (db: DatabaseSync, key: string) => db.prepare('SELECT key, board, title FROM cards WHERE key = ?').get(key) as { key: string; board: string; title: string } | undefined;

/**
 * Make a Delivery card: a new local card in Delivery's Inbox, titled as the research card and linked to
 * it, so each card's page links the other. The answer goes along as extra context for Refine, unless it
 * is over the limit, when the plain summary goes instead.
 */
export async function deliveryCardFrom(db: DatabaseSync, key: string, env: Record<string, string | undefined> = process.env): Promise<{ key: string }> {
  const asked = card(db, key)!;
  const done = isResearchKind(asked.board) ? researchAnswer(db, key, asked.board, env) : null;
  const report = done?.report?.trim() ?? '';
  const extra = report !== '' && Buffer.byteLength(report, 'utf8') <= CONTEXT_LIMIT ? report : (done?.summary ?? undefined);
  const made = await createCardFrom(db, {}, { input: '', title: asked.title, description: `Made from ${key} on Research.`, extra, links: [key], board: 'delivery' });
  return { key: made.key };
}

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * POST /api/card/[key]/research: Make a Delivery card, `{ action: 'deliver' }`, 201 with the new key.
 * A follow-up is a message on the card's Discussion tab, and the wrap-up is the board's own Wrap-up
 * column. A refusal is a sentence with a 4xx, and nothing is written.
 */
export async function researchAction(live: Loop, key: string, request: Request, env: Record<string, string | undefined> = process.env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const found = card(live.db, key);
  if (found === undefined) return answer(404, { message: `There is no card ${key}.` });
  if (!isResearchKind(found.board)) return answer(409, { message: `${key} is not on Research, so this press does not apply to it.` });
  switch (body?.action) {
    case 'deliver': {
      try {
        const made = await deliveryCardFrom(live.db, key, env);
        live.changed();
        return answer(201, made);
      } catch (error) {
        return answer(409, { message: (error as Error).message });
      }
    }
    default:
      return answer(400, { message: 'The one Research press here is deliver. Ask a follow-up on the Discussion tab of the card.' });
  }
}
