import type { Decision, RefinedCriterion } from '@nolzu/protocol';

// One step of `plan/plan.md`: what it does, and the files it names.
export interface PlanStep {
  text: string;
  files: string[];
  // The acceptance checks of the brief the step serves, off its Covers line. Left out on a step with
  // no Covers line, which every plan written before the ids is, and on one that covers none.
  covers?: string[];
}

// The steps when the file follows the plan skill's form, or the file as written when it drifted, so a
// plan that does not parse still shows all it says.
export type PlanView = { steps: PlanStep[]; text: null } | { steps: null; text: string };

// A step starts at the edge of the line, as a numbered line or a heading, so an indented list inside
// a step is not read as the next step.
const STEP = /^(?:#{1,6}\s+)?(?:\*\*)?(?:step\s+)?(\d+)[.):]\s*(.*)$/i;
const FIELD = /^\s*(?:[-*]\s+)?\**(files?|uses|copy|tests?|checks?|undo|covers)\**\s*:\s*\**\s*(.*)$/i;
const HEADING = /^ {0,3}#{1,6}\s/;
const BULLET = /^\s+[-*]\s+(.*)$/;

// The paths in a Files value: the ones in backticks when there are any, else each comma part. A note
// after a path, such as "(new)" or ": the box", is not part of it, and a word with no dot or slash is
// not a path, which is how "none" reads as no file.
function pathsIn(value: string): string[] {
  const quoted = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
  return (quoted.length > 0 ? quoted : value.split(',')).flatMap((piece) => {
    const token = (piece.trim().split(/\s+/)[0] ?? '').replace(/[:;,]+$/, '').replace(/\.$/, '');
    return /[./]/.test(token) && !/^\.+$/.test(token) ? [token] : [];
  });
}

// The steps with the lines written under each one, or null when the file is empty or drifted.
function readSteps(source: string): (PlanStep & { lines: string[] })[] | null {
  const text = source.trim();
  if (text === '') return null;
  const steps: (PlanStep & { lines: string[] })[] = [];
  let field: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const step = STEP.exec(line);
    if (step !== null) {
      const words = (step[2] ?? '').replaceAll('**', '').trim();
      if (Number(step[1]) !== steps.length + 1 || words === '') return null;
      steps.push({ text: words, files: [], lines: [] });
      field = null;
      continue;
    }
    const last = steps.at(-1);
    if (last === undefined) continue;
    if (HEADING.test(line) || /^repositories\s*:/i.test(line)) break;
    last.lines.push(line);
    const named = FIELD.exec(line);
    if (named !== null) {
      field = (named[1] ?? '').toLowerCase().replace(/s$/, '');
      if (field === 'file') last.files.push(...pathsIn(named[2] ?? ''));
      if (field === 'cover') last.covers = [...(last.covers ?? []), ...[...(named[2] ?? '').matchAll(/\bAC\d+\b/gi)].map((id) => id[0].toUpperCase())];
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null && field === 'file') last.files.push(...pathsIn(bullet[1] ?? ''));
    else if (line.trim() !== '' && !/^\s/.test(line)) field = null;
  }
  return steps.length === 0 ? null : steps;
}

/**
 * Reads the steps of `plan/plan.md` in the form the plan skill teaches: a numbered line per step, its
 * fields under it. A title above the steps is skipped, and the first heading after them ends them, as
 * does the repositories line, so Risks and Order are never read as steps.
 *
 * A number out of order or a step with no words is a list the skill did not ask for, and the whole file
 * goes back as text. So does a file with no step at all.
 */
export function parsePlan(source: string): PlanView | null {
  const text = source.trim();
  if (text === '') return null;
  const steps = readSteps(text);
  return steps === null
    ? { steps: null, text }
    : { steps: steps.map(({ text, files, covers }) => ({ text, files, ...(covers === undefined || covers.length === 0 ? {} : { covers }) })), text: null };
}

