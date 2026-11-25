import { describe, expect, it } from 'vitest';
import { fetchSentry, type SentryIssue } from './scout-sentry.ts';

/**
 * HAND WRITTEN, AND NOT RECORDED.
 *
 * No real Sentry answer has been recorded yet, so every field below is written from
 * Sentry's documented shape. Treat a Sentry finding as unverified until somebody records one real
 * answer, and read these fixtures as what the adapter expects rather than as what Sentry sends.
 *
 * The first real call has to confirm seven facts about a row of the issue list: that the stable id is
 * `id` and is a string of digits with no space in it, that `shortId` carries the readable name such as
 * `RECIPES-API-7F`, that `title` and `culprit` are strings and `culprit` can be empty, that `level` is
 * a lower case word such as `error`, that `count` is the number of events folded into the issue over
 * its whole life and is answered as a string, that `permalink` is the address of the issue page, and
 * that `id` never changes while `shortId` follows a project that is renamed.
 *
 * It also has to confirm three things about the count, because the cursor here is built on them: that
 * `count` rises as events arrive, that it is a total and not a number since anything, and that it can
 * fall when somebody deletes or merges events.
 *
 * `packages/runner/src/sentry.test.ts` names what the call itself has to confirm.
 */
const issue = (over: Partial<SentryIssue> = {}): SentryIssue => ({
  id: '4501',
  shortId: 'RECIPES-API-7F',
  title: 'TypeError: cannot read length of undefined',
  culprit: 'GET /recipes/{id}',
  level: 'error',
  count: 12,
  permalink: 'https://sentry.io/organizations/your-org/issues/4501/',
  ...over,
});

describe('a Sentry issue', () => {
  it('becomes one group keyed on the issue id, with the event count Sentry gave', () => {
    const { groups, cursor } = fetchSentry([issue()], null);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.fingerprint).toBe('sentry:4501');
    // The count is Sentry's, not how many rows the answer carried. One row, twelve events.
    expect(groups[0]?.count).toBe(12);
    expect(cursor).toBe('4501:12');
  });

  // The evidence a person reads on the finding. The level is the error class this source names, the
  // culprit is the place, and the address is in the message because the finding page draws it as text.
  it('carries the title, the address, the culprit and the level', () => {
    const [group] = fetchSentry([issue()], null).groups;

    expect(group?.first.message).toBe('TypeError: cannot read length of undefined\nhttps://sentry.io/organizations/your-org/issues/4501/');
    expect(group?.first.location).toBe('GET /recipes/{id}');
    expect(group?.first.errorType).toBe('error');
    // One row per issue, so there is no second occurrence to keep apart from the first.
    expect(group?.last).toBe(group?.first);
  });

  // The whole reason this source uses its own id. Sentry groups events itself, so a reworded title is
  // the same issue and may not open a second finding.
  it('keeps its fingerprint when Sentry rewords the title', () => {
    const first = fetchSentry([issue()], null);
    const again = fetchSentry([issue({ title: 'TypeError in the recipe reader', count: 20 })], first.cursor);

    expect(again.groups[0]?.fingerprint).toBe(first.groups[0]?.fingerprint);
  });

  it('stands in the short id where the title is empty, so the finding says something', () => {
    expect(fetchSentry([issue({ title: '' })], null).groups[0]?.first.message).toContain('RECIPES-API-7F');
  });

  it('carries no address where Sentry named none', () => {
    expect(fetchSentry([issue({ permalink: '' })], null).groups[0]?.first.message).toBe('TypeError: cannot read length of undefined');
  });
});

