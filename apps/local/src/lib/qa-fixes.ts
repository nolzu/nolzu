import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StoredCardPull, StoredDiscussion } from '@nolzu/core/node';
import { readCardText, writeCardFile } from '@nolzu/runner';
import { parseQaChecklist } from '@nolzu/ui/qa';
import { discussionBlock } from './feedback.ts';

/**
 * QA the fixes on a Delivery card's PRs tab: a QA run over what the fixes for review comments changed,
 * while the card stays on Pull request. The scope goes in the run's message, the way Fix it tells
 * Implement what QA found, so the QA skill stays as it is. The run writes one report with everything
 * in it: the rows it did not run again are carried over, and one row per fixed comment is added.
 */

/** What QA the fixes tells the QA run, after the card. `since` is when the last QA with a verdict started. */
export function qaFixesMessage(rows: readonly StoredDiscussion[], pulls: readonly Pick<StoredCardPull, 'id' | 'repo' | 'number'>[], since: string | null): string {
  const last = since === null ? 'the last QA' : `the QA of ${since.slice(0, 10)}`;
  const example = rows[0]?.ref ?? 'T1';
  return [
    `This QA run checks the fixes made for review comments on this card's pull request, not the whole card again. ${rows.length === 1 ? 'One comment was' : `${rows.length} comments were`} fixed since ${last}:`,
    ...rows.map((row) => discussionBlock(row, pulls.find((one) => one.id === row.pull))),
    'To see what the fixes changed, run `git diff @{upstream}` in each repository of the card: that is the change since the reviewers read the pull request. Where a branch has no upstream, run `git diff HEAD`.',
    `Start from \`<card folder>/qa/report.md\`, the report of ${last}, and write the new report over it with everything together. Nolzu kept a copy of the old one in \`<card folder>/qa/history/\`.`,
    [
      "- Run the project's own checks again, as always.",
      '- Keep every row of section 2 in its place and with its number. Run a row again only when the fixes touch what it checks, and write its new result.',
      `- A row you do not run again keeps its result and its Evidence line, and its How line becomes \`How: from ${last}, the fixes do not touch it\`.`,
      `- After those rows, add one row per fixed comment, its step starting with the ref, such as \`${example}: The search ignores case now\`. It passes when what the reviewer asked for holds.`,
      "- A new screenshot for a row starts with that row's number, under a name not used before.",
      '- Section 1 and the verdict are about the whole report.',
    ].join('\n'),
    "When there is no report there, check the fixed comments and the project's own checks, and write the report with those rows.",
  ].join('\n\n');
}

/**
 * The rows a failed QA of the fixes sends back to new, each with QA's reason. A comment whose own row
 * failed goes back alone. When only other rows failed, such as the project's tests, every checked
 * comment goes back with the first failed check named, because the fixes are what changed.
 */
export function failedFixes(report: string | null, refs: readonly string[], reason: string | null): { ref: string; reason: string }[] {
  const failed = (report === null ? null : parseQaChecklist(report)?.rows)?.filter((row) => row.result === 'fail') ?? [];
  const own = failed.flatMap((row) => {
    const ref = /^(T\d+)\b/.exec(row.step)?.[1];
    if (ref === undefined || !refs.includes(ref)) return [];
    const said = [row.reason ?? row.step, ...(row.expected === undefined ? [] : [`Expected: ${row.expected}`]), ...(row.actual === undefined ? [] : [`Actual: ${row.actual}`])];
    return [{ ref, reason: `QA says: ${said.join('. ')}` }];
  });
  if (own.length > 0) return own;
  const named = failed[0] === undefined ? (reason ?? 'no check was named') : `${failed[0].step}${failed[0].reason === null ? '' : `, ${failed[0].reason}`}`;
  return refs.map((ref) => ({ ref, reason: `QA failed a check no comment names: ${named}` }));
}

/**
 * Keeps the QA report a run is about to write over, as `qa/history/report-<n>.md`, numbered from the
 * oldest. Skipped when there is none, and when it is the same as the newest copy, which is a run that
 * ended before it wrote a report. Answers the name it was kept under, or null.
 */
export function keepReport(qaDir: string): string | null {
  // `qaDir` is `<card folder>/qa`. Read and written inside the card folder only: a run can leave a link
  // at the report, and its copy would hand the run a file the wall hides from it.
  const card = dirname(qaDir);
  const report = readCardText(card, join('qa', 'report.md'));
  if (report === null) return null;
  const history = join(qaDir, 'history');
  const listed = lstatSync(history, { throwIfNoEntry: false })?.isDirectory() === true ? readdirSync(history) : [];
  const numbers = listed.flatMap((name) => {
    const found = /^report-(\d+)\.md$/.exec(name);
    return found === null ? [] : [Number(found[1])];
  });
  const last = numbers.length === 0 ? 0 : Math.max(...numbers);
  if (last > 0 && readCardText(card, join('qa', 'history', `report-${last}.md`)) === report) return null;
  const name = `report-${last + 1}.md`;
  writeCardFile(card, join('qa', 'history', name), report);
  return join('qa', 'history', name);
}
