import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import { emptyEntry } from '$lib/mcp-list.ts';
import type { McpPageData } from '$lib/mcp-page.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../test/stubs/app-paths.ts';
import Page from './+page.svelte';

const WARNING = "On Cursor the agent's shell can read this server's secret.";
const DB = { ...emptyEntry(), name: 'db', command: 'db-mcp', env: [{ name: 'DB_LOGIN', secret: true as const }] };
const data = (cursorSecret: boolean, entry: McpPageData['rows'][number]['entry'] = DB): McpPageData => ({
  hasFolder: true,
  file: '.nolzu/mcp-servers.json',
  rows: [{ entry, missing: [], unlimited: [], urlWarning: null, cursorSecret }],
  problems: [],
  phases: [],
  cursor: false,
  codex: true,
  broken: null,
  shared: true,
  uncommitted: false,
  commitProblem: null,
  migration: null,
});
const drawn = (cursorSecret: boolean, entry?: McpPageData['rows'][number]['entry']) => {
  drawnAt('/settings/mcp');
  return render(Page as never, { props: { data: data(cursorSecret, entry), form: null } } as never).body.replaceAll('&#39;', "'");
};

it("warns on the server's row that Cursor's shell can read its secret, and only then", () => {
  const row = (body: string) => body.slice(body.indexOf('data-mcp-server="db"'));
  expect(row(drawn(true))).toMatch(new RegExp(`<p class="warn[^"]*" role="note">${WARNING}</p>`));
  expect(drawn(false)).not.toContain(WARNING);
});

// The list and Add a server come first. The engine notes wait in one closed block under the grid, and
// a note that applies to one server sits on that server's row.
it('draws the list and Add a server before the engine notes, which are closed under the grid', () => {
  const body = drawn(false);
  const notes = /<details class="notes[^"]*">([\s\S]*?)<\/details>/.exec(body);

  expect(notes?.[1]).toContain('How each engine gets these servers');
  expect(notes?.[1]).toContain('Cursor runs also start the servers in your own');
  expect(body.indexOf('data-mcp-server="db"')).toBeLessThan(body.indexOf('Add a server'));
  expect(body.indexOf('Add a server')).toBeLessThan(body.indexOf('<details'));
  expect(body.lastIndexOf('Codex runs leave out the servers')).toBeGreaterThan(body.indexOf('<details'));
});

it("puts the SSE note on the server's own row, and only there", () => {
  const sse = drawn(false, { ...emptyEntry(), name: 'docs', kind: 'remote', url: 'https://mcp.example.com/sse', transport: 'sse' });
  const row = (body: string) => body.slice(body.indexOf('data-mcp-server='), body.indexOf('Add a server'));

  expect(row(sse)).toContain('so Codex runs leave this server out.');
  expect(row(drawn(false))).not.toContain('so Codex runs leave this server out.');
  // An HTTP remote is no SSE server.
  expect(row(drawn(false, { ...emptyEntry(), name: 'docs', kind: 'remote', url: 'https://mcp.example.com/mcp', transport: 'http' }))).not.toContain('so Codex runs leave this server out.');
});

// A row says only what the person needs: no line for a server with every tool, and the Cursor limit
// only when a profile runs on Cursor. Every engine starts a server in its folder, so that needs none.
it('keeps the row short', () => {
  const row = (cursor: boolean, entry = DB) => {
    drawnAt('/settings/mcp');
    const body = render(Page as never, { props: { data: { ...data(false, entry), cursor }, form: null } } as never).body.replaceAll('&#39;', "'");
    return body.slice(body.indexOf('data-mcp-server='), body.indexOf('Add a server'));
  };
  const listed = { ...DB, tools: ['query', 'schema'], cwd: 'services' };

  expect(row(false)).not.toContain('Tools:');
  expect(row(false)).not.toContain('All tools');
  expect(row(false, listed)).toContain('Tools: query, schema.</p>');
  expect(row(true, listed)).toContain('Tools: query, schema. Cursor cannot limit single tools and gets them all.');
  expect(row(true, listed)).not.toMatch(/folder/i);
});

// The notes about what an engine's own config adds show above the list, only for an engine a profile
// runs on, and the SSE note only where a Codex profile would leave the server out.
it('says what Cursor and Codex add from their own configs only when a profile runs on them', () => {
  const sse = { ...emptyEntry(), name: 'docs', kind: 'remote' as const, url: 'https://mcp.example.com/sse', transport: 'sse' as const };
  const page = (cursor: boolean, codex: boolean) => {
    drawnAt('/settings/mcp');
    const body = render(Page as never, { props: { data: { ...data(false, sse), cursor, codex }, form: null } } as never).body.replaceAll('&#39;', "'");
    return body.slice(0, body.indexOf('<details'));
  };

  expect(page(true, false)).toMatch(/<p class="warn[^"]*" role="note">Cursor runs also start the servers in your own/);
  expect(page(true, false)).not.toContain('A system or managed Codex config');
  expect(page(true, false)).not.toContain('so Codex runs leave this server out.');
  expect(page(false, true)).toContain('A system or managed Codex config');
  expect(page(false, true)).toContain('so Codex runs leave this server out.');
  expect(page(false, true)).not.toContain('Cursor runs also start');
});
