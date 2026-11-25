import type { QaInput } from '@nolzu/ui/qa';
import { expect, it } from 'vitest';
import { mergeById, withStatus } from './stream-merge.ts';

// Only the fields `withStatus` reads or writes. The rest of the panels pass through untouched.
const input = (hasStatus: boolean) => ({ cardKey: 'APP-1', hasStatus, status: null, statusProblem: null }) as unknown as QaInput;
const status = { command: 'docker compose ps', code: 0, output: 'api  running', timedOut: false };

it('marks the status as on its way until the command answers, then shows its answer', () => {
  expect(withStatus(input(true), null)).toMatchObject({ statusPending: true, statusProblem: null });
  expect(withStatus(input(false), null).statusPending).toBeUndefined();
  expect(withStatus(input(true), { ok: true, value: { status, statusProblem: null } })).toMatchObject({ status, statusProblem: null, cardKey: 'APP-1' });
});

it('puts a failed status read in the status line', () => {
  expect(withStatus(input(true), { ok: false, message: 'Internal Error' })).toMatchObject({ status: null, statusProblem: 'Internal Error' });
});

it('merges the slow fields in by id and keeps the rows this load read', () => {
  const rows = [
    { id: 1, path: 'a.md', diff: null as string | null },
    { id: 3, path: 'new.md', diff: null as string | null },
  ];
  // An older answer still names row 2, which is gone, and not yet row 3, which was just added.
  const said = {
    ok: true as const,
    value: [
      { id: 1, path: 'old name', diff: '+one' },
      { id: 2, path: 'gone.md', diff: '+two' },
    ],
  };

  expect(mergeById(rows, said, ['diff'])).toEqual([
    { id: 1, path: 'a.md', diff: '+one' },
    { id: 3, path: 'new.md', diff: null },
  ]);
  expect(mergeById(rows, null, ['diff'])).toEqual(rows);
  expect(mergeById(rows, { ok: false, message: 'Internal Error' }, ['diff'])).toEqual(rows);
});
