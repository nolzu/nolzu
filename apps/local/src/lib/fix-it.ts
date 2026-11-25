import { type QaCheck, parseQaChecklist } from '@nolzu/ui/qa';

export interface FixInput {
  // The reason on QA's verdict line. Null when the run gave none.
  reason: string | null;
  // `qa/report.md` as the QA run left it, or null when there is none.
  report: string | null;
  // The image files in the card folder's `qa/` and `qa/evidence/`, by their path in the card folder.
  shots: readonly string[];
}

/**
 * What Fix it tells the Implement run, as the message of its resumed session or after the card in a
 * fresh prompt. Paths are named from the card folder, which both already know, so no path on this
 * machine reaches the engine.
 *
 * The qa skill starts a screenshot's name with its check's number, so the screenshot of a failed
 * check is the one Fix it names. A run since the evidence rules saves them in `qa/evidence/`, an older
 * one in `qa/`. A name with no number, such as one from a skill copy that predates the rule, cannot be
 * matched, so then every screenshot is named.
 */
export function fixMessage(input: FixInput): string {
  const checklist = input.report === null ? null : parseQaChecklist(input.report);
  const failed = (checklist?.rows ?? []).flatMap((row, at) => (row.result === 'fail' ? [{ number: at + 1, ...row }] : []));
  const own = input.shots.filter((path) => failed.some((row) => (path.split('/').pop() ?? '').startsWith(`${row.number}-`)));
  const shots = own.length > 0 ? own : input.shots;
  const named = shots.map((path) => `\`${path}\``).join(', ');
  // What went wrong, what should have happened, what did and what QA saw, each when QA wrote it. The
  // evidence can be saved output in `qa/evidence/`, which the screenshot list below leaves out.
  const under = (row: QaCheck) =>
    Object.entries({ Reason: row.reason, Expected: row.expected, Actual: row.actual, Evidence: row.evidence })
      .map(([label, value]) => (value == null ? '' : `\n   ${label}: ${value}`))
      .join('');

  return [
    'QA failed this card, and the person asked you to fix it. Fix what QA found, then finish the way the implement skill says. QA runs again after this run ends.',
    input.reason === null ? 'QA gave no reason.' : `QA said: ${input.reason}`,
    failed.length === 0 ? '' : ['The checks that failed:', ...failed.map((row) => `${row.number}. ${row.ac === undefined ? '' : `${row.ac}: `}${row.step}${under(row)}`)].join('\n'),
    shots.length === 0
      ? ''
      : own.length > 0
        ? `The screenshot of the failed check is in the card folder: ${named}. Open it to see what QA saw.`
        : `QA took these screenshots, in the card folder: ${named}. Open the one of the failed check to see what QA saw.`,
    input.report === null ? '' : "QA's whole report is `qa/report.md` in the card folder.",
  ]
    .filter((block) => block !== '')
    .join('\n\n');
}
