import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import type { ScoutFindingDetail as Detail } from './scout-detail.ts';
import type { ScoutFindingRow } from './scout-findings.ts';
import ScoutFindingDetail from './ScoutFindingDetail.svelte';

// Assess starts a run, so it is the amber go button. Start as Delivery card and Start as investigation
// make a card and start nothing, so they are not. Every button sits in the inbox's right pane, whose
// other rules are checked in scout-detail.test.ts.
const row: ScoutFindingRow = {
  id: 1,
  title: 'TypeError: recipe.image is undefined',
  source: 'Pasted log',
  seen: 'Seen once, today',
  first: '2026-10-11 09:00',
  last: '2026-10-11 09:00',
  firstMessage: 'TypeError: recipe.image is undefined',
  lastMessage: 'TypeError: recipe.image is undefined',
  location: '',
  fingerprint: 'f1',
  often: 'seen once',
  at: '09:00',
  status: 'New',
  pill: { state: 'new', word: 'New', detail: null },
  canAssess: true,
  card: null,
  canStart: true,
  cardProblem: null,
};

// The opening tag of the button whose words these are. Tags inside, such as the go mark, are left out.
const button = (body: string, words: string) =>
  [...body.matchAll(/(<button[^>]*>)([\s\S]*?)<\/button>/g)].find((found) => found[2]!.replace(/<[^>]*>/g, '').trim() === words)?.[1] ?? '';
const classes = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? [];

const draw = (one: ScoutFindingRow) => {
  const detail: Detail = { row: one, assessment: null, note: null, run: null, canDismiss: true, canUnmute: false };
  return render(ScoutFindingDetail, { props: { detail, cardHref: (key: string) => `/t/${key}` } }).body;
};

it('draws Assess as the go button, and the two starts as plain buttons', () => {
  const body = draw(row);
  const delivery = button(body, 'Start as Delivery card');

  expect(classes(button(body, 'Assess'))).toContain('go');
  expect(delivery).not.toBe('');
  expect(classes(delivery)).not.toContain('go');
  expect(classes(delivery)).not.toContain('primary');
  expect(classes(button(body, 'Start as investigation'))).not.toContain('go');
});

// Once Assess is behind the finding, the Delivery card is the main step: cream, never amber.
it('makes Start as Delivery card the main button on a finding that was assessed', () => {
  const body = draw({ ...row, canAssess: false, status: 'In assessment', pill: { state: 'ready', word: 'To decide', detail: null } });

  expect(button(body, 'Assess')).toBe('');
  expect(classes(button(body, 'Start as Delivery card'))).toContain('primary');
  expect(body).not.toMatch(/class="btn go\b/);
});
