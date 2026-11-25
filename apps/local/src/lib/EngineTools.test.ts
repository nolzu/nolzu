import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import EngineTools from './EngineTools.svelte';
import type { ToolRow } from './engine-profiles.ts';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const row = (one: Partial<ToolRow> & Pick<ToolRow, 'engine' | 'label' | 'binary'>): ToolRow => ({ found: false, version: null, install: 'https://example.invalid/', error: null, path: null, command: null, ...one });
const ROWS: ToolRow[] = [
  row({ engine: 'claude-code', label: 'Claude Code', binary: 'claude', found: true, version: '2.1.296', path: '~/.local/bin/claude' }),
  row({ engine: 'cursor', label: 'Cursor', binary: 'cursor-agent', install: 'https://cursor.com/cli' }),
  row({ engine: 'codex', label: 'Codex', binary: 'codex', command: 'npm install -g @openai/codex' }),
];
const drawn = (props: Record<string, unknown>) => render(EngineTools, { props: { onlook: () => {}, ...props } as never }).body;

it('counts the tools found and gives a found one its version and place', () => {
  const shown = text(drawn({ rows: ROWS, lookedAt: Date.UTC(2026, 9, 15, 14, 2) }));

  expect(shown).toContain('Tools 1 of 3 found');
  expect(shown).toContain('Looked at 14:02');
  expect(shown).toContain('Claude Code 2.1.296 ~/.local/bin/claude');
});

it('gives a missing tool its install line with Copy, or its install page', () => {
  const body = drawn({ rows: ROWS });

  expect(body).toMatch(/<code[^>]*>npm install -g @openai\/codex<\/code>/);
  expect(body).toContain('aria-label="Copy the Codex install command"');
  expect(body).toMatch(/<a[^>]*href="https:\/\/cursor.com\/cli"[^>]*>Install page<\/a>/);
  expect(text(body)).not.toContain('experimental');
});

it('holds Look again while the look runs, and asks for it again when the look failed', () => {
  expect(text(drawn({ rows: null }))).toContain('Looking for each tool and its version.');
  expect(text(drawn({ rows: null }).replace(/<button[^>]*disabled[^>]*>/, '[held]'))).toContain('[held] Look again');
  expect(text(drawn({ rows: null, failed: true }))).toContain('The look did not finish. Press Look again.');
});

// Per engine, which phases this machine can run and why, where it is not every phase. A row with
// nothing to say draws no line.
it('says under each tool which phases this machine can run on it', () => {
  const body = drawn({
    rows: [
      { ...ROWS[0]!, phases: null },
      { ...ROWS[1]!, phases: "Implement only. The read-only phases need Nolzu's wall, which cannot start here. bubblewrap is not installed." },
    ],
  });
  const lines = [...body.matchAll(/<p class="hint phases[^"]*" data-phases[^>]*>([^<]*)<\/p>/g)].map((match) => match[1]);

  expect(lines).toEqual(["Implement only. The read-only phases need Nolzu's wall, which cannot start here. bubblewrap is not installed."]);
});

// The mounted states are in EngineTools.mount.test.ts; these rules only show in the source.
// The skeleton rows and their reduced motion rule are the shared Skeleton's, tested in packages/ui.
it('spans the failed line over the row', () => {
  const source = readFileSync(new URL('./EngineTools.svelte', import.meta.url), 'utf8');

  expect(/\.wide \{([^}]*)\}/.exec(source)?.[1]).toContain('grid-column: 1 / -1;');
});
