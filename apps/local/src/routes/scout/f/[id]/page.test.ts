import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addScoutSource, checkPasteSource, openDatabase, scoutFinding } from '@nolzu/core/node';
import { render } from 'svelte/server';
import { afterAll, expect, it } from 'vitest';
import { FREE } from '$lib/display.ts';
import type { ScoutFindingDetail } from '$lib/scout-detail.ts';
// The stub vitest aliases `$app/paths` to. By path and not by that name, because the app's types for
// `$app/paths` are SvelteKit's own and carry no `drawnAt`.
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../../test/stubs/app-paths.ts';
import Finding from './+page.svelte';

// The route reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported and opens anything.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-scout-detail-route-'));
process.env.NOLZU_DATA_DIR = dir;

const { actions, load } = await import('./+page.server.ts');
const page = load as unknown as (event: { params: { id: string } }) => { finding: ScoutFindingDetail };
type Answer = { did?: string; said?: string; status?: number; data?: { did: string; problem: string } };
const post = (id: number | string) => ({ request: new Request('http://localhost/scout/f/1', { method: 'POST', body: new URLSearchParams({ id: String(id) }) }) });

// One finding of its own per test, so a mute in one does not decide what another reads.
function addFinding(label: string, line: string): number {
  const db = openDatabase(dir);
  const source = addScoutSource(db, { kind: 'paste', label });
  checkPasteSource(db, source, line);
  const id = (db.prepare('SELECT max(id) AS id FROM scout_findings').get() as { id: number }).id;
  db.close();
  return id;
}

const statusOf = (id: number): string | undefined => {
  const db = openDatabase(dir);
  const found = scoutFinding(db, id)?.status;
  db.close();
  return found;
};

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('loads one finding by the id in its address', () => {
  const id = addFinding('Pasted by hand', 'Timeout after 5000ms calling /api/recipes');

  const data = page({ params: { id: String(id) } });

  expect(data.finding.row.id).toBe(id);
  expect(data.finding.row.title).toBe('Timeout after 5000ms calling /api/recipes');
  expect(data.finding.row.source).toBe('Pasted by hand');
});

// A redirect to the list would hide that the address was wrong, and an empty page would read as one
// that broke. What the sentence says is proved in scout-detail.test.ts; this is the route throwing it.
it('answers 404 for an id that is no number and for a finding that is not there', () => {
  expect(() => page({ params: { id: 'wat' } })).toThrow();
  expect(() => page({ params: { id: '99999' } })).toThrowError(expect.objectContaining({ status: 404 }));
});

// The buttons reaching the database through this route. What each may do to a finding is proved
// in scout-findings.test.ts; this is the wiring, and that the page then shows the state the write left.
it('mutes a finding from its own page and shows the new state', async () => {
  const id = addFinding('Pasted for the detail buttons', 'Out of disk space writing /var/log/recipes.log');

  const muted = (await actions.dismiss!(post(id) as never)) as Answer;

  expect(muted.did).toBe('dismiss');
  expect(statusOf(id)).toBe('dismissed');
  // The page after the post. Dismiss is gone and Unmute is there, because the writers behind them
  // would answer nothing else on a muted finding.
  const after = page({ params: { id: String(id) } });
  expect(after.finding.row.status).toBe('Muted');
  expect(after.finding.canDismiss).toBe(false);
  expect(after.finding.canUnmute).toBe(true);

  const back = (await actions.unmute!(post(id) as never)) as Answer;

  expect(back.did).toBe('unmute');
  expect(page({ params: { id: String(id) } }).finding.canDismiss).toBe(true);
});

// A refusal is a 400 with a sentence, so the screen prints it under the buttons instead of a 500 page.
it('refuses a dismiss of a finding that is not there and names it', async () => {
  const answer = (await actions.dismiss!(post(99999) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(answer.data?.problem).toContain('99999');
  expect(answer.data?.did).toBe('dismiss');
});

// The finding's own address is the Scout page with its row selected: the row is marked and the right
// pane shows it, whichever finding was seen last.
it('selects its own row in the inbox, and shows it on the right', () => {
  const older = addFinding('Pasted for the selection', 'Disk full writing /var/log/recipes.log');
  addFinding('Pasted later', 'Connection reset by the recipe search');
  drawnAt(`/scout/f/${older}`);

  const body = render(Finding as never, { props: { data: { ...page({ params: { id: String(older) } }), display: FREE }, form: null } } as never).body;
  const marked = [...body.matchAll(/<a class="frow[^"]*" href="([^"]*)"( aria-current="true")?>/g)].filter((match) => match[2] !== undefined).map((match) => match[1]);

  expect(marked).toEqual([`../../scout/f/${older}`]);
  expect(body).toMatch(/<h2 class="fd-t[^"]*" id="fd-t">Disk full writing \/var\/log\/recipes\.log<\/h2>/);
  // Its buttons post to its own address, so the answer prints beside it after the post.
  expect(body).toContain(`action="../../scout/f/${older}?/dismiss#actions-title"`);
});

// The two lines that carry a rule are read as source, and neither is matched whole: a reflow of the
// tag is no bug, and a test that dies on one teaches people to loosen it.
it('draws the finding the loader read, and titles the page with the id', () => {
  const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

  // Without this the page loads a finding and draws an empty shell.
  expect(source).toContain('detail={data.finding}');
  // The id and never the collected line. A pasted message can hold a real token, and the title
  // reaches the tab, the window and the browser history.
  expect(source).toContain('<title>Finding {data.finding.row.id} · Nolzu</title>');
});
