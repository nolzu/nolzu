import type { ScoutMuteAnswer } from './scout-findings.ts';

/**
 * The five parts of an assessment, read back out of the file the run wrote.
 *
 * The assess skill writes one heading for each. There is no
 * column for them: the file lives in the run's own folder like every other phase artifact, and the
 * run row already carries the state, the cost and the log path. A column would be a migration and a
 * second copy of the same text, so it waits until a screen needs the words without reading the disk.
 */
export interface Assessment {
  evidence: string;
  cause: string;
  proposal: string;
  effort: string;
  risks: string;
}

// The heading each part is written under, in the order the file holds them. The skill names the same
// five, and a test measures the skill against this list, so neither can drift away alone.
const PARTS = [
  { field: 'evidence', heading: 'The evidence' },
  { field: 'cause', heading: 'The likely cause' },
  { field: 'proposal', heading: 'The proposal' },
  { field: 'effort', heading: 'The effort' },
  { field: 'risks', heading: 'The risks' },
] as const;

export type AssessmentRead = { ok: true; parts: Assessment } | { ok: false; problem: string };

/**
 * The assessment a run wrote, or the reason it cannot be read.
 *
 * All five parts or none of them. Half an assessment reads as an answer while it is missing the very
 * part a person decides on, so a file with a section missing or empty is refused with a sentence
 * naming that section, and nothing is kept.
 */
export function readAssessment(text: string): AssessmentRead {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  const close = (): void => {
    if (heading !== null) sections.set(heading, body.join('\n').trim());
    body = [];
  };

  for (const line of text.split('\n')) {
    // Any heading level, because a model that writes `###` where the skill asked for `##` still
    // answered the question, and refusing that would waste a run over one character.
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match === null) {
      body.push(line);
      continue;
    }
    close();
    heading = (match[1] ?? '').toLowerCase();
  }
  close();

  const parts: Partial<Assessment> = {};
  for (const part of PARTS) {
    const found = sections.get(part.heading.toLowerCase());
    if (found === undefined) {
      return { ok: false, problem: `The assessment has no "${part.heading}" section, so there is nothing to read under it. Start the assessment again.` };
    }
    if (found === '') {
      return { ok: false, problem: `The "${part.heading}" section of the assessment is empty, so it answers nothing. Start the assessment again.` };
    }
    parts[part.field] = found;
  }
  // Every field was filled, or the loop above returned the sentence instead.
  return { ok: true, parts: parts as Assessment };
}

/** The headings an assessment is read by, so the skill can be measured against them. */
export const ASSESSMENT_HEADINGS: readonly string[] = PARTS.map((part) => part.heading);

// What the Assess form posts, and what starts the run. The loop throws the reason a run cannot
// start, because a finding has no card for a board to carry a failure on.
export interface AssessPost {
  assess: (findingId: number) => boolean;
}

/**
 * Start an assessment of one finding.
 *
 * A sentence and never a throw, the way Dismiss and Unmute answer on this screen: the finding may
 * have gone with its source in another tab, and the person still has to read why their button did
 * nothing.
 */
export function answerAssess(live: AssessPost, form: FormData): ScoutMuteAnswer {
  const typed = (form.get('id')?.toString() ?? '').trim();
  // A blank or a word is not finding 0, which is what Number() would look up.
  if (!/^\d+$/.test(typed)) return { ok: false, message: 'That button posted no finding id. Load the Scout screen again and press it once more.' };

  try {
    // False means the job was built and the run row then failed. Its reason sits on a row no screen
    // shows, because the board carries runs by card and this run has no card.
    if (!live.assess(Number(typed))) {
      return { ok: false, message: `The assessment of finding ${typed} did not start, so nothing was read. Try it again.` };
    }
    return { ok: true, message: `An assessment of finding ${typed} is running. It reads and writes what it found, and changes nothing.` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
