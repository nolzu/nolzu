import { join } from 'node:path';
import { PHASE_GUARD } from './hook.ts';
import { readBlock, withoutBlock, writeBlock } from './markers.ts';

export type WriteKind = 'create' | 'replace' | 'append' | 'keep' | 'unchanged' | 'remove';

export interface PlannedWrite {
  // Relative to the project root, so nothing here can name a folder on the machine.
  path: string;
  kind: WriteKind;
  // The whole file as it should end up. Empty for a file that is kept as it is.
  content: string;
  // One line for the summary the person reads at the end of onboarding.
  note: string;
}

export interface ProjectPlan {
  writes: readonly PlannedWrite[];
  dirs: readonly string[];
  // Paths Nolzu will not touch, with the reason. Reported rather than written.
  refused: readonly string[];
}

export interface PlanInput {
  // Path relative to the project root, to the text that is there now. A path that is missing is
  // a file that is not there.
  existing: Readonly<Record<string, string>>;
  agents: string;
  pointer: string;
  // The engine's entry file, one per repository root.
  pointerPath: string;
}

export const GUARD_PATH = '.claude/hooks/nolzu-phase-guard.mjs';
export const SETTINGS_PATH = '.claude/settings.json';

// Matched on the command, because that is the part that names Nolzu. A matcher can be edited by
// hand without making the entry somebody else's.
const guardCommand = `node "$CLAUDE_PROJECT_DIR/${GUARD_PATH}"`;

const hookEntry = (command = guardCommand) => ({
  matcher: 'Write|Edit|NotebookEdit|Bash',
  hooks: [{ type: 'command', command, timeout: 10 }],
});

// The settings file every Claude Code run is handed. A run works in the card's checkout, and measured on
// Claude Code 2.1.278 that checkout is both what `--setting-sources project` reads and what
// `CLAUDE_PROJECT_DIR` points at, while the project's own `.claude/` is there only if the person
// committed it. So the file names the guard by its full path, for a project that has one (null leaves the
// hook out). It turns Claude Code's own sandbox off whatever the person's settings say: every run starts
// inside Nolzu's wall, and a macOS sandbox cannot start inside another one. And it turns off the line
// Claude Code adds to commits and pull request texts: `attribution` with empty values hides both, and the
// older `includeCoAuthoredBy` does the same on a version before it. The person's own files stay untouched.
export function guardSettings(projectPath: string | null): string {
  const hooks = projectPath === null ? {} : { hooks: { PreToolUse: [hookEntry(`node ${JSON.stringify(join(projectPath, GUARD_PATH))}`)] } };
  return `${JSON.stringify({ sandbox: { enabled: false }, attribution: { commit: '', pr: '' }, includeCoAuthoredBy: false, ...hooks }, null, 2)}\n`;
}

// A path that leaves the project is refused rather than cleaned up, because a template that
// climbs out is a mistake worth showing rather than quietly rewriting.
function leavesProject(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.startsWith('\\')) return true;
  if (/^[A-Za-z]:/.test(path)) return true;
  return path.split(/[\\/]/).includes('..');
}

function planMarkdown(
  path: string,
  body: string,
  existing: Readonly<Record<string, string>>,
  whenUnmarked: 'append' | 'keep',
): PlannedWrite {
  const text = existing[path];
  if (text === undefined) {
    return { path, kind: 'create', content: writeBlock('', body), note: `Wrote ${path}.` };
  }

  const block = readBlock(text);
  if (block.broken) {
    return { path, kind: 'keep', content: '', note: `${path} has a start marker and no end, so it was left alone.` };
  }
  if (block.body === null) {
    if (whenUnmarked === 'keep') {
      return { path, kind: 'keep', content: '', note: `${path} was already there, so it was kept as it is.` };
    }
    return { path, kind: 'append', content: writeBlock(text, body), note: `Added a Nolzu section to the end of ${path}.` };
  }
  if (block.body === body) {
    return { path, kind: 'unchanged', content: text, note: '' };
  }
  return { path, kind: 'replace', content: writeBlock(text, body), note: `Updated the Nolzu section of ${path}.` };
}

