import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import PrsTab from './PrsTab.svelte';
import type { PrDiscussion } from './prs.ts';

const PULL = { id: 1, repo: 'cook/recipes', number: 12, url: 'https://github.com/cook/recipes/pull/12', title: 'Add a search box', state: 'open' as const, foundBy: 'branch' as const, readAt: '2026-10-29T11:58:00Z' };
const NOW = '2026-10-29T12:00:00Z';
const say = (id: number, author: string | null, body: string, unread = false) => ({ id, author, body, createdAt: '2026-10-29T10:00:00Z', url: null, mine: author === 'pat', unread });
const row = (ref: string, extra: Partial<PrDiscussion> = {}): PrDiscussion => ({
  ref,
  pull: 1,
  kind: 'thread',
  path: 'src/list.ts',
  line: 4,
  resolved: false,
  outdated: false,
  status: 'new',
  verdict: null,
  summary: null,
  reason: null,
  reply: null,
  needsAction: null,
  messages: [say(1, 'dana', '> quoted\nRename the list.', true), say(2, 'pat', 'Done.')],
  ...extra,
});
const none = async () => null;
const draw = (props: Record<string, unknown>) =>
  render(PrsTab, { props: { pulls: [PULL], discussions: [], now: NOW, onread: async () => ({ said: '', failed: false }), onmark: none, onopen: () => {}, onattach: none, ondetach: none, ...props } }).body.replace(/<!--[^>]*-->/g, '');

it('draws one row per discussion with its ref, first line, reviewer, count, status, place and link', () => {
  const body = draw({ discussions: [row('T1'), row('T2', { kind: 'comment', path: null, line: null, status: 'fixed', messages: [say(3, null, 'Thanks')] })] });

  expect(body).toContain('Read 2 minutes ago, 2 discussions, 1 unread');
  expect(body).toContain('Read comments');
  expect(body).toMatch(/T1<\/span> <span class="line[^"]*">Rename the list\.<\/span>/);
  expect(body).toContain('dana');
  expect(body).toContain('2 messages');
  expect(body).toContain('src/list.ts:4');
  expect(body).toContain('Unread.');
  expect(body).toContain('Fixed');
  expect(body).toContain('Deleted account');
  expect(body).toContain('href="https://github.com/cook/recipes/pull/12"');
  expect(body).toContain('aria-label="Open T1 on GitHub"');
  // Rows are closed until opened, and no verdict chip shows before triage.
  expect(body).not.toContain('Mark done');
  expect(body).not.toContain('Nothing to action');
});

it('folds done rows and rows with verdict none into the footer, a done one with Reopen', () => {
  const body = draw({ discussions: [row('T1'), row('T2', { status: 'done' }), row('T3', { verdict: 'none' })] });

  expect(body).toContain('Nothing to action (2)');
  expect(body).toContain('None');
  expect(body.match(/data-needs="T3"/g)).toHaveLength(1);
  expect(body.match(/data-reopen="T2"/g)).toHaveLength(1);
  expect(body).not.toContain('data-needs="T2"');
});

it.each([
  [[], [], 'No comments to show until the card has a pull request.'],
  [[{ ...PULL, readAt: null }], [], 'The comments have not been read yet.'],
  [[PULL], [], 'No comments on the pull request yet.'],
])('says why there are no rows', (pulls, discussions, words) => {
  expect(draw({ pulls, discussions })).toContain(words);
});

it('says Never read before the first read', () => {
  expect(draw({ pulls: [{ ...PULL, readAt: null }] })).toContain('Never read');
});

// The message text is drawn by Markdown, which puts no markup through on the server and cleans it in
// the browser.
it('draws a message as text, never as raw HTML', () => {
  const source = readFileSync(new URL('./PrsTab.svelte', import.meta.url), 'utf8');

  expect(source).toContain('<Markdown source={message.body}');
  expect(source).not.toContain('{@html');
  expect(source).not.toMatch(/--faint|opacity/);
});

const CARD = { key: 'APP-1', stage: 'pr', state: 'ready' as const };
const OFFER = { starts: { engine: 'claude-code', model: 'haiku', effort: 'low' }, estimate: undefined, refusal: null, problem: null };

