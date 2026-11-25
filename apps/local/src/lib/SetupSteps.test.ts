import { setupSteps, type SetupFacts } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { beforeEach, expect, it } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import SetupSteps from './SetupSteps.svelte';

// The banner of Set up the project on the boards and on Now: the open required and recommended
// steps, each recommended one with its own Put away, and each until it is done or put away.
const FRESH: SetupFacts = { marks: {}, learned: false, browser: false, tickets: false };
const banner = (facts: SetupFacts) => render(SetupSteps as never, { props: { steps: setupSteps(facts), variant: 'banner' } } as never).body;
const text = (html: string) => html.replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

beforeEach(() => drawnAt('/b/delivery'));

it('lists Learn as required and the two recommended steps, each recommended one with Put away', () => {
  const html = banner(FRESH);
  expect(text(html)).toBe('Set up the project Learn your repositories Required Confirm the run commands Recommended Set up the QA browser Recommended');
  expect(html).toMatch(/href="[./]*\/?knowledge#learn-repos"/);
  expect(html.match(/aria-label="Put away [^"]+"/g)).toEqual(['aria-label="Put away Confirm the run commands"', 'aria-label="Put away Set up the QA browser"']);
});

it('drops a step put away, keeps the recommended ones once Learn is done, and draws nothing once all are', () => {
  expect(text(banner({ ...FRESH, marks: { qa: 'dismissed' } }))).not.toContain('QA browser');
  expect(text(banner({ ...FRESH, marks: { learn: 'self' } }))).toBe('Set up the project Confirm the run commands Recommended Set up the QA browser Recommended');
  expect(banner({ ...FRESH, learned: true, browser: true, marks: { commands: 'done' } })).not.toContain('data-setup');
});

// The list draws the step's own link beside the title, so the title is plain text: one Tab stop each.
it('links each open step once in the list, from its action and not its title', () => {
  const html = render(SetupSteps as never, { props: { steps: setupSteps(FRESH), variant: 'list' } } as never).body;
  expect(html.match(/href="[./]*\/?knowledge#learn-repos"/g)).toHaveLength(1);
  expect(html).toMatch(/<a class="go[^"]*" href="[./]*\/?knowledge#learn-repos">/);
});