describe('the count across checks', () => {
  // The one thing the cursor exists for. The finding adds what a check reports, and Sentry's count is
  // a total, so without the last total a finding seen twelve times would read as twenty-four.
  it('reports only the events that arrived since the last check', () => {
    const first = fetchSentry([issue({ count: 12 })], null);
    const again = fetchSentry([issue({ count: 20 })], first.cursor);

    expect(again.groups[0]?.count).toBe(8);
    expect(again.cursor).toBe('4501:20');
  });

  it('reports nothing for an issue whose count has not moved', () => {
    const first = fetchSentry([issue({ count: 12 })], null);
    const again = fetchSentry([issue({ count: 12 })], first.cursor);

    expect(again.groups).toEqual([]);
    // The total stays in the cursor. Dropping it would report the whole count again on the next check.
    expect(again.cursor).toBe('4501:12');
  });

  // Sentry can delete or merge events. Taking the difference away would leave the finding claiming
  // fewer occurrences than a person has already read on it.
  it('reports nothing for an issue whose count fell, and keeps the total it already reported', () => {
    const first = fetchSentry([issue({ count: 20 })], null);
    const again = fetchSentry([issue({ count: 3 })], first.cursor);

    expect(again.groups).toEqual([]);
    // The higher total stays. Storing the 3 would let the next answer of 20 report those 20 events a
    // second time, and the finding would read 40 where Sentry reads 20.
    expect(again.cursor).toBe('4501:20');
    expect(fetchSentry([issue({ count: 20 })], again.cursor).groups).toEqual([]);
  });

  // `asCount` in the runner answers 0 for a `count` it cannot read, and a field name this adapter got
  // wrong reads that way on every row, so one odd answer may not reset the baseline.
  it('keeps the stored total when an answer carries no readable count', () => {
    const first = fetchSentry([issue({ count: 100 })], null);
    const blank = fetchSentry([issue({ count: 0 })], first.cursor);

    expect(blank.cursor).toBe('4501:100');
    expect(fetchSentry([issue({ count: 100 })], blank.cursor).groups).toEqual([]);
  });

  // An issue exists in Sentry because an event made it, so a count of zero is a field this version
  // read wrong. Reporting nothing would hide the issue whole.
  it('opens a finding for a new issue even where the count is zero', () => {
    const { groups, cursor } = fetchSentry([issue({ count: 0 })], null);

    expect(groups[0]?.count).toBe(1);
    // The one occurrence that was reported, not the zero. Storing the zero would make the next answer
    // of five report five more, and the finding would read six where Sentry reads five.
    expect(cursor).toBe('4501:1');
    expect(fetchSentry([issue({ count: 5 })], cursor).groups[0]?.count).toBe(4);
  });

  it('counts a new issue beside one that has not moved', () => {
    const first = fetchSentry([issue({ id: '1', count: 5 })], null);
    const again = fetchSentry([issue({ id: '1', count: 5 }), issue({ id: '2', count: 7 })], first.cursor);

    expect(again.groups.map((one) => one.count)).toEqual([7]);
    expect(again.cursor).toBe('1:5 2:7');
  });

  // The cursor is a column a person can read, and two checks of one project may not store the same
  // totals as two different strings.
  it('writes the cursor in order, whatever order Sentry answered in', () => {
    expect(fetchSentry([issue({ id: '30', count: 1 }), issue({ id: '2', count: 1 })], null).cursor).toBe('2:1 30:1');
  });

  it('answers nothing and no cursor for a project with no unresolved issue', () => {
    expect(fetchSentry([], null)).toEqual({ groups: [], cursor: null });
  });

  // `finishScoutCheck` asks for this by name: a check that read nothing hands back the cursor it was
  // given. Nulling it would throw away every total in one check, and the next answer would report
  // every issue's whole lifetime count on top of the findings that already counted those events.
  it('keeps every total when the answer carries no issue at all', () => {
    const first = fetchSentry([issue({ id: '4501', count: 900 }), issue({ id: '4502', count: 3 })], null);
    const empty = fetchSentry([], first.cursor);

    expect(empty).toEqual({ groups: [], cursor: '4501:900 4502:3' });
    expect(fetchSentry([issue({ id: '4501', count: 900 })], empty.cursor).groups).toEqual([]);
  });

  // Resolve then regress is the ordinary Sentry loop, not an edge case. `query=is:unresolved` leaves a
  // resolved issue out of the answer, so its total has to survive an answer that does not mention it.
  it('keeps the total of an issue the answer left out, so a regression reports only what is new', () => {
    const first = fetchSentry([issue({ id: '4501', count: 900 }), issue({ id: '4502', count: 3 })], null);
    const resolved = fetchSentry([issue({ id: '4502', count: 3 })], first.cursor);

    expect(resolved.cursor).toBe('4501:900 4502:3');

    const back = fetchSentry([issue({ id: '4501', count: 901 }), issue({ id: '4502', count: 3 })], resolved.cursor);
    expect(back.groups.map((one) => one.count)).toEqual([1]);
  });

  // The ceiling the cursor doc names. Two hundred totals are kept, and what is cut is a total for an
  // issue this answer did not carry, never one Sentry has just counted.
  it('cuts the oldest totals rather than growing the cursor forever', () => {
    const many = Array.from({ length: 260 }, (_, at) => `${1000 + at}:5`).join(' ');
    const { cursor } = fetchSentry([issue({ id: '4501', count: 7 })], many);
    const pairs = (cursor ?? '').split(' ');

    expect(pairs).toHaveLength(200);
    expect(pairs).toContain('4501:7');
  });

  // A cursor an older version or a hand edit wrote. A pair with no number in it is dropped rather than
  // read as a total, because half a number would subtract from the count a person reads.
  it('reads an issue as new where its pair in the cursor cannot be read', () => {
    expect(fetchSentry([issue({ count: 9 })], '4501:many').groups[0]?.count).toBe(9);
    expect(fetchSentry([issue({ count: 9 })], 'nonsense').groups[0]?.count).toBe(9);
    expect(fetchSentry([issue({ count: 9 })], '').groups[0]?.count).toBe(9);
  });
});
