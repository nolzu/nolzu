import { frontmatterDescription, frontmatterEnd, frontmatterPaths, isBlocking, parseRound, refinedCriteria, type RefinedQuestion, refinedQuestions, ROUND_LABELS } from '@nolzu/protocol';
import { noteFolder, REPO_FILE, RUN_RECIPE_FILE } from './knowledge.ts';

// The output check: what a phase wrote, read as text, against what its skill promises. Core reads no
// project file, so the caller hands over the files by their path in the card folder. A problem is a
// warning on the run and never blocks a move.
//
// It checks what today's skills already promise. A later format adds its rule to OUTPUT_RULES,
// or a check of its own to a file's `checks`.

export interface OutputProblem {
  file: string;
  problem: string;
}

// What a run stores. A null note when nothing is wrong or the phase had no project instructions.
export interface OutputCheck {
  problems: OutputProblem[];
  note: string | null;
}

type Files = Readonly<Record<string, string>>;

interface FileRule {
  file: string;
  // Any file whose path matches counts, and the highest round is the one checked. The review rounds
  // are the one case.
  match?: RegExp;
  // The heading of the review block, when it is not "## Before you approve".
  block?: string;
  // Second-level headings that must be there, each with something under it.
  headings?: readonly string[];
  // Checks of this file's text, with every file handed over for the ones that read another phase.
  checks?: readonly ((text: string, files: Files) => string[])[];
  // The file is held to only on this board, as the plan for other people is on an epic.
  board?: string;
}

interface PhaseRules {
  // The main file first: the line limit and the review block apply to it.
  files: readonly FileRule[];
  // Files of earlier phases the checks read, so the caller hands them over.
  reads?: readonly string[];
  // The phase writes knowledge, and the caller hands over each note it added or changed as
  // `knowledge/<path in the folder>`.
  knowledge?: true;
  // Rules of this phase's own for the notes it handed over, beside the ones every note follows.
  notes?: (files: Files) => OutputProblem[];
}

const MAIN_FILE_LINES = 300;
const REVIEW_BLOCK = '## Before you approve';
const REVIEW_BLOCK_LINES = 15;

// The text under a second-level heading, up to the next one. Null when the heading is not there. Case
// and spacing do not count, because the pages that read these files ignore them too.
const sameHeading = (line: string, heading: string) => line.trim().replace(/\s+/g, ' ').toLowerCase() === heading.toLowerCase();

function section(text: string, heading: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => sameHeading(line, heading));
  if (start === -1) return null;
  const end = lines.findIndex((line, at) => at > start && /^#{1,2} /.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

const secondLevel = (text: string) => text.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.trimEnd());

// The top-level list items of a section, bullets and numbered lines alike. An indented line belongs
// to the item above it.
const items = (body: string) => body.split('\n').filter((line) => /^([-*]|\d+\.) /.test(line));

const criteria = (refined: string | undefined) => (refined === undefined ? null : idsIn(section(refined, '## Acceptance checks') ?? '', 'AC'));

function idsIn(body: string, prefix: string): string[] {
  const pattern = new RegExp(`^(?:[-*]|\\d+\\.) (${prefix}\\d+)\\b`);
  return items(body).flatMap((line) => pattern.exec(line)?.[1] ?? []);
}

// An id after another card's key, such as "APP-5 AC2" on a task of that epic or "From APP-5: AC2" as
// its ticket copies it, is that card's own.
const cites = (text: string) => [...new Set(text.match(/(?<![A-Z][A-Z0-9]*-\d+:? )\bAC\d+\b/g) ?? [])];

const usedTwice = (ids: readonly string[]) => [...new Set(ids.filter((id, at) => ids.indexOf(id) !== at))].map((id) => `The id ${id} is used twice.`);

// An id line keeps its id up front, and an id never repeats, because later phases cite them.
const idRule = (heading: string, prefix: string) => (text: string) => {
  const body = section(text, heading);
  if (body === null) return [];
  const pattern = new RegExp(`^(?:[-*]|\\d+\\.) ${prefix}\\d+\\b`);
  const broken = items(body)
    .filter((line) => !pattern.test(line))
    .map((line) => `A line under "${heading}" does not start with its id (${prefix}1, ${prefix}2 and on): "${line}"`);
  return [...broken, ...usedTwice(idsIn(body, prefix))];
};

// Each criterion carries its level and the way it is proved, because QA passes a card on its `must`
// criteria only.
const criterionParts = (text: string) =>
  refinedCriteria(text).flatMap((one) => [
    ...(one.level === null ? [`${one.id} has no level after its id, (must) or (should).`] : []),
    ...(one.check === null ? [`${one.id} has no "Check:" line under it.`] : []),
  ]);

// At most three questions, each with the default the next phase builds on and whether it blocks, which
// the gate reads to force a choice.
const MAX_QUESTIONS = 3;
const questionParts = (heading: string) => (text: string) => askedWell(refinedQuestions(text, heading));
function askedWell(questions: RefinedQuestion[], max = MAX_QUESTIONS): string[] {
  const problems = questions.length > max ? [`There are ${questions.length} open questions, more than ${max}. A fourth becomes an assumption with its default.`] : [];
  for (const one of questions) {
    const name = one.id ?? `"${one.question}"`;
    if (one.answer === null) problems.push(`The question ${name} names no "Default:".`);
    if (one.blocks === null) problems.push(`The question ${name} does not end with "blocks: yes" or "blocks: no".`);
  }
  return problems;
}

