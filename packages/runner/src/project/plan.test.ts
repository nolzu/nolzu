import { expect, it } from 'vitest';
import { readBlock } from './markers.ts';
import { GUARD_PATH, guardSettings, type PlanInput, type PlannedWrite, planProjectFiles, type ProjectPlan } from './plan.ts';

const input = (existing: Record<string, string> = {}, pointerPath = 'CLAUDE.md'): PlanInput => ({
  existing,
  agents: 'How an agent works here.',
  pointer: 'Read AGENTS.md first.',
  pointerPath,
});

const at = (plan: ProjectPlan, path: string): PlannedWrite | undefined =>
  plan.writes.find((write) => write.path === path);

it('plans every file and both folders in an empty project', () => {
  const plan = planProjectFiles(input());

  // The guard script is written too. Settings that point at a file nobody wrote would refuse
  // every tool call in a read-only phase.
  expect(plan.writes.map((write) => write.path).sort()).toEqual(
    ['.claude/hooks/nolzu-phase-guard.mjs', '.claude/settings.json', 'AGENTS.md', 'CLAUDE.md'].sort(),
  );
  expect(plan.writes.every((write) => write.kind === 'create')).toBe(true);
  // The guard has to be the real script. An empty file exits zero for every call, so a plan that
  // wrote one would look complete and refuse nothing.
  const guard = at(plan, '.claude/hooks/nolzu-phase-guard.mjs');
  expect(guard?.content).toContain('NOLZU_TASK_DIR');
  expect(guard?.content).toContain('process.exit(2)');
  expect([...plan.dirs].sort()).toEqual(['.tasks', 'worktrees']);
  expect(plan.refused).toEqual([]);
});

// Agent rules can be added to. The block goes after what the team wrote, and the summary says so,
// because a person who never asked for it should be told.
it('appends to an AGENTS.md nobody marked, and says so', () => {
  const theirs = '# AGENTS.md\n\nRun the tests before you finish.\n';
  const plan = planProjectFiles(input({ 'AGENTS.md': theirs }));
  const write = at(plan, 'AGENTS.md');

  expect(write?.kind).toBe('append');
  expect(write?.content.startsWith(theirs)).toBe(true);
  expect(readBlock(write?.content ?? '').body).toBe('How an agent works here.');
  expect(write?.note).not.toBe('');
});

// AGENTS.md holds the project text now. A WORKSPACE.md an older Nolzu wrote goes when it holds
// nothing else, loses only Nolzu's section when the person wrote in it, and one with no section is the
// person's own file, never touched.
it('folds an older WORKSPACE.md into AGENTS.md', () => {
  const ours = '<!-- nolzu:start -->\n# This project and Nolzu\n<!-- nolzu:end -->\n';
  expect(at(planProjectFiles(input({ 'WORKSPACE.md': ours })), 'WORKSPACE.md')).toMatchObject({ kind: 'remove', note: 'Removed WORKSPACE.md. Its text is in AGENTS.md now.' });

  const mixed = '# Workspace\n\nTwo services and a database.\n\n<!-- nolzu:start -->\nOld words.\n<!-- nolzu:end -->\n';
  const kept = at(planProjectFiles(input({ 'WORKSPACE.md': mixed })), 'WORKSPACE.md');
  expect(kept?.kind).toBe('replace');
  expect(kept?.content).toBe('# Workspace\n\nTwo services and a database.\n');

  expect(at(planProjectFiles(input({ 'WORKSPACE.md': '# Workspace\n\nTwo services.\n' })), 'WORKSPACE.md')).toBeUndefined();
  expect(at(planProjectFiles(input({ 'WORKSPACE.md': '<!-- nolzu:start -->\nhalf\n' })), 'WORKSPACE.md')).toBeUndefined();
});

it('replaces only the block in a file that carries one', () => {
  const theirs = '# AGENTS.md\n\nTheirs.\n\n<!-- nolzu:start -->\nOld words.\n<!-- nolzu:end -->\n\nAfter.\n';
  const plan = planProjectFiles(input({ 'AGENTS.md': theirs }));
  const write = at(plan, 'AGENTS.md');

  expect(write?.kind).toBe('replace');
  expect(write?.content).toContain('Theirs.');
  expect(write?.content).toContain('After.');
  expect(write?.content).not.toContain('Old words.');
});

it('plans no change when the block already says what it should', () => {
  const settled = '# AGENTS.md\n\nTheirs.\n\n<!-- nolzu:start -->\nHow an agent works here.\n<!-- nolzu:end -->\n';
  const plan = planProjectFiles(input({ 'AGENTS.md': settled }));

  expect(at(plan, 'AGENTS.md')?.kind).toBe('unchanged');
});

