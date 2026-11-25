import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillsFolder } from './project-files.ts';

// The frontmatter is how an engine picks a skill. An engine handed this text has nothing to pick,
// and the name and description would read as part of the method.
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
// A link to a file next to the skill, such as `](finish.md)`.
const LINK = /\]\(([\w.-]+\.md)\)/g;
// The phase names a folder, so it may be one plain word and nothing else.
const PLAIN = /^[a-z][a-z0-9-]*$/;

/**
 * The phase instructions a run is handed as a file, on every engine.
 *
 * Built from the skill that owns the phase, every time a run starts, so there is no second copy
 * to keep in step: a change to the skill is in the next run's text. The files the skill links to
 * are read from the same folder and copied in, because a relative link means nothing to an engine
 * that was handed one file.
 *
 * `own` answers with the person's text of a file in the skill folder and the project folder it came
 * from, such as `.agents/skills`, or null when the project has no edit of it. It is handed the text
 * Nolzu ships, so it can tell an edit from a copy. A file it answers for wins over the shipped one,
 * and every other file comes from the package.
 *
 * Null when no skill owns the phase. The summary pass is the one such pass, and its prompt
 * already carries the rules it follows.
 */
export function phaseInstructions(phase: string, own?: (name: string, shipped: string | null) => { text: string; folder: string } | null): string | null {
  if (!PLAIN.test(phase)) return null;
  const folder = join(skillsFolder(), `nolzu-${phase}`);
  if (!existsSync(join(folder, 'SKILL.md'))) return null;

  // The folders the edits came from, in the order they were read.
  const from = new Set<string>();
  // The person's text when there is one, the shipped text otherwise, and null when neither is there.
  const read = (name: string): string | null => {
    const shipped = existsSync(join(folder, name)) ? readFileSync(join(folder, name), 'utf8') : null;
    const theirs = own?.(name, shipped) ?? null;
    if (theirs !== null) from.add(`${theirs.folder}/nolzu-${phase}`);
    return theirs?.text ?? shipped;
  };

  const body = (read('SKILL.md') ?? '').replace(FRONTMATTER, '').trim();
  // Every link in a shipped skill resolves, because `pnpm skills:lint` and the test that runs it
  // over this folder refuse one that does not. A link only the person's skill has, to a file that is
  // in neither folder, is left out: the run cannot read it either way.
  const linked = [...new Set([...body.matchAll(LINK)].flatMap(([, name]) => name ?? []))].flatMap((name) => {
    const text = read(name);
    return text === null ? [] : [{ name, text }];
  });

  return `${[
    `These are the instructions for the ${phase} phase of this run. Follow them.`,
    // A person who reads the card folder sees whose method the run had.
    ...(from.size > 0 ? [`They come from this project's own copy in ${[...from].join(' and ')}, which someone changed, and not from the one Nolzu ships.`] : []),
    'The files they link to are copied in at the end, each under its own name.',
    body,
    ...linked.flatMap(({ name, text }) => ['---', `Linked file: ${name}`, text.trim()]),
  ].join('\n\n')}\n`;
}