// The commit the phase read, so a later phase can see the code moved since.
const readAt = (heading: string) => (text: string) => ((section(text, heading) ?? '').split('\n').some((line) => /^read at:/i.test(line.trim())) ? [] : [`"${heading}" has no "Read at:" line.`]);

// A decision says what it turned down, because a reader who knows why a door was closed can reopen it.
const turnedDown = (text: string) =>
  items(section(text, '## The decisions') ?? '').flatMap((line) => {
    const id = /^[-*] (D\d+)\b/.exec(line)?.[1];
    return id === undefined || /\bNot:/.test(line) ? [] : [`The decision ${id} names no option turned down, "Not:".`];
  });

// The plan settles each open question by its id, so the epic's phases go on from the last Q id before
// them instead of starting at Q1 again.
const ARCHITECTURE_OPEN = '## What is still open';
function freshIds(ids: readonly (string | null)[], files: Files, earlier: readonly [string, string, string][]): string[] {
  return ids.flatMap((id) => {
    const held = earlier.find(([path, heading]) => refinedQuestions(files[path] ?? '', heading).some((one) => one.id === id));
    return id === null || held === undefined ? [] : [`The question ${id} has an id the ${held[2]} already gives a question. Go on from its last Q id.`];
  });
}
const BRIEF_QUESTIONS: [string, string, string] = ['refine/refined.md', '## Open questions', 'brief'];
const architectureFresh = (text: string, files: Files) => freshIds(refinedQuestions(text, ARCHITECTURE_OPEN).map((one) => one.id), files, [BRIEF_QUESTIONS]);

// An AC id named anywhere in the file is one the brief has.
function knownCriteria(text: string, files: Files): string[] {
  const known = criteria(files['refine/refined.md']);
  return known === null ? [] : cites(text).filter((id) => !known.includes(id)).map((id) => `${id} is cited, and the brief has no such criterion.`);
}

