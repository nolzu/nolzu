import type { FailedRun, Ticket } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { fingerprint } from './scout.ts';
import { fetchTickets, ticketKeyOf, ticketPlan } from './scout-tickets.ts';

const ticket = (key: string, title: string): Ticket => ({ key, title, body: 'what is wrong', state: 'open', url: null, parentKey: null });

const run = (id: number, workflow = 'Tests', branch = 'main'): FailedRun => ({ repo: 'acme/app', workflow, branch, id });

describe('a ticket', () => {
  it('becomes one item whose id is its own key', () => {
    const { items, cursor } = fetchTickets([ticket('acme/app#42', 'Cache drops rows')], [], null);

    expect(items).toEqual([
      { sourceKind: 'tickets', errorType: '', message: 'Cache drops rows', location: 'acme/app#42', sourceId: 'acme/app#42' },
    ]);
    expect(fingerprint(items[0]!)).toBe('tickets:acme%2Fapp%2342');
    expect(cursor).toBe('acme/app#42');
  });

  // The whole reason a ticket carries its own id. Without `sourceId` the fingerprint is built from
  // the message, and a ticket somebody renamed would become a second finding for the same ticket.
  it('keeps its id when somebody rewords the title', () => {
    const first = fetchTickets([ticket('PROJ-123', 'Search by ingredient')], [], null);
    const again = fetchTickets([ticket('PROJ-123', 'Ingredient search is wrong')], [], null);

    expect(fingerprint(first.items[0]!)).toBe(fingerprint(again.items[0]!));
  });

  // The cursor is what keeps a check from adding one to the count of every open ticket every time it
  // runs. A ticket exists once, so a check meets it once.
  it('is not reported again on a second check with the cursor of the first', () => {
    const first = fetchTickets([ticket('acme/app#1', 'One'), ticket('acme/app#2', 'Two')], [], null);
    expect(first.items).toHaveLength(2);

    const again = fetchTickets([ticket('acme/app#1', 'One'), ticket('acme/app#2', 'Two'), ticket('acme/app#3', 'Three')], [], first.cursor);

    expect(again.items.map((one) => one.sourceId)).toEqual(['acme/app#3']);
    // Every id the query answered, not only the new one, so the next check knows all three.
    expect(again.cursor).toBe('acme/app#1 acme/app#2 acme/app#3');
  });

  // The cursor is a column a person can read, and its doc comment says the ids come back sorted. A
  // query answers in its own order, so the sort here is what keeps two checks of one backlog from
  // storing the same ids as two different strings.
  it('writes the cursor in order, whatever order the query answered in', () => {
    const { cursor } = fetchTickets([ticket('acme/app#3', 'Three'), ticket('acme/app#1', 'One')], [], null);

    expect(cursor).toBe('acme/app#1 acme/app#3');
  });

  it('answers nothing and no cursor when the query answered nothing', () => {
    expect(fetchTickets([], [], null)).toEqual({ items: [], cursor: null });
  });

  it('stands in the key where a ticket has no title, so the finding says something', () => {
    expect(fetchTickets([ticket('PROJ-9', '')], [], null).items[0]?.message).toBe('PROJ-9');
  });
});

describe('a failed CI run', () => {
  it('becomes an item, and a passing one is never handed here at all', () => {
    const { items, cursor } = fetchTickets([], [run(9001)], null);

    expect(items).toEqual([{ sourceKind: 'tickets', errorType: 'ci', message: 'Tests failed on main', location: 'acme/app@main' }]);
    expect(cursor).toBe('ci:9001');
  });

  /**
   * One finding per workflow, not per run.
   *
   * A run carries no `sourceId`, so the fingerprint is built from the error type, the message and the
   * location. None of the three holds the run number, so a pipeline that fails four times is one
   * finding with a count of four and not four rows to dismiss one by one.
   */
  it('folds two runs of one workflow into one id, and keeps two workflows apart', () => {
    const { items } = fetchTickets([], [run(9001), run(9002), run(9003, 'Lint')], null);

    expect(items).toHaveLength(3);
    expect(fingerprint(items[0]!)).toBe(fingerprint(items[1]!));
    expect(fingerprint(items[2]!)).not.toBe(fingerprint(items[0]!));
  });

  // A run id is in the cursor under its own prefix, so the count grows by one per new failed run and
  // not by one per check.
  it('is not counted again on a second check that saw it', () => {
    const first = fetchTickets([], [run(9001)], null);

    const again = fetchTickets([], [run(9001), run(9002)], first.cursor);

    expect(again.items).toHaveLength(1);
    expect(again.cursor).toBe('ci:9001 ci:9002');
  });

  // A ticket key and a run id share one cursor, so the prefix is what keeps `9001` apart from a
  // ticket that happens to be called the same.
  it('shares the cursor with the tickets and stays apart from them', () => {
    const { cursor } = fetchTickets([ticket('PROJ-1', 'One')], [run(9001)], null);

    expect(cursor).toBe('PROJ-1 ci:9001');
    expect(fetchTickets([ticket('PROJ-1', 'One')], [run(9001)], cursor).items).toEqual([]);
  });
});

