import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import DatePick from './DatePick.svelte';

// The line the screen shows a machine on the free plan. Written out here, so a reworded line has to
// be rewritten in both places and nobody changes it by accident.
const FREE = 'History is part of Solo. This machine is on the free plan, so this field is off.';

it('draws the field open, carrying the other panel along', () => {
  const html = render(DatePick, {
    props: { name: 'day', label: 'Day', value: '2026-03-04', keep: { name: 'week', value: '2026-03-02' }, canPick: true },
  }).body;

  // A GET is the whole mechanism: it writes the field into the URL, which the loader reads back. A
  // POST would reach a route with no form action and answer 405, and every other line here is inert.
  expect(html).toMatch(/<form[^>]*method="GET"/);
  expect(html).toMatch(/<input[^>]*type="date"[^>]*name="day"[^>]*value="2026-03-04"/);
  expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="week"[^>]*value="2026-03-02"/);
  expect(html).not.toContain('disabled');
  expect(html).not.toContain(FREE);
});

// Display only, and the default, so a screen built without the display document draws the field off.
it('draws the field off on a free machine, with the line that says why', () => {
  const html = render(DatePick, { props: { name: 'day', label: 'Day', value: '2026-03-04' } }).body;

  expect(html).toMatch(/<input[^>]*type="date"[^>]*disabled/);
  expect(html).toMatch(/<button[^>]*disabled/);
  expect(html).toContain(FREE);
});
