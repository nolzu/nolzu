import type { QaInput } from '@nolzu/ui/qa';
import type { StackStatus } from './qa-panel.ts';
import type { Settled } from './held-answer.svelte.ts';

/**
 * The QA panels' input with the status command's answer. While the command runs the panel draws a
 * grey line, and a part that failed says why there, where a command that could not run does.
 */
export function withStatus(input: QaInput, said: Settled<StackStatus> | null): QaInput {
  if (said === null) return input.hasStatus ? { ...input, statusPending: true } : input;
  return { ...input, ...(said.ok ? said.value : { status: null, statusProblem: said.message }) };
}

/**
 * Rows drawn off the database, with the fields a slow read added merged in by id. The rows stay the
 * ones this load read, so a row the person just added shows at once and a stale answer never brings
 * back a row that is gone.
 */
export function mergeById<T extends { id: number }, K extends keyof T>(rows: readonly T[], said: Settled<readonly T[]> | null, fields: readonly K[]): T[] {
  if (said === null || !said.ok) return [...rows];
  const read = new Map(said.value.map((one) => [one.id, one]));
  return rows.map((row) => {
    const one = read.get(row.id);
    if (one === undefined) return row;
    const added: Partial<T> = {};
    for (const field of fields) added[field] = one[field];
    return { ...row, ...added };
  });
}