// The key a started finding's card takes. A reader that guessed it from the stored line would have to
// tell `PROJ-123` from `acme/app@main`, and a failed run writes the second one into the same field.
describe('the ticket a finding is about', () => {
  it('is the key of a ticket item, and nothing on a failed run', () => {
    const { items } = fetchTickets([ticket('PROJ-123', 'Search by ingredient')], [run(9001)], null);

    expect(ticketKeyOf(items[0]!)).toBe('PROJ-123');
    expect(ticketKeyOf(items[1]!)).toBe(null);
  });

  // Every other source keys on its own id too. Sentry writes an issue id into `sourceId`, and that id
  // is no ticket key, so a card made from it would carry a number no board can open.
  it('is nothing on an item from another source, whatever id that source carries', () => {
    expect(ticketKeyOf({ sourceKind: 'sentry', errorType: 'TypeError', message: 'undefined is not a function', location: '', sourceId: '4501' })).toBe(null);
    expect(ticketKeyOf({ sourceKind: 'paste', errorType: '', message: 'Timeout after 5000ms', location: '' })).toBe(null);
    // An empty id is no id. Without this the card would be keyed on the empty string.
    expect(ticketKeyOf({ sourceKind: 'tickets', errorType: '', message: 'One', location: '', sourceId: '' })).toBe(null);
  });
});

/**
 * The settings fold, checked on its own.
 *
 * The numbers are written out here rather than read from the module, because a test that imports the
 * limit it asserts passes whatever the limit becomes. Thirty and twenty are what `gh` was measured
 * against.
 */
describe('the plan behind a ticket query', () => {
  it('splits a GitHub repository into the halves the CI read takes, and keeps the whole name for the search', () => {
    const plan = ticketPlan({ system: 'github', repo: 'acme/app', query: 'label:bug' });

    expect(plan).toEqual({
      system: 'github',
      owner: 'acme',
      repo: 'app',
      query: { limit: 30, repos: ['acme/app'], terms: 'label:bug' },
      ciLimit: 20,
    });
  });

  // Half a repository has the slash and is still nonsense. The sentence says where to fix it, because
  // the person typed it into the source on the Scout page.
  it('refuses a repository that is not owner/repo, and says where to fix it', () => {
    for (const repo of ['recipes', 'acme/', '/app', '']) {
      expect(() => ticketPlan({ system: 'github', repo })).toThrow(/owner\/repo/);
      expect(() => ticketPlan({ system: 'github', repo })).toThrow(/Open the source on the Scout page/);
    }
  });

  it('gives GitLab the project, the search and the page one by one, because glab takes them that way', () => {
    expect(ticketPlan({ system: 'gitlab', project: 'acme/app', query: 'label:bug import' })).toEqual({
      system: 'gitlab',
      project: 'acme/app',
      terms: 'label:bug import',
      limit: 30,
    });
  });

  it('gives Jira the site, the account and the query the person typed, and asks for no project', () => {
    expect(ticketPlan({ system: 'jira', site: 'https://example.atlassian.net', email: 'dana@example.com', jql: 'project = PROJ AND status = Open' })).toEqual({
      system: 'jira',
      site: { url: 'https://example.atlassian.net', email: 'dana@example.com' },
      query: { limit: 30, repos: [], terms: 'project = PROJ AND status = Open' },
    });
  });

  /**
   * The site address is checked here and not by the caller.
   *
   * The caller's next step is a keychain read, which can put an OS password dialog in front of the
   * person. A typo must not cost them that, so the cheap check comes first.
   */
  it('refuses a Jira site address that is not https', () => {
    expect(() => ticketPlan({ system: 'jira', site: 'http://example.atlassian.net', email: 'dana@example.com', jql: 'project = PROJ' })).toThrow(/starts with https/);
  });

  it('upper cases the Linear team keys and takes both a comma and a space as the separator', () => {
    expect(ticketPlan({ system: 'linear', teams: 'proj, OPS ux' })).toEqual({
      system: 'linear',
      query: { limit: 30, repos: ['PROJ', 'OPS', 'UX'] },
    });
  });

  // A field of commas alone passes the form, because the form only refuses an empty one. Linear would
  // then be asked for no team, make no call, and the check would stamp the source green.
  it('refuses a Linear teams field that holds no key, before anybody reads a keychain', () => {
    expect(() => ticketPlan({ system: 'linear', teams: ', ,' })).toThrow(/holds no Linear team key/);
    expect(() => ticketPlan({ system: 'linear', teams: '' })).toThrow(/Open the source on the Scout page/);
  });

  // A stored system this version does not know, which is what a source added by a later version looks
  // like after a downgrade. The four it does know are in the sentence, so dropping one is a failing test.
  it('names the four systems it knows when the stored one is not among them', () => {
    expect(() => ticketPlan({ system: 'tracker', repo: 'acme/app' })).toThrow(/tracker/);
    expect(() => ticketPlan({ system: 'tracker', repo: 'acme/app' })).toThrow(/GitHub, GitLab, Jira or Linear/);
    expect(() => ticketPlan({})).toThrow(/does not know the ticket system ""/);
  });
});