// Each screen says where a person reaches it, names each state it draws so QA can check it by that
// name, and says where the data of its states comes from.
function screenParts(text: string): string[] {
  const screens = (section(text, '## Screens') ?? '').split(/^(?=### )/m).filter((part) => part.startsWith('### '));
  return screens.flatMap((part) => {
    const name = part.split('\n')[0]?.slice(4).trim();
    const lines = part.split('\n');
    const field = (label: string) => lines.findIndex((line) => new RegExp(`^${label}\\s*:`, 'i').test(line.trim()));
    const states = field('States');
    const problems = ['Address', 'States', 'Data'].filter((label) => field(label) === -1).map((label) => `The screen ${name} has no "${label}:" line.`);
    // A blank line before the list still reads as the list in Markdown.
    const first = lines.slice(states + 1).find((line) => line.trim() !== '');
    if (states !== -1 && !/^[-*] .+?\(.*?\)\s*:/.test(first?.trim() ?? '')) problems.push(`The screen ${name} names no state as a "- <state> (<ids>): ..." line under "States:".`);
    return problems;
  });
}

// A screen's question has the brief's shape on one line: `Question: Q3: <question> Default: <answer>. blocks: no`.
function screenQuestions(text: string): RefinedQuestion[] {
  const asked = text.split('\n').flatMap((line) => /^question\s*:\s*(.*)$/i.exec(line.trim())?.[1] ?? []).filter((one) => !/^none\b/i.test(one));
  return refinedQuestions(`## Open questions\n${asked.map((one) => `- ${one}`).join('\n')}`);
}
function designQuestions(text: string, files: Files): string[] {
  const questions = screenQuestions(text);
  const noId = questions.filter((one) => one.id === null).map((one) => `A screen's question has no Q id: "${one.question}"`);
  const earlier: [string, string, string][] = [BRIEF_QUESTIONS, ['architecture/architecture.md', ARCHITECTURE_OPEN, 'architecture']];
  const ids = questions.flatMap((one) => one.id ?? []);
  return [...noId, ...usedTwice(ids), ...askedWell(questions.filter((one) => one.id !== null), Infinity), ...freshIds(ids, files, earlier)];
}

// On an epic the plan goes on from the architecture's last D id: a task's ticket copies a decision by
// its id, and of two with one id it gets the architecture's.
function freshDecisions(text: string, files: Files): string[] {
  const held = idsIn(section(files['architecture/architecture.md'] ?? '', '## The decisions') ?? '', 'D');
  return idsIn(section(text, '## Decisions') ?? '', 'D')
    .filter((id) => held.includes(id))
    .map((id) => `The decision ${id} has an id the architecture already gives a decision. Go on from its last D id.`);
}

// Each criterion of the brief goes to a step or to Not doing, and each step cites only real ones.
function planCovers(text: string, files: Files): string[] {
  const known = criteria(files['refine/refined.md']);
  if (known === null) return [];
  const steps = section(text, '## Steps') ?? '';
  const covered = new Set<string>();
  const problems: string[] = [];
  let step = 0;
  for (const line of steps.split('\n')) {
    const numbered = /^(\d+)\. /.exec(line);
    if (numbered !== null) step = Number(numbered[1]);
    const covers = /^\s+Covers:(.*)$/.exec(line);
    if (covers === null) continue;
    for (const id of cites(covers[1] ?? '')) {
      covered.add(id);
      if (!known.includes(id)) problems.push(`Step ${step} covers ${id}, which the brief does not have.`);
    }
  }
  const notDoing = new Set(cites(section(text, '## Not doing') ?? ''));
  return [...problems, ...known.filter((id) => !covered.has(id) && !notDoing.has(id)).map((id) => `No step covers ${id}, and "## Not doing" does not name it.`)];
}

// Every step says how it is proved, so Implement runs the same command QA would.
function stepChecks(text: string): string[] {
  const steps = (section(text, '## Steps') ?? '').split(/^(?=\d+\. )/m).filter((part) => /^\d+\. /.test(part));
  return steps.filter((step) => !/^[ \t]+check\s*:/im.test(step)).map((step) => `Step ${/^\d+/.exec(step)?.[0]} has no "Check:" line.`);
}

// parsePlan reads every numbered line as a step, so one outside the steps adds a step nobody planned.
function planNumbered(text: string): string[] {
  const steps = section(text, '## Steps') ?? '';
  const inSteps = new Set(steps.split('\n'));
  return text
    .split('\n')
    .filter((line) => /^\d+\. /.test(line) && !inSteps.has(line))
    .map((line) => `A numbered line outside "## Steps" reads as a step: "${line}"`);
}

// A check names the level its criterion has in the brief, so the person sees which ones fail the card.
function checkLevels(text: string, files: Files): string[] {
  const levels = new Map(refinedCriteria(files['refine/refined.md'] ?? '').map((one) => [one.id, one.level]));
  return items(text).flatMap((line) => {
    const found = /^\d+\. (AC\d+)\b(?: *\((\w+)\))?/i.exec(line);
    const id = found?.[1]?.toUpperCase();
    const level = id === undefined ? null : (levels.get(id) ?? null);
    if (level === null || found?.[2]?.toLowerCase() === level) return [];
    return [`The check for ${id} does not carry its level from the brief, "${id} (${level}):".`];
  });
}

function checksCover(text: string, files: Files): string[] {
  const known = criteria(files['refine/refined.md']);
  if (known === null) return [];
  const named = cites(text);
  return [
    ...known.filter((id) => !named.includes(id)).map((id) => `No check names ${id}.`),
    ...named.filter((id) => !known.includes(id)).map((id) => `A check names ${id}, which the brief does not have.`),
  ];
}

// As loose as the checklist on the ticket page, which reads a result word in any case.
const ROW = /^\d+\. +(pass|fail|not reached) *: *(.*)$/i;
const ROW_AC = /^(AC\d+)(?: *\((must|should)\))? *:/i;

// The lines a row needs under it. Evidence is what QA saw, so a row without it was not checked, and
// Fix it hands a failed row's Expected and Actual to Implement.
const ROW_FIELDS: Record<string, readonly string[]> = { pass: ['How', 'Evidence'], fail: ['Reason', 'Expected', 'Actual', 'How', 'Evidence'], 'not reached': ['Reason'] };

function reportRows(text: string, files: Files): string[] {
  const body = section(text, '## 2. What QA checked') ?? '';
  const rows = items(body);
  const problems = rows.filter((row) => !ROW.test(row)).map((row) => `A row does not start with pass, fail or not reached: "${row}"`);
  const checks = files['qa/checks.md'];
  const asked = checks === undefined ? 0 : items(checks).length;
  if (asked > rows.length) problems.push(`qa/checks.md has ${asked} checks and the report has ${rows.length} rows.`);

  const read = body
    .split(/^(?=\d+\. )/m)
    .filter((part) => ROW.test(part.split('\n')[0] ?? ''))
    .map((part) => {
      const [first = '', ...under] = part.trimEnd().split('\n');
      const row = ROW.exec(first);
      const ac = ROW_AC.exec(row?.[2] ?? '');
      return { number: Number(/^\d+/.exec(first)?.[0]), result: row?.[1]?.toLowerCase() ?? '', id: ac?.[1]?.toUpperCase(), level: ac?.[2]?.toLowerCase(), under };
    });
  for (const row of read) {
    for (const field of ROW_FIELDS[row.result] ?? []) {
      if (!row.under.some((line) => new RegExp(`^\\s+${field}\\s*:`, 'i').test(line))) problems.push(`Row ${row.number} has no "${field}:" line.`);
    }
  }
  // Two names that differ only in case are one file on a disk that ignores case, and one is lost.
  for (const path of new Set(body.match(/qa\/evidence\/[^\s,;)`"']+/g) ?? [])) {
    if (path !== path.toLowerCase()) problems.push(`The evidence file ${path} has capital letters. Name it in lower case, because a disk that ignores case keeps one of two such names.`);
  }

  // The verdict rule: PASS only when every must criterion passed with
  // its evidence. A should criterion may fail beside a PASS. A criterion with no level, from a brief
  // written before the levels, counts as must.
  const verdict = /\b(PASS|FAIL|BLOCKED)\b/.exec(section(text, '## 1. Verdict') ?? '')?.[1];
  if (verdict !== 'PASS') return problems;
  const levels = new Map(refinedCriteria(files['refine/refined.md'] ?? '').map((one) => [one.id, one.level]));
  const must = (id: string, own?: string) => (levels.get(id) ?? own ?? 'must') === 'must';
  const missed = [...new Set(read.filter((row) => row.id !== undefined && row.result !== 'pass' && must(row.id, row.level)).map((row) => row.id))];
  if (missed.length > 0) problems.push(`The verdict is PASS, but the must ${missed.length === 1 ? 'check' : 'checks'} ${missed.join(', ')} did not pass.`);
  for (const [id] of [...levels].filter(([id]) => must(id) && !read.some((row) => row.id === id))) problems.push(`The verdict is PASS, but no row checks the must criterion ${id}.`);
  for (const row of read.filter((one) => one.id === undefined && one.result === 'fail')) problems.push(`The verdict is PASS, but row ${row.number} failed.`);
  return problems;
}

// The record opens with the commit the work started from, so QA and a person can diff from it.
const base = (text: string) => (/^base:/i.test(text.trimStart()) ? [] : ['The file does not open with a "Base:" line, the commit the work started from.']);

// Implement's review block counts the deviations and names the tests it changed, so a weakened test
// shows at the gate.
const recordLabels = (text: string) => {
  const block = section(text, REVIEW_BLOCK);
  if (block === null) return [];
  return ['Deviations', 'Tests'].filter((label) => !block.split('\n').some((line) => line.toLowerCase().startsWith(`- ${label.toLowerCase()}:`))).map((label) => `The review block has no "- ${label}:" line.`);
};

// A step line under "## Steps done": "1. Added ..." as the skill shows it, or "- Step 1: ..." as older
// runs write it. stepsDone reads both as that step.
const STEP_LINE = /^(?:\d{1,3}\. |(?:[-*] *)?step *\d{1,3}\b)/i;

// Each step and each fix names the command that proved it. A red run alone proves only the test.
function stepProof(text: string): string[] {
  const parts = (section(text, '## Steps done') ?? '').split(/^(?=\d+\. |[-*] |step *\d)/im).filter((part) => STEP_LINE.test(part) || /^[-*] /.test(part));
  return parts.flatMap((part) => {
    const [first = '', ...rest] = part.trimEnd().split('\n');
    const label = STEP_LINE.test(first) ? `Step ${/\d+/.exec(first)?.[0]}` : `"${first}"`;
    const has = (field: string) => rest.some((line) => new RegExp(`^\\s+${field}\\s*:`, 'i').test(line));
    if (has('red') && !has('green')) return [`${label} has a "Red:" line and no "Green:" line.`];
    return has('check') || has('green') ? [] : [`${label} has no "Check:" or "Green:" line with the command that proved it.`];
  });
}

// The same reading as stepsDone in the runner: a line that starts with a number, after a bullet or the
// word step, is a finished step, so the next run would skip that step.
const READS_AS_STEP = /^(?:[-*]\s*)?(?:step\s*)?\d{1,3}\b/i;

function readsAsStep(text: string): string[] {
  const steps = section(text, '## Steps done');
  if (steps === null) return [];
  // The step lines, and a review block line that starts with a digit, which reviewBlock names already.
  const skip = new Set([...steps.split('\n').filter((line) => STEP_LINE.test(line)), ...(section(text, REVIEW_BLOCK) ?? '').split('\n').filter((line) => /^- \d/.test(line))]);
  return text
    .split('\n')
    .filter((line) => READS_AS_STEP.test(line.trim()) && !skip.has(line))
    .map((line) => `A line starts with a number, and the next run reads it as a finished step: "${line}"`);
}

// A deviation is a ruling: what was done instead, why, and what it costs when the call was wrong.
const rulings = (text: string) =>
  items(text)
    .filter((line) => /^[-*] /.test(line) && !(/\bWhy:/i.test(line) && /\bIf wrong:/i.test(line)))
    .map((line) => `A deviation has no "Why:" or no "If wrong:": "${line}"`);

// The Review tab refuses a whole round it cannot read, with this sentence, so the check reads it the
// same way.
function roundLabels(text: string): string[] {
  const read = parseRound(text);
  return read.ok ? [] : [read.problem];
}

// The page draws the sources as chips from the last section, and finds it only under this exact name.
const sourcesLast = (text: string) => (secondLevel(text).at(-1) === '## Sources' ? [] : ['"## Sources" is not the last section.']);

// A Research or Investigate answer opens with its review block: the answer in one sentence, then how
// sure the run is.
const CONFIDENCE = /^confidence: *(high|medium|low)\b/i;
const NO_CONFIDENCE = 'There is no "Confidence:" line (high, medium or low) under the answer.';
function answerFirst(text: string): string[] {
  const lines = text.split('\n');
  const heading = lines.findIndex((line) => /^#{1,6} /.test(line));
  const head = lines.slice(0, heading === -1 ? undefined : heading).map((line) => line.trim()).filter((line) => line !== '');
  return [
    ...(head[0] === undefined || /^([-*]|\d+\.) /.test(head[0]) ? ['The file does not open with the answer in one sentence.'] : []),
    ...(head.some((line) => CONFIDENCE.test(line)) ? [] : [NO_CONFIDENCE]),
  ];
}

const HYPOTHESES = '## Hypotheses tried';
const SEARCHED = '## Searched and not found';
const tried = (text: string) =>
  items(section(text, HYPOTHESES) ?? '')
    .filter((line) => !/\bResult: *(held|ruled out|not settled)\b/i.test(line))
    .map((line) => `A hypothesis has no "Result:" (held, ruled out or not settled): "${line}"`);

// Make a Delivery card hands the answer to Refine, so the draft uses the brief's own line shapes.
const CARD_DRAFT = '## If this becomes a card';
function cardDraft(text: string): string[] {
  const body = section(text, CARD_DRAFT);
  if (body === null) return [];
  const has = (field: string) => body.split('\n').some((line) => line.trim().toLowerCase().startsWith(`${field}:`));
  const asChecks = `## Acceptance checks\n${body}`;
  return [
    ...(has('problem') ? [] : [`"${CARD_DRAFT}" has no "Problem:" line.`]),
    ...(has('change') ? [] : [`"${CARD_DRAFT}" has no "Change:" line with the places to change.`]),
    ...(refinedCriteria(asChecks).length === 0 ? [`"${CARD_DRAFT}" has no criterion, as "- AC1 (must): ..." with a "Check:" line.`] : criterionParts(asChecks)),
    ...askedWell(refinedQuestions(text, CARD_DRAFT).filter((one) => one.id !== null)),
  ];
}

// The assessment screen splits the file at every heading, whatever its level.
const ASSESSMENT_CAUSE = '## The likely cause';
const ASSESSMENT_HEADINGS = ['## The evidence', ASSESSMENT_CAUSE, '## The proposal', '## The effort', '## The risks'];
function causeCall(text: string): string[] {
  const body = section(text, ASSESSMENT_CAUSE);
  if (body === null) return [];
  const lines = body.split('\n').map((line) => line.trim());
  return [
    ...(lines.some((line) => CONFIDENCE.test(line)) ? [] : [`"${ASSESSMENT_CAUSE}" has no "Confidence:" line (high, medium or low).`]),
    ...(lines.some((line) => /^what would change it:/i.test(line)) ? [] : [`"${ASSESSMENT_CAUSE}" has no "What would change it:" line.`]),
  ];
}
const subHeadings = (text: string) =>
  text
    .split('\n')
    .filter((line) => /^#{2,6} /.test(line) && !ASSESSMENT_HEADINGS.some((heading) => sameHeading(line.replace(/^#+/, '##'), heading)))
    .map((line) => `The heading "${line.trim()}" splits a section, because the screen starts a new section at every heading.`);

// A review round's summary is its review block: the verdict, the blocks counted by label, what an
// earlier round's issues came to, and what was not reviewed. The verdict and the counts follow the
// newest round, so they are checked against it.
const ROUND_FILE = /^pr-review\/round(?:-(\d+))?\.md$/;
const roundsOf = (files: Files) =>
  Object.keys(files)
    .flatMap((path) => {
      const found = ROUND_FILE.exec(path);
      return found === null ? [] : [{ number: Number(found[1] ?? 1), text: files[path] ?? '' }];
    })
    .sort((a, b) => a.number - b.number);
const blocksOf = (text: string) => {
  const read = parseRound(text);
  return read.ok ? read.blocks : [];
};
function reviewSummary(text: string, files: Files): string[] {
  const rounds = roundsOf(files);
  const newest = rounds.at(-1);
  if (newest === undefined) return [];
  const line = (name: string) => text.split('\n').map((one) => one.trim()).find((one) => one.toLowerCase().startsWith(`${name}:`)) ?? null;
  // A round the page cannot read is named on its own file, and has no counts to follow.
  const read = parseRound(newest.text);
  if (!read.ok) return [];
  const blocks = read.blocks;
  const counts = ROUND_LABELS.map((label) => ({ label, count: blocks.filter((block) => block.label === label).length }));
  const blocking = blocks.filter(isBlocking).length;
  const questions = blocks.filter((block) => block.label === 'question').length;
  const expected = blocking > 0 ? 'changes needed' : questions > 0 ? 'questions first' : 'ready to merge';
  const problems: string[] = [];
  const verdict = line('verdict');
  if (verdict === null) problems.push('There is no "Verdict:" line (changes needed, questions first or ready to merge).');
  else if (!verdict.toLowerCase().startsWith(`verdict: ${expected}`)) problems.push(`The verdict does not follow the round: with ${blocking} blocking and ${questions} question blocks it is "${expected}".`);
  const findings = line('findings');
  if (findings === null) problems.push('There is no "Findings:" line with the count of blocks by label.');
  else if (counts.some(({ label, count }) => Number(new RegExp(`(\\d+) ${label}`, 'i').exec(findings)?.[1] ?? 0) !== count)) {
    problems.push(`"Findings:" does not match the round, which has ${counts.filter((one) => one.count > 0).map((one) => `${one.count} ${one.label}`).join(', ') || 'no block'}.`);
  }
  if (rounds.slice(0, -1).some((round) => blocksOf(round.text).some((block) => block.label === 'issue')) && line('earlier issues') === null) {
    problems.push('This is a re-review and there is no "Earlier issues:" line, which says how many issues of the earlier rounds are fixed.');
  }
  if (line('not reviewed') === null) problems.push('There is no "Not reviewed:" line, which says what the round did not read.');
  return problems;
}

// The two files for other people, which Implement writes and every Implement run brings up to date. QA
// and the wrap-up correct them and are not held to them: a card whose Implement left them out already
// carries the problem, and a wrap-up of a Research answer has none.
export const SHARE_FILES = ['share/SUMMARY.md', 'share/TESTING.md'] as const;

export const OUTPUT_RULES: Readonly<Record<string, PhaseRules>> = {
  refine: {
    files: [
      {
        file: 'refine/refined.md',
        // The review block is a heading here, so a brief without one is a problem.
        headings: [REVIEW_BLOCK, '## Problem', '## Scope', '## Assumptions', '## Acceptance checks', '## Open questions', '## What the code does today', '## Rules that apply', '## Out of scope', '## Read first'],
        checks: [idRule('## Assumptions', 'A'), idRule('## Acceptance checks', 'AC'), idRule('## Open questions', 'Q'), criterionParts, questionParts('## Open questions'), readAt('## What the code does today')],
      },
    ],
  },
  architecture: {
    files: [
      {
        file: 'architecture/architecture.md',
        headings: [REVIEW_BLOCK, '## The shape', '## The pieces', '## Where they meet', '## Interfaces', '## The data', '## The decisions', ARCHITECTURE_OPEN, '## Touch points', '## Test surfaces', '## Not doing', '## Read first'],
        checks: [readAt('## The shape'), idRule('## The decisions', 'D'), turnedDown, idRule(ARCHITECTURE_OPEN, 'Q'), questionParts(ARCHITECTURE_OPEN), architectureFresh, knownCriteria],
      },
    ],
    reads: ['refine/refined.md'],
  },
  design: {
    files: [{ file: 'design/design.md', headings: [REVIEW_BLOCK, '## Screens', '## Not doing', '## Read first'], checks: [readAt('## Screens'), screenParts, designQuestions, knownCriteria] }],
    reads: ['refine/refined.md', 'architecture/architecture.md'],
  },
  plan: {
    files: [
      {
        file: 'plan/plan.md',
        headings: [REVIEW_BLOCK, '## Approach', '## Decisions', '## Steps', '## Risks', '## Order', '## Settled questions', '## Rules that apply', '## Not doing', '## Read first'],
        checks: [planCovers, planNumbered, stepChecks, idRule('## Decisions', 'D'), freshDecisions, readAt('## Approach')],
      },
      { file: 'qa/checks.md', checks: [checksCover, checkLevels] },
      // An epic's tasks may become tickets colleagues read, from this file.
      { file: 'share/PLAN.md', headings: ['## Tasks'], board: 'epics' },
    ],
    reads: ['refine/refined.md', 'architecture/architecture.md'],
  },
  implement: {
    files: [
      { file: 'implement/progress.md', headings: [REVIEW_BLOCK, '## Steps done'], checks: [base, recordLabels, stepProof, readsAsStep] },
      { file: 'implement/pr.md', headings: ['## What changed', '## How to test'] },
      { file: 'implement/deviations.md', checks: [rulings] },
      ...SHARE_FILES.map((file) => ({ file })),
    ],
  },
  qa: {
    // Section 1 is QA's review block.
    files: [{ file: 'qa/report.md', block: '## 1. Verdict', headings: ['## 1. Verdict', '## 2. What QA checked', '## 3. What was not checked'], checks: [reportRows] }],
    reads: ['qa/checks.md', 'refine/refined.md'],
  },
  research: { files: [{ file: 'research/answer.md', headings: ['## Why', SEARCHED, '## Sources'], checks: [answerFirst, cardDraft, sourcesLast] }] },
  investigate: {
    files: [
      {
        file: 'investigate/report.md',
        headings: ['## What was reported', '## What was found', HYPOTHESES, '## The fix or next step', SEARCHED, '## Sources'],
        checks: [answerFirst, tried, cardDraft, sourcesLast],
      },
    ],
  },
  assess: { files: [{ file: 'assess/assessment.md', headings: ASSESSMENT_HEADINGS, checks: [causeCall, subHeadings] }] },
  'pr-review': {
    files: [
      { file: 'pr-review/round.md', match: ROUND_FILE, checks: [roundLabels] },
      { file: 'pr-review/summary.md', checks: [reviewSummary] },
    ],
  },
  wrapup: { files: [{ file: 'wrapup/changes.md' }], knowledge: true },
  optimize: { files: [{ file: 'optimize/changes.md' }], knowledge: true },
  orient: { files: [{ file: 'orient/changes.md', checks: [orientSize] }], knowledge: true, notes: orientSources },
  'learn-repo': { files: [{ file: 'learn-repo/changes.md' }], knowledge: true },
};

// A note has the description the knowledge index shows every run, and names only paths a base branch
// can hold. A note can point at design files in `.tasks/`, which git does not track.
// Whether a path is still on the base branch is the Knowledge screen's check, because it needs git.
const KNOWLEDGE_PREFIX = 'knowledge/';
function noteProblems(files: Files, repos: readonly string[], created: readonly string[] | null): OutputProblem[] {
  return Object.entries(files)
    .filter(([path]) => path.startsWith(KNOWLEDGE_PREFIX) && path.endsWith('.md'))
    .flatMap(([file, text]) => [
      ...(frontmatterDescription(text) === null ? ['The note has no "description:" in its frontmatter, which the knowledge index shows every run as the line that says when to read it.'] : []),
      ...frontmatterPaths(text)
        .filter((path) => /^(\/|~|\.tasks(\/|$))/.test(path) || path.split('/').includes('..'))
        .map((path) => `The path "${path}" is one git does not keep. Name only paths git tracks on the base branch, never the card folder.`),
      ...(created === null || created.includes(file) ? misplaced(file.slice(KNOWLEDGE_PREFIX.length), text, repos) : []),
    ].map((problem) => ({ file, problem })));
}

// A note the run made in another folder than the one its paths name. The index of a card lists the
// notes of the card's repositories, so a note in the wrong folder is missed by the cards it is about.
// A note that was there before the run is left alone: it may wait for the move of an older folder,
// which code does, not the run. The run recipe and the repository files have their place by name.
function misplaced(path: string, text: string, repos: readonly string[]): string[] {
  const name = path.split('/').at(-1) ?? path;
  if (repos.length === 0 || path === RUN_RECIPE_FILE || name === REPO_FILE) return [];
  const wanted = noteFolder(frontmatterPaths(text), repos);
  const folder = path.slice(0, path.length - name.length);
  if (wanted === null || wanted === folder) return [];
  const where = (one: string) => (one === '' ? 'the top of the knowledge folder' : one);
  return [`The note sits in ${where(folder)}, but its paths belong in ${where(wanted)}. Move it to ${wanted}${name}.`];
}

// Learn this project keeps what a person can check in one sitting: at most three notes and about 60
// lines, and every line names where it came from. The repository
// files and the run recipe keep the shape code gave them, with their own source words, so only the
// other notes are read line by line.
const ORIENT_NOTES = 3;
const ORIENT_LINES = 60;
const SOURCED = /\((?:from [^()]+|told by the person)\)\.?$/;
const ownNotes = (files: Files) =>
  Object.entries(files).filter(([path]) => path.startsWith(KNOWLEDGE_PREFIX) && path.endsWith('.md') && path !== `${KNOWLEDGE_PREFIX}${RUN_RECIPE_FILE}` && path.split('/').at(-1) !== REPO_FILE);
// The lines under the frontmatter that say something: no blank line and no heading.
const noteLines = (text: string) => {
  const lines = text.split('\n');
  return lines.slice(frontmatterEnd(lines) + 1).filter((line) => line.trim() !== '' && !line.startsWith('#'));
};

function orientSize(_text: string, files: Files): string[] {
  const notes = Object.keys(files).filter((path) => path.startsWith(KNOWLEDGE_PREFIX) && path.endsWith('.md'));
  const lines = ownNotes(files).reduce((sum, [, text]) => sum + noteLines(text).length, 0);
  return [
    ...(notes.length > ORIENT_NOTES ? [`The run wrote ${notes.length} knowledge files, more than ${ORIENT_NOTES}.`] : []),
    ...(lines > ORIENT_LINES ? [`The knowledge files hold ${lines} lines, more than about ${ORIENT_LINES}.`] : []),
  ];
}

function orientSources(files: Files): OutputProblem[] {
  return ownNotes(files).flatMap(([file, text]) =>
    noteLines(text)
      .filter((line) => !SOURCED.test(line.trim()))
      .map((line) => ({ file, problem: `The line "${line.trim()}" names no source. End it with (from <the file>) or (told by the person).` })),
  );
}

// Every phase writes its plain summary to the same place. A phase with rules of its own for it lists it.
const rulesOf = (phase: string, board?: string): readonly FileRule[] | null => {
  const rules = OUTPUT_RULES[phase];
  if (rules === undefined) return null;
  const summary = `${phase}/summary.md`;
  const files = rules.files.filter((rule) => rule.board === undefined || rule.board === board);
  return files.some((rule) => rule.file === summary) ? files : [...files, { file: summary }];
};

// The fixed paths the check reads, besides every Markdown file in the phase's own folder, which the
// caller hands over too so a round with a number is found.
export function checkedPaths(phase: string, board?: string): string[] {
  const rules = rulesOf(phase, board);
  return rules === null ? [] : [...rules.map((rule) => rule.file), ...(OUTPUT_RULES[phase]?.reads ?? [])];
}

// Template text from a skill, such as `<card folder>` or `<KEY>`. Code spans and fences are left out,
// and so is a tag with attributes, which has an `=` in it.
function placeholders(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  return [...new Set(prose.match(/<(?:KEY|[a-z][a-z0-9',]*(?: [a-z0-9',]+)+)>/g) ?? [])];
}

function reviewBlock(text: string, heading = REVIEW_BLOCK): string[] {
  const body = section(text, heading);
  if (body === null) return [];
  const lines = body.split('\n').filter((line) => line.trim() !== '');
  const problems = lines.length > REVIEW_BLOCK_LINES ? [`The review block has ${lines.length} lines, more than ${REVIEW_BLOCK_LINES}.`] : [];
  for (const line of lines) {
    if (!line.startsWith('- ')) problems.push(`A review block line is not a bullet: "${line}"`);
    else if (/^- \d/.test(line)) problems.push(`A review block line starts with a digit, which reads as a step: "${line}"`);
  }
  return problems;
}

function pick(rule: FileRule, files: Files): { path: string; text: string } | null {
  if (rule.match === undefined) return files[rule.file] === undefined ? null : { path: rule.file, text: files[rule.file] ?? '' };
  const found = Object.keys(files)
    .map((path) => ({ path, round: rule.match?.exec(path) }))
    .filter((one) => one.round != null)
    .sort((a, b) => Number(a.round?.[1] ?? 1) - Number(b.round?.[1] ?? 1))
    .at(-1);
  return found === undefined ? null : { path: found.path, text: files[found.path] ?? '' };
}

// The problems in what one phase wrote, or null for a phase with no rules (an Ask, a pass).
// `repos` is the project's list of repositories, which says the folder each note belongs in. Empty
// leaves where a note sits unchecked. `created` names the notes the run made, the only ones whose
// place is checked; null checks every note.
export function checkOutputs(phase: string, files: Files, board?: string, repos: readonly string[] = [], created: readonly string[] | null = null): OutputProblem[] | null {
  const rules = rulesOf(phase, board);
  if (rules === null) return null;
  const notes = OUTPUT_RULES[phase]?.knowledge === true ? [...noteProblems(files, repos, created), ...(OUTPUT_RULES[phase]?.notes?.(files) ?? [])] : [];
  return [...rules.flatMap((rule, at) => {
    const found = pick(rule, files);
    if (found === null) return [{ file: rule.file, problem: 'The file is missing.' }];
    const { path, text } = found;
    if (text.trim() === '') return [{ file: path, problem: 'The file is empty.' }];
    const main = at === 0;
    const lines = text.trimEnd().split('\n').length;
    const left = placeholders(text);
    const problems = [
      ...(rule.headings ?? []).map((heading) => {
        const body = section(text, heading);
        if (body === null) return `The heading "${heading}" is missing.`;
        return body.trim() === '' ? `The section "${heading}" is empty.` : null;
      }),
      ...(rule.checks ?? []).flatMap((check) => check(text, files)),
      main ? reviewBlock(text, rule.block) : [],
      main && lines > MAIN_FILE_LINES ? `The file has ${lines} lines, more than about ${MAIN_FILE_LINES} a person reads at a gate.` : null,
      left.length > 0 ? `Placeholder text is left in: ${left.map((one) => `"${one}"`).join(', ')}.` : null,
    ].flat();
    return problems.filter((problem): problem is string => problem !== null).map((problem) => ({ file: path, problem }));
  }), ...notes];
}

// What a run stores. The project instructions are named only beside a problem, because they are the
// first place to look when a phase wrote something its skill did not ask for.
export function outputCheck(phase: string, files: Files, instructionsFile: string | null, board?: string, repos: readonly string[] = [], created: readonly string[] | null = null): OutputCheck | null {
  const problems = checkOutputs(phase, files, board, repos, created);
  if (problems === null) return null;
  const note =
    problems.length > 0 && instructionsFile !== null ? `This phase ran with the project instructions in ${instructionsFile}. They may have changed what it wrote, so look there first.` : null;
  return { problems, note };
}

// The gate: what the Overview draws above a move on, and what a forward move reads. The main file of a
// phase that opens with a review block, or null for a phase whose block is its first sentence.
export function gateFile(phase: string): string | null {
  const main = OUTPUT_RULES[phase]?.files[0];
  return main !== undefined && (main.block !== undefined || main.headings?.includes(REVIEW_BLOCK) === true) ? main.file : null;
}

const OPEN_QUESTIONS: Readonly<Record<string, (text: string) => RefinedQuestion[]>> = {
  refine: (text) => refinedQuestions(text),
  architecture: (text) => refinedQuestions(text, ARCHITECTURE_OPEN),
  design: screenQuestions,
};

export interface Gate {
  // The lines of the review block, blank lines left out, or null when the file has none.
  lines: string[] | null;
  // The open questions marked `blocks: yes`, which make the next forward move a choice. A
  // question with no id cannot be answered by its id, so it is left to the check,
  // and of two with one id the first counts, because a choice names only the id.
  blocking: (RefinedQuestion & { id: string })[];
}

export function gateOf(phase: string, text: string): Gate {
  const main = OUTPUT_RULES[phase]?.files[0];
  const body = gateFile(phase) === null ? null : section(text, main?.block ?? REVIEW_BLOCK);
  const lines = body === null ? null : body.split('\n').filter((line) => line.trim() !== '');
  const blocking = (OPEN_QUESTIONS[phase]?.(text) ?? [])
    .filter((one): one is RefinedQuestion & { id: string } => one.id !== null && one.blocks === true)
    .filter((one, at, all) => all.findIndex((other) => other.id === one.id) === at);
  return { lines: lines === null || lines.length === 0 ? null : lines, blocking };
}