it('offers Run triage with what it runs on, and Triage again once a verdict is in', () => {
  const first = draw({ discussions: [row('T1')], card: CARD, triage: OFFER });
  expect(first).toContain('Run triage');
  expect(first).toContain('Triage runs on <span class="figure');
  // Named the way every other start names its engine, model and effort.
  expect(first).toContain('Claude Code · haiku · low');
  expect(first).toContain('changes nothing and posts nothing to GitHub');

  const again = draw({ discussions: [row('T1', { verdict: 'fix' })], card: { ...CARD, state: 'running' }, triage: OFFER });
  expect(again).toContain('Triage again');
  expect(again).toMatch(/data-run="triage"[^>]*disabled/);
  // The space between the two sentences sits inside an expression; a bare space before {/if} is trimmed.
  expect(again).toContain('A run holds APP-1 now. Triage once it ends. Triage runs on');
  // No triage offer, no button: the tab is drawn the way it was.
  expect(draw({ discussions: [row('T1')] })).not.toContain('Run triage');
});

it('draws the verdict chip, the summary and the drafted reply with Copy, and the reason once open', () => {
  const body = draw({ discussions: [row('T1', { verdict: 'clarify', summary: 'Asks about an empty box.', reason: 'The ticket does not say.', reply: 'Should an empty box show every recipe?' })], card: CARD, triage: OFFER });
  expect(body).toContain('Clarify');
  expect(body).toContain('Asks about an empty box.');
  expect(body).toContain('Drafted reply:</span> Should an empty box show every recipe?');
  expect(body).toContain('aria-label="Copy the reply to T1"');
  expect(body).not.toContain('The ticket does not say.');
});

it('shows why a triage file was refused', () => {
  const body = draw({ discussions: [row('T1')], card: CARD, triage: { ...OFFER, problem: 'Line 6 of triage.md gives T2 the verdict "maybe". No row took a verdict from it.' } });
  expect(body).toContain('role="alert"');
  expect(body).toContain('Line 6 of triage.md gives T2 the verdict');
});

it('offers Fix and Discuss on each row, Fix again on a fixed one, and says what a fix does', () => {
  const body = draw({
    discussions: [row('T1'), row('T2', { status: 'fixed', fixNote: 'Lower cased both sides.' }), row('T3', { status: 'done' })],
    card: { ...CARD, state: 'idle' },
    triage: OFFER,
    onfix: none,
    changesHref: '/t/APP-1/changes',
  });
  expect(body).toContain('aria-label="Fix T1"');
  expect(body).toContain('aria-label="Fix again T2"');
  expect(body).toMatch(/Fixed, commit and push from <a href="\/t\/APP-1\/changes"[^>]*>Changes<\/a>\./);
  expect(body).toContain('Lower cased both sides.');
  // A done row can still be discussed, and is never fixed.
  expect(body).toContain('data-discuss="T3"');
  expect(body).not.toContain('data-fix="T3"');
  expect(body).toContain("Fix goes on in the card's Implement session and only changes files.");
  // No Fix offered, no buttons: the tab is drawn the way it was.
  expect(draw({ discussions: [row('T1')] })).not.toContain('data-fix');
});

it('holds every Fix with the reason while one runs, and says a failed fix', () => {
  const body = draw({
    discussions: [row('T1', { status: 'fixing' }), row('T2', { fixFailed: 'The fix was stopped.' })],
    card: { ...CARD, state: 'running' },
    onfix: none,
  });
  expect(body).toContain('Fixing. The Implement session is changing the code.');
  expect(body).toContain('Fixing now. The row changes when the run ends.');
  expect(body).toContain('T1 is being fixed now. One fix runs at a time.');
  expect(body).toMatch(/data-fix="T2"[^>]*disabled/);
  expect(body).toContain('Fix failed: The fix was stopped.');
});

it('shows the question a fix stopped on, and not as a failure', () => {
  const body = draw({ discussions: [row('T1', { status: 'fixing', fixAsks: 'Lower case both sides, or only the query?' })], card: { ...CARD, state: 'blocked' }, onfix: none });
  expect(body).toContain('Fix asks a question. Answer it on the Overview tab, and the fix goes on.');
  expect(body).toContain('Lower case both sides, or only the query?');
  expect(body).not.toContain('Fix failed');
  expect(body).not.toContain('Fixing. The Implement session');
});