// A field line such as "Files:" or "Covers:" at the step's own indent, which the body turns into a list
// item, so the fields do not run together into one paragraph when the Markdown is drawn.
const LABEL = /^\**[A-Za-z][A-Za-z ]{0,20}\**\s*:/;

// What an epic's documents hold for its tasks: the criteria of its brief and the decisions of its
// architecture and plan, read with `refinedCriteria` and `decisionLines`.
export interface EpicSeed {
  key: string;
  criteria: readonly RefinedCriterion[];
  decisions: readonly Decision[];
}

// The epic criteria a step covers and the decisions it names, each line under the epic's key, so the
// task's own AC1 never clashes with the epic's. An id the epic does
// not have is left out.
function seedOf(step: PlanStep & { lines: string[] }, epic: EpicSeed): string[] {
  const named = new Set([step.text, ...step.lines].join('\n').match(/\bD\d+\b/g) ?? []);
  const criteria = epic.criteria
    .filter((one) => step.covers?.includes(one.id))
    .map((one) => `- From ${epic.key}: ${one.id}${one.level === null ? '' : ` (${one.level})`}: ${one.text}${one.check === null ? '' : ` Check: ${one.check}`}`);
  return [...criteria, ...epic.decisions.filter((one) => named.has(one.id)).map((one) => `- From ${epic.key}: ${one.id}: ${one.text}`)];
}

/**
 * Each step of the plan as Markdown: its sentence, then the lines under it (Files, Tests, Undo, Covers)
 * as a list. An epic's task takes this as its description, with the epic's criteria and decisions the
 * step names copied under it when `epic` is given. Null when the plan has no steps to read.
 */
export function stepBodies(source: string, epic?: EpicSeed): string[] | null {
  return (
    readSteps(source)?.map((step) => {
      const lines = step.lines.join('\n').trim() === '' ? [] : step.lines;
      const indent = Math.min(...lines.filter((line) => line.trim() !== '').map((line) => /^\s*/.exec(line)?.[0].length ?? 0));
      const body = lines
        .map((line) => line.slice(Math.min(indent, line.length)).trimEnd())
        .map((line) => (LABEL.test(line) ? `- ${line}` : line))
        .join('\n')
        .trim();
      const seed = epic === undefined ? [] : seedOf(step, epic);
      return [step.text, body, seed.join('\n')].filter((part) => part !== '').join('\n\n');
    }) ?? null
  );
}

// One task of the plan an epic's Plan writes for colleagues, by the number of the step it stands for.
export interface ShareTask {
  title: string;
  description: string;
}

/**
 * The tasks of `share/PLAN.md`: each `### <n>. <title>` under `## Tasks`, with the text under it up to
 * the next heading, by its number. The number is the plan step's, so a task the file leaves out is not
 * there. A file with no `## Tasks` gives none.
 */
export function shareTasks(source: string): Map<number, ShareTask> {
  const tasks = new Map<number, ShareTask>();
  let inside = false;
  let current: { title: string; lines: string[] } | null = null;
  const close = (number: number | null) => {
    if (current !== null && number !== null && !tasks.has(number)) tasks.set(number, { title: current.title, description: current.lines.join('\n').trim() });
  };
  let number: number | null = null;
  for (const line of source.split(/\r?\n/)) {
    if (/^ {0,3}##\s/.test(line)) {
      close(number);
      current = null;
      number = null;
      inside = /^ {0,3}##\s+tasks\s*$/i.test(line);
      continue;
    }
    if (!inside) continue;
    const task = /^ {0,3}###\s+(\d+)[.):]?\s+(.*\S)\s*$/.exec(line);
    if (task !== null) {
      close(number);
      number = Number(task[1]);
      current = { title: (task[2] ?? '').replaceAll('**', '').trim(), lines: [] };
      continue;
    }
    if (/^ {0,3}#{1,6}\s/.test(line)) {
      close(number);
      current = null;
      number = null;
      continue;
    }
    current?.lines.push(line);
  }
  close(number);
  return tasks;
}
