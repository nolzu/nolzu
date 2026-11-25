// The two lines the runtime contract asks every run to print. They live here because three
// places have to agree on them: the contract appended to the prompt, the rule text inside
// each pipeline skill, and the parser that reads the stream. Protocol is the only package
// all three may import.
export const SENTINEL_COMPLETE = 'NOLZU: complete';

export const NEEDS_INPUT_PREFIX = 'NOLZU: needs_input: ';

export function needsInputLine(question: string): string {
  // The parser reads the stream line by line, so a question spanning lines would arrive cut
  // in half. Folding it here means the caller cannot produce a sentinel the parser misses.
  return NEEDS_INPUT_PREFIX + question.trim().replace(/\s*\n\s*/g, ' ');
}

// The file in the phase folder where a run that asks lists the answers it offers. The finish rules in
// the skills name it and the loop reads it, so the name sits here beside the line it goes with.
export const QUESTION_FILE = 'question.md';

// One answer the agent offered with its question, and what that answer means for the work.
export interface QuestionOption {
  label: string;
  means: string;
}

// The QA verdict, which is not a sentinel but lives here for the same reason: the rule text
// inside the qa skill and the parser that reads the run have to agree on the wording.
// `--output-format json` structures the envelope only, so the verdict arrives as text and
// nothing else. A run that leaves the line out is left for a person, and no pass goes looking.
export const VERDICT_PREFIX = 'NOLZU: verdict: ';

// PASS chains the card forward. FAIL leaves it for a person. BLOCKED means QA could not run
// far enough to judge, which is a question rather than a result.
export const VERDICTS = ['PASS', 'FAIL', 'BLOCKED'] as const;

export type Verdict = (typeof VERDICTS)[number];
