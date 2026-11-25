import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import EnginesList from './EnginesList.svelte';
import { engineRows } from './engines.ts';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const rows = engineRows([
  { engine: 'claude-code', binary: 'claude', found: true, version: '2.1.278', install: 'https://example.invalid/claude', error: null },
  { engine: 'cursor', binary: 'cursor-agent', found: false, version: null, install: 'https://example.invalid/cursor', error: null },
  { engine: 'codex', binary: 'codex', found: true, version: null, install: 'https://example.invalid/codex', error: 'Error: cannot find module ./cli.js' },
]);

it('names every engine with its word and version', () => {
  const shown = text(render(EnginesList, { props: { rows } }).body);

  expect(shown).toContain('Claude Code found 2.1.278');
  expect(shown).toContain('Cursor not found');
  expect(shown).toContain('Codex check failed');
});

it('offers the install page for an engine that is not found', () => {
  expect(render(EnginesList, { props: { rows } }).body).toMatch(/<a[^>]*href="https:\/\/example.invalid\/cursor"[^>]*>How to install<\/a>/);
});

it('shows the raw error of a failed check in a code block', () => {
  expect(render(EnginesList, { props: { rows } }).body).toMatch(/<pre[^>]*>Error: cannot find module .\/cli.js<\/pre>/);
});

it('draws a grey line per engine while the check is on its way, and names the command for a screen reader', () => {
  const body = render(EnginesList, { props: { rows: null } }).body;
  const shown = text(body);

  expect(body.match(/data-skeleton/g)?.length).toBeGreaterThanOrEqual(2);
  expect(shown).toContain('claude --version');
  expect(shown).toContain('codex --version');
});
