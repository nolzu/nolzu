import { execFileSync } from 'node:child_process';
import { ACTIONS, PRESET_NAMES, presetModels, presetRows } from '@nolzu/core';
import { claudeModels, codexModels, parseCodexModels, parseCursorModels } from '@nolzu/runner';
import { describe, expect, it } from 'vitest';

/**
 * The built-in rows of each vendor, measured against what that vendor's own command printed.
 *
 * A preset naming a model the engine does not offer ships a board whose drop says the model is gone
 * before anybody changed a setting. Core cannot run a binary and the runner cannot import core, so
 * the two meet here.
 *
 * The texts below are cut from real output on 2026-09-25, from `codex debug models --bundled`,
 * and `cursor-agent --list-models`, and each is read by the parser the adapter itself uses. A
 * vendor that changes its list changes this file, which is the point: the change is then seen here
 * and not by a person whose drop was refused.
 */
const CODEX_LISTED = JSON.stringify({
  models: [
    { slug: 'gpt-5.6-sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }], visibility: 'list' },
    { slug: 'gpt-5.6-terra', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }], visibility: 'list' },
    { slug: 'gpt-5.6-luna', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }], visibility: 'list' },
    { slug: 'gpt-5.5', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], visibility: 'list' },
    { slug: 'gpt-5.4-mini', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], visibility: 'hide' },
  ],
});

const CURSOR_LISTED = [
  '\u001B[2mAvailable models\u001B[22m',
  '',
  '\u001B[32mauto\u001B[39m \u001B[2m- Auto\u001B[22m\u001B[2m (current, default)\u001B[22m',
  '\u001B[36mgpt-5.3-codex\u001B[39m \u001B[2m- Codex 5.3\u001B[22m',
  '\u001B[36mcomposer-2.5\u001B[39m \u001B[2m- Composer 2.5\u001B[22m',
  '\u001B[36mclaude-opus-5-5-high\u001B[39m \u001B[2m- Claude Opus 5.5 1M High\u001B[22m',
  '\u001B[36mgpt-5.2\u001B[39m \u001B[2m- GPT-5.2\u001B[22m',
].join('\n');

describe('every built-in row names a model its own vendor offers', () => {
  it('Claude Code', () => {
    for (const model of presetModels('claude-code')) expect(claudeModels()).toContain(model);
  });

  it('Codex', () => {
    const listed = parseCodexModels(CODEX_LISTED).filter((one) => !one.hidden);
    for (const model of presetModels('codex')) expect(listed.map((one) => one.slug)).toContain(model);
  });

  it('Cursor', () => {
    for (const model of presetModels('cursor')) expect(parseCursorModels(CURSOR_LISTED)).toContain(model);
  });

});

// Codex takes the effort as a separate config override, and the levels differ per model. An effort
// that model does not take would be passed to the binary and refused there.
it('gives every Codex row an effort that its own model takes', () => {
  const levels = new Map(parseCodexModels(CODEX_LISTED).map((one) => [one.slug, one.levels]));

  for (const preset of PRESET_NAMES) {
    for (const action of ACTIONS) {
      const row = presetRows(preset, 'codex')[action];
      expect(levels.get(row.model), `${preset} ${action}`).toContain(row.effort);
    }
  }
});

/**
 * The same question asked of the Codex binary itself, on a machine that has it.
 *
 * The texts above are a snapshot: a vendor that renames a model does not fail them until somebody
 * refreshes the snapshot. This one asks the command, so a rename fails the suite on a machine with
 * the CLI. Without it the test is skipped and nothing here proves the rows against a real list.
 *
 * Cursor gets no such test. Its list is a network call under the person's login, and the suite runs
 * with a scratch HOME, so `cursor-agent --list-models` answers with nothing here. The Cursor rows
 * were read off that command by hand on 2026-09-25 and are only measured against the text above.
 */
const installed = (binary: string): boolean => {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

it.skipIf(!installed('codex'))('names Codex models the installed Codex CLI offers', () => {
  const offered = codexModels('codex', process.env);

  expect(offered.length).toBeGreaterThan(0);
  for (const model of presetModels('codex')) expect(offered).toContain(model);
});