it('refuses a pointer file that would be written outside the project', () => {
  const plan = planProjectFiles(input({}, '../CLAUDE.md'));

  expect(at(plan, '../CLAUDE.md')).toBeUndefined();
  expect(plan.refused.join(' ')).toContain('../CLAUDE.md');
});

it('refuses an absolute pointer path as well', () => {
  const plan = planProjectFiles(input({}, '/etc/CLAUDE.md'));

  expect(plan.refused.join(' ')).toContain('/etc/CLAUDE.md');
});

it('writes settings with the guard when the project has none', () => {
  const plan = planProjectFiles(input());
  const write = at(plan, '.claude/settings.json');
  const settings = JSON.parse(write?.content ?? '{}') as { hooks?: { PreToolUse?: unknown[] } };

  expect(write?.kind).toBe('create');
  expect(settings.hooks?.PreToolUse).toHaveLength(1);
});

// A run works in the card's checkout, and measured on Claude Code 2.1.278 that checkout is both what
// the project settings are read from and what CLAUDE_PROJECT_DIR points at. The project's own file
// is in the checkout only if the person committed it, so the run is handed this one instead.
it('writes a settings file that names the guard by its full path, for a run outside the project', () => {
  const settings = JSON.parse(guardSettings('/home/you/recipes')) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
  const entry = settings.hooks.PreToolUse[0];

  expect(entry?.matcher).toBe('Write|Edit|NotebookEdit|Bash');
  expect(entry?.hooks[0]?.command).toBe(`node ${JSON.stringify(`/home/you/recipes/${GUARD_PATH}`)}`);
  expect(entry?.hooks[0]?.command).not.toContain('CLAUDE_PROJECT_DIR');
});

// Every run starts inside Nolzu's wall, and a sandbox the person turned on would nest inside it.
it('turns Claude Code\'s own sandbox off in the settings file a run is handed', () => {
  expect((JSON.parse(guardSettings('/home/you/recipes')) as { sandbox?: unknown }).sandbox).toEqual({ enabled: false });
});

// A pull request text from a run once ended on Claude Code's own line. The file every run is handed
// turns that line off, for commits and pull requests both.
it('turns Claude Code\'s attribution off in the settings file a run is handed', () => {
  const settings = JSON.parse(guardSettings('/home/you/recipes')) as { attribution?: unknown; includeCoAuthoredBy?: unknown };

  expect(settings.attribution).toEqual({ commit: '', pr: '' });
  expect(settings.includeCoAuthoredBy).toBe(false);
  // A project with no guard file gets the same file with no hook in it.
  const bare = JSON.parse(guardSettings(null)) as { attribution?: unknown; hooks?: unknown };
  expect(bare.attribution).toEqual({ commit: '', pr: '' });
  expect(bare.hooks).toBeUndefined();
});

// The same hook as the project's own file, so a card run and a person's own session are held to one rule.
it('holds the same tools as the hook written into the project', () => {
  const outside = JSON.parse(guardSettings('/home/you/recipes')) as { hooks: { PreToolUse: { matcher: string }[] } };
  const inside = JSON.parse(at(planProjectFiles(input()), '.claude/settings.json')?.content ?? '{}') as { hooks: { PreToolUse: { matcher: string }[] } };

  expect(outside.hooks.PreToolUse[0]?.matcher).toBe(inside.hooks.PreToolUse[0]?.matcher);
});

// JSON carries no comment, so there is no marker to own a block with. Nolzu owns its own hook
// entry and leaves every other key exactly as it found it.
it('keeps the settings a project already has', () => {
  const theirs = JSON.stringify({ model: 'opus', hooks: { PostToolUse: [{ matcher: 'Bash' }] } }, null, 2);
  const plan = planProjectFiles(input({ '.claude/settings.json': theirs }));
  const write = at(plan, '.claude/settings.json');
  const settings = JSON.parse(write?.content ?? '{}') as Record<string, unknown> & {
    hooks?: { PreToolUse?: unknown[]; PostToolUse?: unknown[] };
  };

  expect(settings.model).toBe('opus');
  expect(settings.hooks?.PostToolUse).toHaveLength(1);
  expect(settings.hooks?.PreToolUse).toHaveLength(1);
});

// Settings that do not parse are somebody's broken file, not an empty one. Writing over them
// would throw away every setting they hold.
it('keeps settings that do not parse, rather than replacing them', () => {
  const plan = planProjectFiles(input({ '.claude/settings.json': '{ "model": "opus",,, }' }));
  const write = at(plan, '.claude/settings.json');

  expect(write?.kind).toBe('keep');
  expect(write?.note).not.toBe('');
});