// JSON carries no comment, so there is no marker to own a block with. Nolzu owns its own hook
// entry, found by its command, and every other key is left exactly as it was.
function planSettings(existing: Readonly<Record<string, string>>): PlannedWrite {
  const text = existing[SETTINGS_PATH];
  const entry = hookEntry();

  if (text === undefined) {
    const content = `${JSON.stringify({ hooks: { PreToolUse: [entry] } }, null, 2)}\n`;
    return { path: SETTINGS_PATH, kind: 'create', content, note: `Wrote ${SETTINGS_PATH}.` };
  }

  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    settings = parsed as Record<string, unknown>;
  } catch {
    return {
      path: SETTINGS_PATH,
      kind: 'keep',
      content: '',
      note: `${SETTINGS_PATH} could not be read as JSON, so it was left alone. Add the hook by hand, or move the file away.`,
    };
  }

  const hooks = { ...((settings.hooks as Record<string, unknown> | undefined) ?? {}) };
  const before = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as Record<string, unknown>[]) : [];
  const theirs = before.filter((row) => JSON.stringify(row).includes(GUARD_PATH) === false);
  hooks.PreToolUse = [...theirs, entry];

  const content = `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`;
  const kind = content === text ? 'unchanged' : 'replace';
  return { path: SETTINGS_PATH, kind, content, note: kind === 'replace' ? `Added the Nolzu hook to ${SETTINGS_PATH}.` : '' };
}

// An older Nolzu wrote its project text into WORKSPACE.md. AGENTS.md holds it now, so the
// file goes when it holds nothing else, and only Nolzu's section goes when the person wrote in it too.
// A WORKSPACE.md with no Nolzu section is the person's own file and is not touched.
export const OLD_WORKSPACE = 'WORKSPACE.md';

function planOldWorkspace(text: string | undefined): PlannedWrite | null {
  if (text === undefined) return null;
  const block = readBlock(text);
  if (block.broken || block.body === null) return null;
  const rest = withoutBlock(text);
  if (rest.trim() === '') return { path: OLD_WORKSPACE, kind: 'remove', content: '', note: `Removed ${OLD_WORKSPACE}. Its text is in AGENTS.md now.` };
  return { path: OLD_WORKSPACE, kind: 'replace', content: rest, note: `Took the Nolzu section out of ${OLD_WORKSPACE}, because AGENTS.md holds it now. Your own text stays there.` };
}

export function planProjectFiles(input: PlanInput): ProjectPlan {
  const { existing, pointerPath } = input;
  const refused: string[] = [];
  const writes: PlannedWrite[] = [planMarkdown('AGENTS.md', input.agents, existing, 'append')];
  const workspace = planOldWorkspace(existing[OLD_WORKSPACE]);
  if (workspace !== null) writes.push(workspace);

  if (leavesProject(pointerPath)) {
    refused.push(`${pointerPath} would be written outside the project, so it was not written.`);
  } else {
    writes.push(planMarkdown(pointerPath, input.pointer, existing, 'append'));
  }

  // The script itself, not only the settings that point at it. An empty file here would exit zero
  // for every call, which is a hook that refuses nothing.
  const guardNow = existing[GUARD_PATH];
  const guardKind = guardNow === undefined ? 'create' : guardNow === PHASE_GUARD ? 'unchanged' : 'replace';
  writes.push({
    path: GUARD_PATH,
    kind: guardKind,
    content: PHASE_GUARD,
    note: guardKind === 'unchanged' ? '' : 'Wrote the hook that keeps a read-only phase inside the card folder.',
  });
  writes.push(planSettings(existing));

  return { writes, dirs: ['.tasks', 'worktrees'], refused };
}
