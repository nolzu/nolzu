import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PHASE_POLICIES } from '@nolzu/core';
import { buildPrompt } from '@nolzu/runner';
import { phaseInstructions } from '@nolzu/skills';
import { expect, it } from 'vitest';

// The prompt opens by naming the instructions file, which the run writes from the phase's skill, and
// the skills live in another package that the runner may not import. This is where both can be seen,
// so a phase cannot point a run at a skill nobody wrote.
const skills = new URL('../../../../packages/skills/skills/', import.meta.url);

it.each(Object.keys(PHASE_POLICIES))('opens the %s prompt with the method file of a skill that exists', (phase) => {
  const first = buildPrompt({ phase, key: 'APP-1', title: 'A card', ticket: '', extra: '', readOnly: true, folder: '.tasks/APP-1' }).split('\n')[0] ?? '';

  expect(first).toBe(`Read \`.tasks/APP-1/${phase}/instructions.md\` first. It holds the method for this phase, and this run follows it.`);
  expect(existsSync(new URL(`nolzu-${phase}/SKILL.md`, skills))).toBe(true);
});

// The other half of the same pair. A phase added to the table with no skill behind it would start a
// run with the card and no method at all.
it.each(Object.keys(PHASE_POLICIES))('has phase instructions to hand a %s run', (phase) => {
  const text = phaseInstructions(phase) ?? '';

  expect(text).toContain(`${phase} phase`);
  expect(text).toContain('NOLZU: complete');
});

/**
 * The other direction, so the pair cannot drift either way.
 *
 * A skill folder with no row in the policy table is a method nothing can run: `policyFor` throws
 * for a phase it does not hold, which is how write access is granted here and nowhere else.
 */
it('gives every skill that ships a row in the policy table', () => {
  // Folders, and every one of them, so a folder named another way is compared rather than filtered
  // out of the question. A file in that folder is not a skill and is left alone.
  const folders = readdirSync(fileURLToPath(skills), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.replace(/^nolzu-/, ''));

  expect(folders.sort()).toEqual(Object.keys(PHASE_POLICIES).sort());
});
