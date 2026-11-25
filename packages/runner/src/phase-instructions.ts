import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { ACTIONS } from '@nolzu/core';
import { isPass } from '@nolzu/protocol';

// A project's own instructions for one phase, kept in the project so they are versioned with it and a
// teammate who clones it has them too, the way the knowledge folder is. Nolzu puts the text into the
// prompt itself, so it works the same on every engine. Each shipped skill also points at the file,
// for a person who runs an engine without Nolzu.

// The phases a project can write instructions for: every action that starts a run with a prompt. The
// summary pass is left out, because nobody picks it and its prompt is not a phase's.
export const INSTRUCTION_PHASES: readonly string[] = ACTIONS.filter((action) => !isPass(action));

// Large enough for a page of rules, small enough that a pasted log cannot fill the prompt.
export const PHASE_INSTRUCTIONS_CAP = 16 * 1024;

// Relative to the project folder, with forward slashes, as the settings screen shows it.
export const phaseInstructionsPath = (phase: string): string => `.nolzu/phases/${phase}.md`;

export const phaseInstructionsFile = (project: string, phase: string): string => join(project, '.nolzu', 'phases', `${phase}.md`);

// A cloned repository can make `.nolzu/phases` a link to anywhere on the machine. Reading through it
// would put a file the wall hides into the prompt, and writing through it would change that file.
// A link that points at nothing resolves to nothing, and counts as outside.
function inside(project: string, path: string): boolean {
  try {
    return realpathSync(path).startsWith(realpathSync(project) + sep);
  } catch {
    return false;
  }
}

// There as a name, a link that points at nothing included: writing through that link would make its target.
const named = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/**
 * The project's instructions for this phase, or undefined when there are none.
 *
 * Read from the project folder on every run, never from a card's checkout, so an edit applies to the
 * next run at once. A file over the cap is cut on a whole character and says it was cut.
 */
export function readPhaseInstructions(project: string, phase: string): { text: string; cut: boolean } | undefined {
  if (!INSTRUCTION_PHASES.includes(phase)) return undefined;
  const file = phaseInstructionsFile(project, phase);
  // A folder by that name would throw on read and stop every run of the phase.
  if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true || !inside(project, file)) return undefined;
  const bytes = readFileSync(file);
  const cut = bytes.length > PHASE_INSTRUCTIONS_CAP;
  // A cut through a character decodes to the replacement sign, which is dropped.
  const text = bytes.subarray(0, PHASE_INSTRUCTIONS_CAP).toString('utf8').replace(/�+$/, '').trim();
  return text === '' ? undefined : { text, cut };
}

/**
 * Writes the project's instructions for one phase, or deletes the file when the text is empty. Null
 * when it saved, else the sentence that says why not.
 */
export function savePhaseInstructions(project: string, phase: string, text: string): string | null {
  if (!INSTRUCTION_PHASES.includes(phase)) return `There is no phase ${phase}.`;
  const body = text.replace(/\r\n/g, '\n').trim();
  if (Buffer.byteLength(body) > PHASE_INSTRUCTIONS_CAP) return 'These instructions are longer than 16 KB. Make them shorter, because a run reads only the first 16 KB.';
  // A moved project folder would be made again, empty, around the one file.
  if (!existsSync(project)) return `The project folder ${project} is not there any more.`;
  const file = phaseInstructionsFile(project, phase);
  // Each step of the way is checked before anything is made, so a link cannot get a folder made
  // outside either.
  if ([join(project, '.nolzu'), dirname(file), file].some((path) => named(path) && !inside(project, path))) {
    return `${phaseInstructionsPath(phase)} points outside the project folder, so Nolzu leaves it alone.`;
  }
  // A folder by that name, or a file Nolzu may not write, is a sentence under the box and not a crash.
  try {
    if (body === '') {
      rmSync(file, { force: true });
      return null;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${body}\n`);
    return null;
  } catch (cause) {
    return `Nolzu could not write ${phaseInstructionsPath(phase)}: ${(cause as Error).message}`;
  }
}
