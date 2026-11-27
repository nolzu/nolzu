import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { phaseInstructions } from './instructions.ts';
import { readFinishRules } from './text.ts';

const PHASES = ['refine', 'plan', 'implement', 'qa', 'wrapup', 'optimize', 'orient', 'learn-repo', 'assess'] as const;

const skillsDir = join(import.meta.dirname, '..', 'skills');
const fileOf = (phase: string, name: string): string => readFileSync(join(skillsDir, `nolzu-${phase}`, name), 'utf8');
// The skill without its frontmatter, read here by hand. The module under test does the same, so
// the two agree only while the module really reads the skill.
const bodyOf = (phase: string): string => fileOf(phase, 'SKILL.md').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
const linksOf = (phase: string): string[] => [...new Set([...bodyOf(phase).matchAll(/\]\(([\w.-]+\.md)\)/g)].map(([, name]) => name ?? ''))];

const textOf = (phase: string): string => {
  const text = phaseInstructions(phase);
  expect(text, `${phase} has no instructions`).not.toBeNull();
  return text ?? '';
};

describe.each(PHASES)('the %s phase', (phase) => {
  // The drift test. The text is the skill's own words, so a sentence added to the skill is in it
  // and a sentence deleted from the skill is gone from it. Nothing is written twice by hand.
  it('hands the engine the whole method the skill holds', () => {
    expect(textOf(phase)).toContain(bodyOf(phase));
  });

  // A link to a file next to the skill means nothing to an engine that was handed one text, so the
  // rules those links carry would be lost. Every phase links the finish rules at least.
  it('copies in the rules the skill only links to', () => {
    const links = linksOf(phase);

    expect(links.length).toBeGreaterThan(0);
    for (const name of links) expect(textOf(phase)).toContain(fileOf(phase, name).trim());
  });

  // Run together with no boundary, the finish rules read as the last step of the method. So the
  // text says a copied file is coming and gives each one its name. The test above, which asks for
  // at least one link, is what keeps that sentence true for every skill.
  it('marks every copied file off from the method', () => {
    const text = textOf(phase);

    expect(text).toContain('The files they link to are copied in at the end, each under its own name.');
    for (const name of linksOf(phase)) expect(text).toContain(`---\n\nLinked file: ${name}\n`);
  });

  it('leaves out the frontmatter, which only an engine that picks a skill reads', () => {
    expect(textOf(phase).startsWith('---')).toBe(false);
    expect(textOf(phase)).not.toContain(`name: nolzu-${phase}`);
  });

  it('follows the voice rules, because this text ships to a reader', () => {
    expect(textOf(phase)).not.toMatch(/—|–/);
    expect(textOf(phase)).not.toMatch(/delve|leverage|robust|seamless|elevate|unlock|comprehensive|ensure that/i);
  });
});

it('names the phase, so a file opened on its own says which run it belongs to', () => {
  expect(textOf('refine')).toContain('refine phase');
  expect(textOf('qa')).toContain('qa phase');
});

// The summary pass has no skill. Its prompt carries its rules itself, and a file written for it
// would be one nobody reads.
it('gives no instructions to a pass that has no skill', () => {
  expect(phaseInstructions('extract-summary')).toBeNull();
  expect(phaseInstructions('discuss')).toBeNull();
});

// The phase comes off a job, and it is pasted into a folder name here. A path that climbs would
// hand the run another phase's method, or a file that is no skill at all.
it('reads no file outside its own skill folder, whatever the phase is called', () => {
  expect(phaseInstructions('refine/../nolzu-qa')).toBeNull();
  expect(phaseInstructions('../../shared')).toBeNull();
  expect(phaseInstructions('')).toBeNull();
});

// A file the project changed wins, and a link the project has no copy of falls back to the shipped
// file, so an edit of the method alone still carries the finish rules.
it('takes the files the project changed, and the shipped copy of every other one', () => {
  const text = phaseInstructions('refine', (name) => (name === 'SKILL.md' ? { text: '---\nname: nolzu-refine\n---\nMy method. See [finish](finish.md) and [gone](gone.md).\n', folder: '.claude/skills' } : null)) ?? '';

  expect(text).toContain('My method.');
  expect(text).not.toContain(bodyOf('refine'));
  expect(text).toContain(`Linked file: finish.md\n\n${fileOf('refine', 'finish.md').trim()}`);
  // In neither folder, so there is nothing to copy in.
  expect(text).not.toContain('Linked file: gone.md');
  expect(text).toContain("They come from this project's own copy in .claude/skills/nolzu-refine, which");
});

it('says nothing about an own copy when the project changed no file', () => {
  expect(phaseInstructions('refine', () => null)).toBe(phaseInstructions('refine'));
  expect(textOf('refine')).not.toContain("this project's own copy");
});

// Claude Code has been seen cutting a long skill at 20,000 characters and losing the rules past the
// cut. Every skill that ships stays well under that, read whole, linked files and all, with 2,500 to
// spare. Plan and QA are the longest.
it.each(readdirSync(skillsDir).filter((name) => name.startsWith('nolzu-')))('keeps the %s instructions under 17,500 characters', (folder) => {
  expect(textOf(folder.replace(/^nolzu-/, '')).length).toBeLessThan(17_500);
});

// An engine run without Nolzu has only the skill, so the skill is what sends it to the project's own
// rules. Near the top, before the first section, so an engine that skims still meets it.
it.each(readdirSync(skillsDir).filter((name) => name.startsWith('nolzu-')))('points the %s skill at its own phase file', (folder) => {
  const phase = folder.replace(/^nolzu-/, '');
  const head = (bodyOf(phase).split('\n## ')[0] ?? '').replace(/\s+/g, ' ');

  expect(head).toContain(`\`.nolzu/phases/${phase}.md\``);
  // The same things the prompt block keeps fixed, so the skill and a Nolzu run's prompt never disagree.
  expect(head).toContain('It wins over this skill except on file names, headings, fields and ids.');
  expect(head).toContain('A Nolzu run has it in its prompt and need not open it.');
  expect(textOf(phase)).toContain(`\`.nolzu/phases/${phase}.md\``);
});

// The contract lives in one shared file, so a phase that stopped linking it would run without the
// review block, the evidence rule and the shell rule, and nothing else would say so.
it.each(readdirSync(skillsDir).filter((name) => name.startsWith('nolzu-')))('hands the %s phase the shared contract', (folder) => {
  expect(textOf(folder.replace(/^nolzu-/, ''))).toContain(`Linked file: finish.md\n\n${readFinishRules().trim()}`);
});
