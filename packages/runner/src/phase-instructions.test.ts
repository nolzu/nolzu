import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { INSTRUCTION_PHASES, PHASE_INSTRUCTIONS_CAP, phaseInstructionsFile, readPhaseInstructions, savePhaseInstructions } from './phase-instructions.ts';

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'nolzu-phase-instructions-'));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

it('offers every phase that starts a run, and not the summary pass', () => {
  expect(INSTRUCTION_PHASES).toContain('plan');
  expect(INSTRUCTION_PHASES).toContain('ask');
  expect(INSTRUCTION_PHASES).toContain('pr-review');
  expect(INSTRUCTION_PHASES).not.toContain('extract-summary');
});

it('reads nothing when the project has no file for the phase', () => {
  expect(readPhaseInstructions(project, 'plan')).toBeUndefined();
});

it('reads the file of the phase, and an empty one as none', () => {
  mkdirSync(join(project, '.nolzu', 'phases'), { recursive: true });
  writeFileSync(join(project, '.nolzu', 'phases', 'plan.md'), 'plan.md must also have a Risks section.\n');
  writeFileSync(join(project, '.nolzu', 'phases', 'qa.md'), '  \n');

  expect(readPhaseInstructions(project, 'plan')).toEqual({ text: 'plan.md must also have a Risks section.', cut: false });
  expect(readPhaseInstructions(project, 'qa')).toBeUndefined();
  expect(readPhaseInstructions(project, 'extract-summary')).toBeUndefined();
});

it('cuts a file longer than the cap and says so', () => {
  mkdirSync(join(project, '.nolzu', 'phases'), { recursive: true });
  // One plain byte first, so the cap falls inside a two-byte character.
  writeFileSync(join(project, '.nolzu', 'phases', 'plan.md'), `a${'é'.repeat(PHASE_INSTRUCTIONS_CAP)}`);

  const read = readPhaseInstructions(project, 'plan');

  expect(read?.cut).toBe(true);
  expect(Buffer.byteLength(read?.text ?? '')).toBeLessThanOrEqual(PHASE_INSTRUCTIONS_CAP);
  // Cut on a whole character, so no broken byte reaches the prompt.
  expect(read?.text).not.toContain('�');
});

it('keeps a file of exactly the cap whole', () => {
  mkdirSync(join(project, '.nolzu', 'phases'), { recursive: true });
  writeFileSync(join(project, '.nolzu', 'phases', 'plan.md'), 'x'.repeat(PHASE_INSTRUCTIONS_CAP));

  expect(readPhaseInstructions(project, 'plan')?.cut).toBe(false);
});

// A folder whose name only starts with the project's is still outside it.
it('reads nothing from a sibling folder whose name starts with the project name', () => {
  const sibling = `${project}-other`;
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'plan.md'), 'a secret');
  mkdirSync(join(project, '.nolzu'));
  symlinkSync(sibling, join(project, '.nolzu', 'phases'));

  expect(readPhaseInstructions(project, 'plan')).toBeUndefined();

  rmSync(sibling, { recursive: true, force: true });
});

// A cloned repository could point the folder anywhere on the machine, and the text goes into a prompt.
it('reads no file that resolves outside the project', () => {
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-outside-'));
  writeFileSync(join(outside, 'plan.md'), 'a secret');
  mkdirSync(join(project, '.nolzu'));
  symlinkSync(outside, join(project, '.nolzu', 'phases'));

  expect(readPhaseInstructions(project, 'plan')).toBeUndefined();
  expect(savePhaseInstructions(project, 'plan', 'new text')).toMatch(/outside the project folder/);
  expect(readFileSync(join(outside, 'plan.md'), 'utf8')).toBe('a secret');

  rmSync(outside, { recursive: true, force: true });
});

it('writes nothing through a file link that points at nothing yet', () => {
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-outside-'));
  mkdirSync(join(project, '.nolzu', 'phases'), { recursive: true });
  symlinkSync(join(outside, 'made.md'), join(project, '.nolzu', 'phases', 'plan.md'));

  expect(savePhaseInstructions(project, 'plan', 'new text')).toMatch(/outside the project folder/);
  expect(existsSync(join(outside, 'made.md'))).toBe(false);

  rmSync(outside, { recursive: true, force: true });
});

// A folder where the file should be would throw, and stop every run of the phase or the Save.
it('reads nothing from a folder named like the file, and says why it cannot save over one', () => {
  mkdirSync(join(project, '.nolzu', 'phases', 'plan.md'), { recursive: true });

  expect(readPhaseInstructions(project, 'plan')).toBeUndefined();
  expect(savePhaseInstructions(project, 'plan', 'new text')).toMatch(/^Nolzu could not write \.nolzu\/phases\/plan\.md: /);
  expect(savePhaseInstructions(project, 'plan', '')).toMatch(/^Nolzu could not write /);
});

it('writes the file, making the folder, and deletes it on an empty save', () => {
  expect(savePhaseInstructions(project, 'plan', 'Use my brainstorming skill first.')).toBeNull();
  expect(readFileSync(phaseInstructionsFile(project, 'plan'), 'utf8')).toBe('Use my brainstorming skill first.\n');

  expect(savePhaseInstructions(project, 'plan', '  \n')).toBeNull();
  expect(existsSync(phaseInstructionsFile(project, 'plan'))).toBe(false);
  // Deleting a file that is not there is no error either.
  expect(savePhaseInstructions(project, 'plan', '')).toBeNull();
});

it('refuses a phase Nolzu does not have, and a text over the cap', () => {
  expect(savePhaseInstructions(project, '../escape', 'text')).toBe('There is no phase ../escape.');
  expect(savePhaseInstructions(project, 'extract-summary', 'text')).toBe('There is no phase extract-summary.');
  expect(savePhaseInstructions(project, 'toString', 'text')).toBe('There is no phase toString.');
  expect(savePhaseInstructions(project, 'plan', 'x'.repeat(PHASE_INSTRUCTIONS_CAP + 1))).toMatch(/longer than 16 KB/);
  // The cap counts bytes, so fewer characters than the cap can still be too long.
  expect(savePhaseInstructions(project, 'plan', 'é'.repeat(PHASE_INSTRUCTIONS_CAP / 2 + 1))).toMatch(/longer than 16 KB/);
  expect(existsSync(join(project, '.nolzu'))).toBe(false);
  expect(savePhaseInstructions(join(project, 'gone'), 'plan', 'text')).toMatch(/is not there any more/);
  expect(existsSync(join(project, 'gone'))).toBe(false);
});
