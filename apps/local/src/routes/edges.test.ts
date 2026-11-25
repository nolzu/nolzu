import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Amber marks only a run that starts or resumes (`docs/design-system.md`). A warning is neutral,
// and a step that will not start is red. These read the source, because a server render carries no
// CSS. A new edge that marks a warning joins the list.
const edges = [
  { file: 'packages/ui/src/Toast.svelte', selector: "[data-kind='warning']", token: 'muted' },
  { file: 'packages/ui/src/Banner.svelte', selector: "[data-kind='warning']", token: 'muted' },
  { file: 'packages/ui/src/ticket/LogLine.svelte', selector: "li[data-kind='retry']", token: 'amber' },
  { file: 'packages/ui/src/ticket/LogLine.svelte', selector: "li[data-kind='limit']", token: 'muted' },
  { file: 'packages/ui/src/ticket/LogLine.svelte', selector: "li[data-kind='denied']", token: 'muted' },
  { file: 'packages/ui/src/board/AddCardDialog.svelte', selector: '.ask', token: 'muted' },
  { file: 'packages/ui/src/ticket/SettingsTab.svelte', selector: ".row[data-state='refused']", token: 'red' },
  { file: 'apps/local/src/lib/ModelsSection.svelte', selector: ".pr[data-state='refused']", token: 'red' },
];

// The declarations of the rule for one selector, from a rule that may list several selectors.
function rule(file: string, selector: string): string {
  const source = readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');
  const style = (/<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) =>
    match[1]!.split(',').some((one) => one.trim() === selector),
  );
  return found?.[2] ?? '';
}

// The colour of the left edge one selector draws.
function edge(file: string, selector: string): string | undefined {
  return /(?:box-shadow: inset 2px 0 0|border-left: 2px solid|border-left-color:) var\(--([a-z0-9-]+)\)/.exec(rule(file, selector))?.[1];
}

it.each(edges)('$file draws the $selector edge in $token', ({ file, selector, token }) => {
  expect(edge(file, selector)).toBe(token);
});

// A count badge is cream or plain ink, never amber (`docs/design-system.md`). The board's Waiting on
// me count took the header's place in the board's top bar.
it.each([
  { file: 'packages/ui/src/board/WaitingToggle.svelte', selector: '.count' },
  { file: 'packages/ui/src/board/BoardColumn.svelte', selector: '.count' },
  { file: 'apps/local/src/lib/Rail.svelte', selector: '.n' },
  { file: 'apps/local/src/lib/NowPage.svelte', selector: '.n' },
])('$file draws the $selector count without amber', ({ file, selector }) => {
  const declarations = rule(file, selector);

  expect(declarations).toContain('color:');
  expect(declarations).not.toContain('amber');
});

// Key caps take the 4px of `docs/design-system.md`, not the 6px of a chip. The board page draws its
// caps with the Kbd part.
it.each(['packages/ui/src/Kbd.svelte'])('%s draws its key caps at --radius-xs', (file) => {
  expect(rule(file, 'kbd')).toContain('border-radius: var(--radius-xs);');
});

it('the board page draws no key cap of its own', () => {
  expect(readFileSync(new URL('../../../../apps/local/src/lib/BoardPage.svelte', import.meta.url), 'utf8')).not.toMatch(/<kbd[\s>]|^\s*kbd\s*\{/m);
});

// A link in the quiet notes of a settings section is blue, not the browser's own link colour.
it('the settings page draws a link in a quiet note in blue', () => {
  expect(rule('apps/local/src/routes/settings/[section]/+page.svelte', '.hint a')).toContain('color: var(--blue);');
});

// The board's count badge is cream: a count badge is the accent with its own ink.
it('draws the Waiting on me count on the cream accent', () => {
  const declarations = rule('packages/ui/src/board/WaitingToggle.svelte', '.count');

  expect(declarations).toContain('background: var(--accent);');
  expect(declarations).toContain('color: var(--accent-ink);');
});

// The rail starts no agent, so it draws no amber: not on the logo, a count, the open selector or the
// usage bar.
it('the rail draws no amber', () => {
  expect(readFileSync(new URL('../../../../apps/local/src/lib/Rail.svelte', import.meta.url), 'utf8')).not.toMatch(/var\(--amber/);
});

// Pressed is said by aria-pressed and by a green edge, so it is not colour alone and the colour is the
// state's.
it('draws Waiting on me pressed with a green edge', () => {
  expect(rule('packages/ui/src/board/WaitingToggle.svelte', ":global(.btn.waiting[aria-pressed='true'])")).toContain('border-color: var(--green);');
});

// The board's top bar wraps instead of running off the page, and the filter box narrows to 96px first,
// so the peek sheet does not push Add card to a second line at 1440.
it('lets the board bar wrap, with the filter box narrowing first', () => {
  const source = readFileSync(new URL('../../../../apps/local/src/lib/BoardPage.svelte', import.meta.url), 'utf8');

  expect(source).not.toContain('flex-wrap: nowrap');
  expect(rule('apps/local/src/lib/BoardPage.svelte', '.filter')).toMatch(/flex: 1 1 96px;[\s\S]*max-width: 200px;/);
});

// Research draws the answer's first paragraph at the lede size, even under a heading.
it('draws the first paragraph of a research answer at 17px', () => {
  expect(rule('packages/ui/src/ticket/ResearchAnswer.svelte', '.report :global(div.markdown > p:first-of-type)')).toContain('font-size: 17px;');
});
