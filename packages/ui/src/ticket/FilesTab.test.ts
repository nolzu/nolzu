import { readFileSync } from 'node:fs';
import type { CardFileGroup } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import FilesTab from './FilesTab.svelte';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const url = (path: string, download = false) => `/api/card/APP-1/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
const draw = (groups: CardFileGroup[], folder: string | null = '/projects/recipes/.tasks/APP-1') =>
  render(FilesTab, { props: { groups, folder, fileUrl: url, onread: async () => ({ ok: true as const, text: '' }) } }).body;

const groups: CardFileGroup[] = [
  {
    folder: 'refine',
    share: false,
    files: [
      { path: 'refine/refined.md', name: 'refined.md', size: 1229, kind: 'markdown', phase: 'refine', modified: 0, when: '10:10' },
      { path: 'refine/sketch.pdf', name: 'sketch.pdf', size: 86_016, kind: 'download', phase: 'refine', modified: 0, when: 'Tue 09:05' },
    ],
  },
  { folder: 'share', share: true, files: [{ path: 'share/shot.png', name: 'shot.png', size: 4, kind: 'image', phase: null, modified: 0, when: '15:32' }] },
];

it('says so when the card has no files yet', () => {
  expect(text(draw([]))).toContain('No files yet');
});

// Nothing writes a log or a pull request comment into the card folder. A person copies it, so the
// one screen that shows the folder is the one place its path can come from.
it('names the card folder in the empty state, so a person knows where to copy a file', () => {
  const shown = text(draw([]));

  expect(shown).toContain('/projects/recipes/.tasks/APP-1');
  expect(shown).toMatch(/copy it into/);
});

it('leaves the copy sentence out for a card with no folder', () => {
  const shown = text(draw([], null));

  expect(shown).toContain('No files yet');
  expect(shown).not.toMatch(/copy it into/);
});

it('badges the share folder as meant for other people and the rest as internal', () => {
  const shown = text(draw(groups));
  expect(shown).toMatch(/refine\/ internal/);
  expect(shown).toMatch(/share\/ share/);
});

it('badges a phase folder internal, whichever phase it is', () => {
  const folders = ['plan', 'qa', 'implement', 'wrapup'].map((folder): CardFileGroup => ({ folder, share: false, files: [{ path: `${folder}/a.md`, name: 'a.md', size: 1, kind: 'markdown', phase: 'plan', modified: 0, when: '10:10' }] }));
  const shown = text(draw(folders));
  for (const folder of ['plan', 'qa', 'implement', 'wrapup']) expect(shown).toContain(`${folder}/ internal`);
  expect(shown).not.toMatch(/\/ share/);
});

it('draws a file the viewer can show as a button that opens it, with its size and time', () => {
  const body = draw(groups);

  expect(body).toMatch(/<button[^>]*data-file="refine\/refined\.md"/);
  expect(text(body)).toContain('refined.md 1.2 KB 10:10');
});

// Every row opens the viewer, a pdf too. Download lives in the viewer head, never in a row.
it('draws a file the viewer cannot show as a button too, with no Download in the list', () => {
  const body = draw(groups);
  const list = /<nav[\s\S]*?<\/nav>/.exec(body)?.[0] ?? '';

  expect(body).toMatch(/<button[^>]*data-file="refine\/sketch\.pdf"/);
  expect(list).not.toContain('download');
});

it('says what share and internal mean under the list', () => {
  expect(text(draw(groups))).toContain("Files in share/ are meant for other people. The rest are the card's working notes.");
});

// The list and the preview have no frame around them, only the divider between.
it('draws no outer border around the list and the preview', () => {
  const source = readFileSync(new URL('./FilesTab.svelte', import.meta.url), 'utf8');
  const rule = /\.files \{([^}]*)\}/.exec(source)?.[1] ?? '';

  expect(rule).toContain('display: grid');
  expect(rule).not.toMatch(/border/);
});

// A text file fills the box up to 120ch, as Markdown does.
it('lets a text file fill the viewer up to 120ch', () => {
  const source = readFileSync(new URL('./FilesTab.svelte', import.meta.url), 'utf8');

  expect(source).toMatch(/\.body > pre \{\s*max-width: min\(100%, 120ch\);/);
});
