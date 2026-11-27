import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decisionLines, NEEDS_INPUT_PREFIX, QUESTION_FILE, refinedCriteria, refinedQuestions, SENTINEL_COMPLETE, VERDICTS, VERDICT_PREFIX } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { lintSkills, parseFrontmatter } from './lint.ts';
import { readFinishRules, readKnowledgeRules, readVerdictRules } from './text.ts';

const skillsDir = path.join(import.meta.dirname, '..', 'skills');

// One row per skill folder, so a new skill adds a row here and no new test.
//
// Every skill writes into the card folder, including optimize, which belongs to no card and gets
// the same `.tasks/<key>/` folder under a pseudo key. A second word for the same folder was tried
// and dropped: the runner has one concept, `job.taskDir`, and the shared finish rules name the
// card folder, so a skill using another word contradicted the file it links.
const SKILLS: { folder: string; phase: string; artifact: string; reads: string | null; own?: string[]; asks?: false }[] = [
  // `reads` is what the phase before it left behind. Refine has none: its input is the card text,
  // which the prompt already carries. Optimize has none either: its input is the knowledge file
  // the prompt names, which its own describe block asserts.
  { folder: 'nolzu-refine', phase: 'refine', artifact: 'refined.md', reads: null },
  { folder: 'nolzu-plan', phase: 'plan', artifact: 'plan.md', reads: '<card folder>/refine/refined.md' },
  { folder: 'nolzu-implement', phase: 'implement', artifact: 'pr.md', reads: '<card folder>/plan/plan.md' },
  { folder: 'nolzu-qa', phase: 'qa', artifact: 'report.md', reads: '<card folder>/refine/refined.md' },
  { folder: 'nolzu-wrapup', phase: 'wrapup', artifact: 'changes.md', reads: '<card folder>/plan/plan.md' },
  { folder: 'nolzu-optimize', phase: 'optimize', artifact: 'changes.md', reads: null },
  // Learn this project has no phase before it either: its input is what people wrote in the project
  // and what the person answers.
  { folder: 'nolzu-orient', phase: 'orient', artifact: 'changes.md', reads: null },
  // Learn your repositories reads one repository's own files. It never asks (`asks: false`): it belongs
  // to no card and to no question Knowledge offers, so a question would have nowhere to be answered.
  { folder: 'nolzu-learn-repo', phase: 'learn-repo', artifact: 'changes.md', reads: null, asks: false },
  // The five phases of the other four boards. A phase runs once a stage names it and it is in the
  // action table as well. The skills and their policy rows come first, because a stage that named a
  // phase with neither would build a job the runner refuses.
  { folder: 'nolzu-architecture', phase: 'architecture', artifact: 'architecture.md', reads: '<card folder>/refine/refined.md' },
  { folder: 'nolzu-design', phase: 'design', artifact: 'design.md', reads: '<card folder>/architecture/architecture.md' },
  // These two have no phase before them, so `reads` is null and stays null. Their input is the
  // ticket text and the extra context the prompt carries, plus any file the person copied into the
  // card folder. The describe block at the end of this file holds them to saying that.
  { folder: 'nolzu-investigate', phase: 'investigate', artifact: 'report.md', reads: null },
  { folder: 'nolzu-research', phase: 'research', artifact: 'answer.md', reads: null },
  // `own` is the rest of what a `reads: null` skill may name inside its own folder. The diff is the
  // one file a runner does write for a run: the pr-review start puts it there before the
  // engine starts.
  { folder: 'nolzu-pr-review', phase: 'pr-review', artifact: 'round.md', reads: null, own: ['diff.patch'] },
  // Triage of a card's own pull request. The comments file is the one the runner writes before the
  // run, the way it writes the diff for a review, and it carries the plan or summary inside it.
  { folder: 'nolzu-feedback', phase: 'feedback', artifact: 'triage.md', reads: null, own: ['discussions.md'] },
  // The Scout assessment. `reads` is null: its input is the finding, which the prompt carries, the
  // way refine's input is the card text.
  { folder: 'nolzu-assess', phase: 'assess', artifact: 'assessment.md', reads: null },
];

// The skills that write into the knowledge folder, so each carries the shape rules.
const KNOWLEDGE_SKILLS = ['nolzu-wrapup', 'nolzu-optimize', 'nolzu-orient', 'nolzu-learn-repo'];

// The one file at the top of the card folder that every phase of a card adds to, and the wrap-up reads first.
const DISCOVERIES = '<card folder>/discoveries.md';

// The two files in `share/` for people outside the card, as `OUTPUT_RULES` holds Implement to them.
const SHARE_FILES = ['share/SUMMARY.md', 'share/TESTING.md'];

// The plan an epic's Plan writes for colleagues, whose tasks may become tickets in their own system.
const SHARE_PLAN = 'share/PLAN.md';

// The phases that work on a card and write documents a person reads. Each one says the two shared
// rules in its own output format too, because a linked file alone is one step too far away.
const CARD_PHASES = ['nolzu-refine', 'nolzu-architecture', 'nolzu-design', 'nolzu-plan', 'nolzu-implement', 'nolzu-qa', 'nolzu-wrapup', 'nolzu-research', 'nolzu-investigate'];

const skillText = (folder: string): string => readFileSync(path.join(skillsDir, folder, 'SKILL.md'), 'utf8');

it('lints every skill folder with no issues', async () => {
  const result = await lintSkills(skillsDir);

  expect(result.issues).toEqual([]);
  expect(result.checked).toBe(SKILLS.length);
});

// The one project path a skill names: the project's own rules for its phase, which it only reads, so an
// engine run without Nolzu finds them too.
const projectRules = (phase: string): string => `.nolzu/phases/${phase}.md`;

describe.each(SKILLS)('$folder', ({ folder, phase, artifact, reads, own, asks }) => {
  it('names itself after its folder and pins no model', () => {
    const parsed = parseFrontmatter(skillText(folder));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.name).toBe(folder);
    // A model here would override the product's own model settings.
    expect('model' in parsed.data).toBe(false);
  });

  // One case for every file a phase writes, so a name never differs between two file systems.
  it('names every card folder file in lowercase', () => {
    const files = [...skillText(folder).matchAll(/<card folder>\/[\w./-]+/g)].map(([file]) => file);

    expect(files.length).toBeGreaterThan(0);
    // The two files for other people are the one exception: a reader outside
    // the card finds SUMMARY.md and TESTING.md the way a repository names its README.
    expect(files.filter((file) => file !== file.toLowerCase() && ![...SHARE_FILES, SHARE_PLAN].some((share) => file === `<card folder>/${share}`))).toEqual([]);
  });

  it('describes itself well enough to be picked', () => {
    const parsed = parseFrontmatter(skillText(folder));
    if (!parsed.ok) return;

    // The lint accepts a single word, which passes and then never triggers the skill.
    expect(String(parsed.data.description).length).toBeGreaterThanOrEqual(40);
    expect(String(parsed.data.description).length).toBeLessThanOrEqual(1024);
  });

  it('names the file it reads from the phase before it', () => {
    // The prompt names only the folder to write into, so the skill is the only place that says
    // where the phase before it left its work. Unsaid, the run plans from the raw ticket and the
    // refine phase's work is never opened.
    if (reads !== null) expect(skillText(folder)).toContain(reads);
  });

  // The other half of that row. A skill with no phase before it has no file to be handed, so every
  // path it names is one of its own. Unchecked, an invented input such as
  // `<card folder>/research/context/notes.md` reads as ordinary and sends the run to open a file
  // nothing writes, which is a bug these two skills once had.
  it('names no file it is not given when no phase runs before it', () => {
    if (reads !== null) return;
    // The discoveries file is the one card folder file every phase adds to, so it is no invented input.
    const mine = [`<card folder>/${phase}/`, `<card folder>/${phase}/work/`, DISCOVERIES, ...[artifact, 'summary.md', QUESTION_FILE, ...(own ?? [])].map((name) => `<card folder>/${phase}/${name}`)];
    const paths = [...skillText(folder).matchAll(/`([^`\n]*\/[^`\n]*)`/g)].map((match) => match[1]).filter((path) => path !== projectRules(phase));

    for (const path of paths) expect(mine, `${path} is not a file of this phase`).toContain(path);
  });

  // A plain summary during a run, written after each changed file in the same
  // session, not only at the end. The peek sheet reads this file while the phase runs.
  it('keeps its summary file current while it works, after each file it changes', () => {
    const text = skillText(folder).replace(/\s+/g, ' ');

    expect(text).toContain(`<card folder>/${phase}/summary.md`);
    expect(text).toContain('Keep that file current while you work, not only at the end. After each file you change or write, other than the summary itself, rewrite it with the plain summary of the work so far');
  });

  it('says where the files it does not name go, in its output format', () => {
    const format = skillText(folder).slice(skillText(folder).indexOf('## Output format')).replace(/\s+/g, ' ');

    const lead = phase === 'qa' ? 'anything else you store beyond these files in' : 'Anything you store beyond the files this skill names goes in';
    expect(format).toContain(`${lead} \`<card folder>/${phase}/work/\``);
  });

  it('carries the shared finish rules unchanged', () => {
    const copy = readFileSync(path.join(skillsDir, folder, 'finish.md'), 'utf8');

    expect(copy).toBe(readFinishRules());
  });

  it('links the finish rules, so the lint own link check covers the copy', () => {
    expect(skillText(folder)).toContain('](finish.md)');
  });

  it('names the files the next phase reads back', () => {
    const text = skillText(folder);

    expect(text).toContain(`<card folder>/${phase}/${artifact}`);
    // The whole path, not the bare file name. These skills are written by copying the one before,
    // so a leftover `<card folder>/refine/summary.md` in the plan body is the mistake to catch.
    expect(text).toContain(`<card folder>/${phase}/summary.md`);
  });

  // The card folder sits in the project and not in the checkout the run starts in, so a path such as
  // `.tasks/<key>/` resolves to the wrong place from there. The prompt names the folder, and the
  // skill says "the card folder".
  it('names no card path of its own, and says where the card folder comes from', () => {
    const text = skillText(folder);

    expect(text).not.toContain('.tasks/');
    expect(text).toContain('the folder the prompt names');
    expect(text).not.toContain('<run folder>');
  });

  // Every folder path a skill writes in backticks has to be the template the prompt fills in. A
  // named regex would catch only the paths somebody thought of; this catches `.knowledge/`,
  // `docs/kb/` and a home path alike.
  it('hard-codes no folder of its own', () => {
    const paths = [...skillText(folder).matchAll(/`([^`\n]*\/[^`\n]*)`/g)].map((match) => match[1]).filter((path) => path !== projectRules(phase));

    for (const path of paths) {
      expect(path, `${path} is not under the folder the prompt names`).toMatch(/^<card folder>\//);
    }
  });

  // A skill with a strong output format ignores instructions that are only appended to the
  // prompt, so the sentinels have to sit inside the skill's own output format section.
  it('carries both sentinels inside its output format section', () => {
    const text = skillText(folder);
    const at = text.search(/^#+ .*output format/im);

    expect(at).toBeGreaterThan(-1);
    const section = text.slice(at);
    expect(section).toContain(SENTINEL_COMPLETE);
    if (asks === false) expect(section).toMatch(/This run never asks/);
    else expect(section).toContain(NEEDS_INPUT_PREFIX);
  });

  // The loop reads the answers a question offers from this file in the phase folder. Named only in
  // the linked rules, a skill with a strong output format would ask and never write it.
  it('names its question file after the question line in its output format section', () => {
    const text = skillText(folder);
    const section = text.slice(text.search(/^#+ .*output format/im));
    if (asks === false) {
      expect(section).not.toContain(QUESTION_FILE);
      return;
    }

    expect(section.indexOf(`<card folder>/${phase}/${QUESTION_FILE}`)).toBeGreaterThan(section.indexOf(NEEDS_INPUT_PREFIX));
  });

  it('follows the voice rules, because this text ships to a reader', () => {
    const text = skillText(folder);

    expect(text).not.toMatch(/—|–/);
    expect(text).not.toMatch(/delve|leverage|robust|seamless|elevate|unlock|comprehensive|ensure that/i);
  });
});

describe('nolzu-plan', () => {
  it('says the plan phase writes no source file', () => {
    // The phase that plans is the one phase that changes nothing. Unsaid, an agent with a
    // repository in front of it starts editing.
    expect(skillText('nolzu-plan')).toMatch(/write no source file/i);
  });

  it('lists the step fields the implement phase reads back', () => {
    const text = skillText('nolzu-plan');

    for (const field of ['Files:', 'Tests:', 'Undo:']) expect(text).toContain(field);
  });

  // The person reads what QA will check before approving the plan, and QA gets a
  // fixed list. The file sits in QA's folder, because QA is the phase that reads it.
  it('writes the list of what QA will check, as numbered steps with no result', () => {
    const text = skillText('nolzu-plan');

    expect(text).toContain('<card folder>/qa/checks.md');
    expect(text.replace(/\s+/g, ' ')).toMatch(/no result, no heading and no note/i);
  });

  // An epic's tasks go to colleagues in their ticket system, so the plan they read
  // carries one plain task per step and none of the card's own ids.
  it('writes a plan for other people on an epic only, one task per step and no internal reference', () => {
    const text = skillText('nolzu-plan').replace(/\s+/g, ' ');

    expect(text).toContain(`On an epic only, as the prompt says, write \`<card folder>/${SHARE_PLAN}\``);
    expect(text).toContain('one `### 1. <title>` per step of `plan.md`, same numbers and order');
    expect(text).toContain('Name no card folder path, phase, prompt, knowledge note, `D`, `AC`, `Q` or step id, nor Nolzu, AI, agents or how the work was done.');
  });
});

describe.each(KNOWLEDGE_SKILLS)('%s writes knowledge', (folder) => {
  // The one contract these two have with the Knowledge screen, which shows the description next
  // to the file name. Nothing lints a knowledge file, so without this the rule could be deleted
  // from both skills and every test would stay green.
  it('carries the shared knowledge file rules unchanged', () => {
    const copy = readFileSync(path.join(skillsDir, folder, 'knowledge.md'), 'utf8');

    expect(copy).toBe(readKnowledgeRules());
  });

  it('links them, so the lint own link check covers the copy', () => {
    expect(skillText(folder)).toContain('](knowledge.md)');
  });

  // Knowledge is committed and shared, so nothing a client, a tenant or production owns goes in it.
  it('forbids client, tenant and production data, secrets and tokens in a knowledge file', () => {
    expect(readKnowledgeRules().replace(/\s+/g, ' ')).toContain('Never write client, tenant or production data, a secret or a token into a knowledge file or a card file, and no personal data.');
  });

  // What a later run cannot get back cheaply, and what it can.
  it('keeps what is costly to find again, and leaves out a restatement of one file', () => {
    const rules = readKnowledgeRules().replace(/\s+/g, ' ');
    expect(rules).toMatch(/Keep a fact when it is costly to find again/);
    for (const kind of ['a silent trap', 'a contract between files', 'a precedent to copy', 'a dead end', 'which file holds the truth']) expect(rules).toContain(kind);
    expect(rules).toMatch(/A restatement of one function or one file, a list of the stack, a folder tree/);
  });

  // A card's knowledge index lists the notes of its own repositories, so a note in another folder is missed.
  it('puts a file in the folder of the repository its paths belong to, and makes no other folder', () => {
    const rules = readKnowledgeRules().replace(/\s+/g, ' ');
    expect(rules).toContain('Put the file in the folder named after the repository its `paths` belong to: the top of the knowledge folder for a repository at the project folder itself, `shared/` for paths in several repositories. Make no other folder.');
  });

  it('asks for the frontmatter description the Knowledge screen shows', () => {
    expect(readKnowledgeRules()).toMatch(/description/);
    expect(readKnowledgeRules().replace(/\s+/g, ' ')).toMatch(/one sentence that says when to read the file and what it holds/i);
  });

  // The Knowledge screen checks each path against the base branch, and a note can point at
  // design files in `.tasks/`, which git does not track.
  it('names the source and the paths a file depends on, only paths git tracks', () => {
    const rules = readKnowledgeRules().replace(/\s+/g, ' ');
    expect(rules).toMatch(/`source` is the card key and the commit the prompt names/);
    expect(rules).toMatch(/Name only paths git tracks on the base branch: never the card folder, `.tasks\/`/);
  });
});

describe('nolzu-optimize', () => {
  const text = () => skillText('nolzu-optimize');
  const prose = () => text().replace(/\s+/g, ' ');

  // This run has no card and no work behind it, so anything it adds comes from a model rather
  // than from what happened. That is the one thing knowledge must never hold.
  it('adds no knowledge of its own', () => {
    expect(prose()).toMatch(/do not invent knowledge/i);
    expect(prose()).toMatch(/already short and true, change nothing/i);
  });

  // `reads` is null for this row, so the shared test runs an empty body. Without this the line
  // that opens the folder could go, and the contradiction rule below would never fire.
  it('reads the other files in the folder, not only the one it rewrites', () => {
    expect(prose()).toMatch(/the other files in the knowledge folder the prompt names/i);
  });

  it('rewrites one file and leaves the others alone', () => {
    expect(prose()).toMatch(/change no other knowledge file, and change no source file/i);
  });

  // A trap reads as obvious once it is written down. Cutting it is how it gets learned again the
  // hard way, and it is the failure mode an optimize pass has.
  it('keeps a fact that reads as obvious', () => {
    expect(prose()).toMatch(/reads as obvious once it is written down/i);
    // The same bar as the wrap-up's: what one file shows goes, what took more stays.
    expect(prose()).toMatch(/cut what a reader now sees by opening one file of the code/i);
  });

  // The browser links to a file by path and a card's taught-by link points at it, so a rename
  // breaks both.
  it('never renames or moves the file', () => {
    expect(prose()).toMatch(/do not rename or move the file/i);
  });

  it('runs no git command, because the runner commits', () => {
    expect(text()).not.toMatch(/git commit|git add|git push/);
    expect(prose()).toMatch(/do not commit, and do not run any git command/i);
  });

  // Two knowledge files that disagree is a decision for a person, not for a rewrite pass.
  it('leaves a contradiction for a person', () => {
    expect(prose()).toMatch(/say so in the summary and leave both alone/i);
  });
});

// Learn this project: what people wrote and said, a few lines a
// person checks, and nothing generated from a scan of the code.
describe('nolzu-orient', () => {
  const prose = () => skillText('nolzu-orient').replace(/\s+/g, ' ');

  it('reads what people wrote and not a scan of the code', () => {
    expect(prose()).toMatch(/Read what people wrote, never a scan of the code: the README, a contributing guide, the agent instruction files/);
    expect(prose()).toMatch(/Do not read source code to learn what it does/);
  });

  it('asks at most four questions, one at a time, each with answer buttons', () => {
    expect(prose()).toMatch(/at most four questions in the whole run, one at a time/);
    for (const one of ['what agents get wrong', 'what is off limits', 'which command is right when several look right', 'what a domain word means']) expect(prose()).toContain(one);
  });

  it('writes at most three files of about 60 lines, every line with its source', () => {
    expect(prose()).toMatch(/At most three files in the knowledge folder, about 60 lines in all/);
    expect(prose()).toContain('`(from README.md)`');
    expect(prose()).toContain('`(told by the person)`');
    expect(prose()).toMatch(/A line you cannot give a source stays out/);
  });

  it('writes the project rules as prohibitions with their reason', () => {
    expect(prose()).toMatch(/each as a prohibition with its reason/);
  });

  it('leaves the commit to the runner, which holds the change for review', () => {
    expect(prose()).toMatch(/do not commit, and do not run any git command/i);
    expect(prose()).toMatch(/whatever the review setting says/);
  });
});

// Learn your repositories: one repository, its own files, and the two knowledge files of that
// repository, every line with where it was read.
describe('nolzu-learn-repo', () => {
  const prose = () => skillText('nolzu-learn-repo').replace(/\s+/g, ' ');

  it('reads the README, the CI files and the stack files of one repository, and not the code', () => {
    for (const one of ['the README', 'the CI files', 'the stack files', 'composer.json', 'pyproject.toml', 'go.mod']) expect(prose()).toContain(one);
    expect(prose()).toMatch(/Read no other repository: each one gets its own run/);
    expect(prose()).toMatch(/Do not read source code to learn what the repository does/);
  });

  it('writes what it is for and how to install, run, test, lint and build it, each with its source', () => {
    expect(prose()).toMatch(/What it is for, in one or two sentences/);
    expect(prose()).toMatch(/How to install, run, test, lint and build it/);
    expect(prose()).toContain('`(from README.md)`');
    expect(prose()).toMatch(/A step no file names stays "Not read"/);
  });

  it('changes its own run recipe section and nothing else', () => {
    expect(prose()).toMatch(/Change no other section and no other knowledge file/);
  });

  // A run wrote four files and none of the rules every source file of the project kept, so a later
  // change broke one and only a review saw it.
  it('writes the rules the code keeps everywhere it looked, each with its places', () => {
    expect(prose()).toContain('## Rules the code keeps');
    expect(prose()).toMatch(/one module owns a job/);
    expect(prose()).toMatch(/Keep a rule only when the search finds no other way/);
    expect(prose()).toMatch(/two or three places that keep it/);
  });

  it('leaves the commit to the runner, which holds the change for review', () => {
    expect(prose()).toMatch(/do not commit, and do not run any git command/i);
    expect(prose()).toMatch(/whatever the review setting says/);
  });
});

describe('nolzu-wrapup', () => {
  const text = () => skillText('nolzu-wrapup');
  const prose = () => text().replace(/\s+/g, ' ');

  // The one folder outside the card folder a run may write to. Project isolation is enforced by
  // the runner, and a skill that invented its own path would fight it.
  it('writes only into the knowledge folder the prompt names', () => {
    expect(prose()).toMatch(/knowledge folder is named separately in the prompt/i);
    expect(prose()).toMatch(/only folder outside the card folder you may write to/i);
  });

  // "No knowledge yet. It is earned from real work, never generated from a scan." is what the
  // empty state promises a person. A skill that summarizes the code to look busy breaks it.
  it('writes nothing when the card taught nothing', () => {
    expect(prose()).toMatch(/earned from the work, never generated from a scan/i);
    expect(prose()).toMatch(/taught nothing, write nothing/i);
  });

  it('prefers correcting a wrong file over adding another one', () => {
    expect(prose()).toMatch(/correcting is worth more than adding/i);
  });

  // A card kept every rule of the project and the wrap-up wrote only facts about the task.
  it('records a rule the card had to follow when the whole repository keeps it', () => {
    expect(prose()).toMatch(/a rule the card had to follow is knowledge too when the whole repository keeps it/i);
    expect(prose()).toContain('`## Rules the code keeps`');
    expect(prose()).toMatch(/a rule only this card's files keep is a task fact/i);
  });

  // The wrap-up bar.
  it('keeps a learning only past the bar, checked against the code, one entry at a time', () => {
    expect(prose()).toMatch(/losing it would cause rework and it will still hold in three months/i);
    // The bar is the cost to find a fact again. A Codex run once dropped a test no script runs as
    // "visible in the code and tests".
    expect(prose()).toMatch(/learning it took reading more than one file or running something, or the obvious reading of the code is wrong/i);
    expect(prose()).toMatch(/"It is in the code" is no reason to drop a discovery/);
    expect(prose()).toMatch(/a decision and its reason count too, because the code keeps only the choice/i);
    expect(prose()).toMatch(/check each claim against the code before you write it/i);
    expect(prose()).toMatch(/change one entry at a time/i);
    // A wrap-up once dropped a fact as already in AGENTS.md, which said otherwise.
    expect(prose()).toMatch(/before you drop one as already written down, open the file that says it/i);
  });

  // A QA report is written over by the next QA, so the prompt carries how the card went.
  it("reads the card's history from the prompt to find what cost time", () => {
    expect(prose()).toContain('`## What the person said`');
    expect(prose()).toContain('`## What this card went through`');
  });

  // The runner makes the commit, in the knowledge lane, so the diff is one commit per change and
  // a revert has something to revert. A git command in the skill takes that away.
  it('runs no git command, because the runner commits', () => {
    expect(text()).not.toMatch(/git commit|git add|git push/);
    expect(prose()).toMatch(/do not commit, and do not run any git command/i);
  });

  // The runner reads the knowledge folder to see what changed. This file is for the person.
  it('records what it touched for a reader, and says the folder is the truth', () => {
    expect(text()).toContain('<card folder>/wrapup/changes.md');
    expect(prose()).toMatch(/runner reads the knowledge folder itself/i);
  });

  // A file named after the card cannot be found by the next person, who searches the subject.
  it('names a knowledge file after its subject, not after the card', () => {
    expect(prose()).toMatch(/named after the subject rather than after the card/i);
    expect(readKnowledgeRules().replace(/\s+/g, ' ')).toMatch(/never after a card/i);
  });

  // Wrap-up runs after the merge or the pull request, and the checkout goes when the card closes.
  // A skill that reads only the checkout has nothing to read on a card somebody comes back to.
  it('reads the card folder files that outlive the checkout', () => {
    expect(text()).toContain('<card folder>/implement/pr.md');
    expect(prose()).toMatch(/outlive its checkout/i);
  });
});

describe('nolzu-qa', () => {
  const text = () => skillText('nolzu-qa');
  // These files are wrapped at 100 columns, so a sentence a test looks for can carry a line
  // break in the middle. Prose assertions read this, exact ones read `text()`.
  const prose = () => text().replace(/\s+/g, ' ');

  it('carries the shared verdict rules unchanged', () => {
    const copy = readFileSync(path.join(skillsDir, 'nolzu-qa', 'verdict.md'), 'utf8');

    expect(copy).toBe(readVerdictRules());
  });

  it('links the verdict rules, so the lint own link check covers the copy', () => {
    expect(text()).toContain('](verdict.md)');
  });

  // The rule text is written by hand and the parser reads the constant. Without this a rename of
  // the constant would leave the skill printing a line nothing looks for.
  it('writes the verdict line the constants describe, in the rules and in the skill', () => {
    for (const where of [readVerdictRules(), text()]) {
      expect(where).toContain(VERDICT_PREFIX);
      for (const verdict of VERDICTS) expect(where).toContain(`${VERDICT_PREFIX}${verdict}`);
    }
  });

  // A skill with a strong output format ignores what is only appended, and a linked file is one
  // step further away again. The line the run has to print belongs in the format itself.
  it('prints the verdict before the line that closes the run', () => {
    const at = text().search(/^#+ .*output format/im);
    const section = text().slice(at);

    expect(section.indexOf(VERDICT_PREFIX)).toBeGreaterThan(-1);
    expect(section.indexOf(VERDICT_PREFIX)).toBeLessThan(section.indexOf(SENTINEL_COMPLETE));
  });

  // QA reports what is true. A QA run that fixes what it found leaves nobody able to say whether
  // the card ever worked, and the fix never goes through the implement phase's own checks.
  it('changes no source file and fixes nothing', () => {
    expect(prose()).toMatch(/change no source file/i);
  });

  // QA owns the stack lane, and the runner loads and unloads around the run. A skill that starts
  // the stack itself would leave one running when the run dies.
  it('leaves the stack to the runner, and calls a missing one blocked', () => {
    expect(text()).not.toMatch(/stack load|stack unload|docker compose/);
    expect(prose()).toMatch(/do not start or stop it yourself/i);
    expect(text()).toContain('BLOCKED');
  });

  // A check that needs data the app lacks, such as a user with a certain role, is where a run
  // invents a way around it. Writing data outside the checkout is the project's call: the app may
  // talk to a shared database. So the default creates nothing and names what is missing.
  it('creates test data only when the project allows it, and names what is missing otherwise', () => {
    expect(prose()).toMatch(/create test data only where the project's QA instructions allow it, never on another host/i);
    expect(prose()).toContain('`qa-<card key>-`');
    expect(prose()).toMatch(/delete it when you are done/i);
    expect(prose()).toMatch(/data the app does not have, .* it is BLOCKED naming exactly what is missing, never FAIL/i);
  });

  // An acceptance check nobody could observe is the case that turns QA into a rubber stamp.
  it('refuses to pass a check it could not observe', () => {
    expect(prose()).toMatch(/could not observe is not a pass/i);
  });

  // The plan phase writes the list and QA reports on it, step for step. A card planned before the
  // list existed has none, and QA still has to check it.
  it('reports one row per planned check in its order, and makes its own list without one', () => {
    expect(text()).toContain('<card folder>/qa/checks.md');
    expect(prose()).toMatch(/one row for each of its steps, in its order/i);
    expect(prose()).toMatch(/without it, .* make your own list: the project's own checks, then the acceptance checks/i);
  });

  // The page reads section 2 by its heading and its rows. The words and the example are held to
  // the parser in `packages/ui/src/ticket/qa.test.ts`.
  it('names the three section headings the page finds the checklist by', () => {
    for (const heading of ['## 1. Verdict', '## 2. What QA checked', '## 3. What was not checked']) expect(text()).toContain(heading);
  });

  // A QA run once lost a screenshot to two names that differed only in case, and the screenshots sat
  // in the checkout the browser writes to. The output check reads the same lines.
  it('keeps its evidence in qa/evidence/ under lower-case names, moved out of the checkout', () => {
    expect(text()).toContain('<card folder>/qa/evidence/');
    expect(prose()).toMatch(/lower-case words, such as `3-api-down-message.png`, and never reuse a name/);
    expect(prose()).toMatch(/The browser saves screenshots in the checkout you start in. Move each one into `<card folder>\/qa\/evidence\/`/);
    expect(text()).toContain('       How: ');
    expect(text()).toContain('       Evidence: qa/evidence/');
  });

  // A PASS needs every must criterion passed with its evidence, and
  // a check QA could not see is never a pass.
  it('passes on the must checks with evidence only, and never on what it could not see', () => {
    const rules = readVerdictRules().replace(/\s+/g, ' ');
    expect(rules).toMatch(/PASS means every `must` acceptance check has a `pass` row with its `Evidence:` line/);
    expect(rules).toMatch(/A `should` check that failed or was not reached does not stop a PASS/);
    expect(prose()).toMatch(/Not seen is not checked, never a pass/);
    expect(prose()).toMatch(/`## 1. Verdict`: the review block. Bullets only, at most 15, none starting with a digit/);
  });
});

describe('nolzu-implement', () => {
  const text = () => skillText('nolzu-implement');

  // The compare page reads the pull request text.
  it('names the text a person confirms later, and the summary', () => {
    for (const file of ['<card folder>/implement/pr.md', '<card folder>/implement/summary.md']) {
      expect(text()).toContain(file);
    }
  });

  // An npm cache the wall kept out of ~/.npm once landed in the card folder, thousands of files.
  it('keeps package caches and install logs out of the card folder', () => {
    expect(text().replace(/\s+/g, ' ')).toContain('A package cache or an install log never goes in the card folder');
  });

  // Nolzu never commits code. The person writes the message, or asks for one, on the Changes tab.
  it('writes no commit message', () => {
    expect(text()).not.toMatch(/COMMIT\.md|`type\(scope\): subject`/i);
    expect(text().replace(/\s+/g, ' ')).toMatch(/Write no commit message/);
  });

  // Pushing and opening a pull request are a person's confirmation in the UI. Either command in a
  // skill turns a demo run into a real pull request on somebody's repository.
  it('never pushes and never opens a pull request', () => {
    expect(text()).not.toMatch(/git push|gh pr create/);
    expect(text()).toMatch(/never push/i);
  });

  // The body and not the description, which says it too and would pass this on its own.
  it('asks for the test before the code in a pure module', () => {
    const body = text().split(/^---$/m).slice(2).join('---');

    expect(body).toMatch(/for a pure module, write the test first/i);
  });

  // A run that stopped early leaves its changes in the checkout, and Nolzu commits nothing. The next
  // run finds its place from this file, so it has to be both written and read.
  it('updates the progress file after every step and reads it first', () => {
    const body = text();

    expect(body).toContain('<card folder>/implement/progress.md');
    expect(body).toMatch(/after every step/i);
    expect(body).toMatch(/read .*progress\.md.* first|start by reading .*progress\.md/i);
    expect(body).toMatch(/run the project's checks/i);
  });

  // The record QA checks. A Fix it run once rewrote it and lost the line that the tests came first,
  // so a run adds to it and replaces only the review block.
  it('keeps the record: Base, proof per step, red then green, the review block at run end', () => {
    const body = text();
    const flat = body.replace(/\s+/g, ' ');
    const order = ['    Base: ', '    ## Before you approve', '    - Deviations: ', '    - Tests: ', '    ## Steps done', '       Red: ', '       Green: ', '       Check: ', '    - Fix: '];
    const places = order.map((part) => body.indexOf(part));
    expect(places.every((place) => place !== -1)).toBe(true);
    expect(places).toEqual([...places].sort((a, b) => a - b));
    expect(flat).toContain('The code you read is at commit');
    // A run of several repositories gets no commit line, and implement may not run git to find one.
    expect(flat).toContain('`Base: the prompt named no commit.`');
    expect(flat).toContain('never remove or rewrite a line an earlier run wrote');
    expect(flat).toContain('A re-run replaces only this block');
    expect(flat).toMatch(/a fix that a test can reproduce: the failing test first, then the fix/i);
  });

  // Each deviation says what it costs if the call was wrong, and pr.md becomes the pull request body.
  it('writes deviations as rulings and a pull request text with its parts', () => {
    const body = text();
    expect(body).toMatch(/^ {4}- Step 2: .+ Why: .+ If wrong: /m);
    for (const part of ['`## What changed`', '`## How to test`']) expect(body).toContain(part);
    expect(body.replace(/\s+/g, ' ')).toContain('as the pull request body');
  });

  it('does not commit, because a commit is a person\'s action in the composer', () => {
    expect(text()).not.toMatch(/git commit/);
    expect(text()).toMatch(/do not commit/i);
  });
});

// The two phases whose input is what a person typed. Both used to promise a file the runner
// had written into the card folder, and no runner ever wrote one, so a run opened nothing and said
// the input was missing. The text is the only contract here, so these are the tests that hold it.
describe.each(['nolzu-investigate', 'nolzu-research'])('%s reads what a person gave it', (folder) => {
  const prose = () => skillText(folder).replace(/\s+/g, ' ');

  // The promise that regressed once. It reads as harmless and it sends the run looking for a file
  // that is never there.
  it('does not say the runner wrote the input', () => {
    expect(prose()).not.toMatch(/runner (wrote|writes|has written|had written)/i);
  });

  it('says a person copies the file into the card folder', () => {
    expect(prose()).toMatch(/copied .{0,24}into the card folder/i);
  });

  // A card with nothing on it is the case that used to end in a thin artifact nobody could use.
  // The title has to be one of the three sources: it is the only field the Add card dialog makes
  // the person fill in, so a rule that looked at the ticket text and the extra context alone would
  // refuse the most common card there is.
  it('asks with needs_input only when the title, the ticket text and the extra context all say nothing', () => {
    expect(prose()).toMatch(/only when the title, the ticket text and the extra context together say nothing/i);
    expect(prose()).toMatch(/needs_input/);
  });

  // The other half of the same rule. Said the other way round, a title alone is enough to run on.
  it('says a title on its own is enough to work from', () => {
    expect(prose()).toMatch(/title and nothing more/i);
  });
});

// What a phase met on the way is kept, and the wrap-up turns it into
// knowledge. The finish rules hold the form, so one copy says it for every phase.
describe('the shared finish rules', () => {
  const prose = () => readFinishRules().replace(/\s+/g, ' ');

  it('ask every phase to add its discoveries as one line each, never rewriting what is there', () => {
    expect(readFinishRules()).toContain(DISCOVERIES);
    expect(readFinishRules()).toContain('    - <what you found>, in <a path>: <why it matters> (<phase>)');
    // A short paragraph, so the evidence fits, and a fact rather than "no knowledge file covers X".
    expect(prose()).toMatch(/as one list item on one line, at most about four sentences: the fact, its paths and lines, the evidence, why it matters/);
    expect(prose()).toMatch(/Write the fact, never a gap/);
    expect(prose()).toMatch(/never change or remove a line that is already there/i);
    expect(prose()).toMatch(/when nothing surprised you, write nothing/i);
  });

  // A model wraps prose at 80 or 100 columns by habit, and the Files viewer shows each break. The
  // project's own files are not Nolzu's to restyle, so the rule stops at the folders Nolzu draws.
  it('ask for one paragraph or list item per line in the card and knowledge folders, with no break inside a sentence', () => {
    expect(prose()).toMatch(/in every file you write in the card folder or the knowledge folder, put each paragraph and each list item on one line/i);
    expect(prose()).toMatch(/never break a sentence over two lines/i);
    expect(prose()).toMatch(/code and the project's own docs keep the project's style/i);
  });

  // The contract every phase follows. The review block is bullets with no leading digit, because
  // `stepsDone` and `parsePlan` read a leading number as a step.
  it('give the contract: the reader, the review block, evidence, ownership, size, ask or decide', () => {
    expect(prose()).toContain('Write for a reader who has only the card folder, the repository and the knowledge folder');
    expect(readFinishRules()).toContain('`## Before you approve`');
    expect(prose()).toContain('At most 15 lines, all bullets, none starting with a digit');
    expect(prose()).toContain('names the command and quotes its real output line');
    expect(prose()).toMatch(/"Not checked" and "could not read" are results/);
    expect(prose()).toContain('never the process or history of the work');
    expect(prose()).toContain('Write only the files your skill names, each where it says');
    expect(prose()).toContain('Scale to the card');
    expect(prose()).toContain('Refine, Architecture, Design and Plan ask');
    expect(prose()).toContain('Implement and QA decide');
  });

  // Runs lost a call to the shell checker for each `cd`, loop and `/tmp` file.
  it('give the shell rule: one plain command per call, scratch files in the card folder', () => {
    expect(prose()).toContain('one plain command per call from the folder you start in: no `cd`, no variables');
    // A run on several repositories is told to use `git -C <repo>`, so only the folder it is in is ruled out.
    expect(prose()).toContain('no `git -C` on that folder. Reach another repository with the folder option the prompt names');
    expect(prose()).toContain('Put scratch files in `<card folder>/<phase>/work/`, never in `/tmp`');
    // An implement run lost three calls to a heredoc, refused as expansion obfuscation.
    expect(prose()).toContain('Create and change files with your file tools, never a shell redirect or heredoc');
  });

  // A real pr.md ended on the engine's own line. Nolzu strips such lines after each run too, and this
  // rule is the first wall.
  it('forbid any tool mention, generated-by line or co-author trailer in the files for other people', () => {
    expect(prose()).toContain('`<card folder>/share/` and `<card folder>/implement/pr.md` leave the card for colleagues and reviewers.');
    expect(prose()).toContain('They never mention AI, agents, models, Nolzu, Claude, Codex, Cursor or any other tool or harness, and they carry no generated-by line, no robot emoji line and no co-author trailer.');
  });

  // A real card left npm logs and four coverage files beside pr.md, and the Files tab showed them all
  // as if a person should read them. The expected files stay on top, the rest goes one folder down.
  it('keep the expected files on top and everything else in work/, or the folder the skill names', () => {
    // The share files, discoveries.md and qa/checks.md sit outside the phase folder, so the rule on
    // extra files and folders holds inside the phase folder only.
    expect(prose()).toContain('Write only the files your skill names, each where it says. In `<card folder>/<phase>/` they sit at the top, and anything else you store there goes in `work/` under it, or in the subfolder your skill names. Make no other folder there.');
  });
});

// A plain summary and hand-test steps for people outside the card. Implement writes
// both on every run, QA corrects the steps after it tried them, and the wrap-up matches both to the end.
describe('the share files', () => {
  const prose = (folder: string) => skillText(folder).replace(/\s+/g, ' ');

  it('implement writes both on every run, a fix round included, for a reader who never saw the card', () => {
    for (const file of SHARE_FILES) expect(prose('nolzu-implement')).toContain(`<card folder>/${file}`);
    expect(prose('nolzu-implement')).toContain('bring both up to date on every run of this phase, a fix after QA, a pull request comment or a discussion included');
    expect(prose('nolzu-implement')).toContain('a person who does not write code how to try the change by hand: where to go, what to do, what they should see');
    expect(prose('nolzu-implement')).toContain('When nobody can try it by hand');
    expect(prose('nolzu-implement')).toContain('Neither file names the card, its phases or how the work was done');
  });

  it('QA corrects the test steps and nothing else there, and the wrap-up gives both a last pass', () => {
    expect(prose('nolzu-qa')).toContain('Correct `<card folder>/share/TESTING.md` when it is there');
    // A colleague's machine is not this one: a QA run once told readers to fix a service only its own stack missed.
    expect(prose('nolzu-qa')).toContain("Leave out this machine's setup, such as a service that is down: that is a discovery.");
    expect(prose('nolzu-qa')).toContain('Change no other file in `<card folder>/share/`');
    expect(prose('nolzu-wrapup')).toContain('Give `<card folder>/share/SUMMARY.md` and `<card folder>/share/TESTING.md` a last pass when they are there');
  });
});

describe.each(CARD_PHASES)('%s in its output format', (folder) => {
  const section = () => {
    const text = skillText(folder);
    return text.slice(text.search(/^#+ .*output format/im)).replace(/\s+/g, ' ');
  };

  it('names the discoveries file and the no-wrap rule', () => {
    expect(section()).toContain(DISCOVERIES);
    expect(section()).toMatch(/each paragraph and each list item of every file in the card folder(?: and the knowledge folder)? on one line/i);
  });
});

describe('the phase documents point at each other', () => {
  const prose = (folder: string) => skillText(folder).replace(/\s+/g, ' ');
  const at = (text: string, part: string) => {
    const where = text.indexOf(part);
    expect(where, part).toBeGreaterThan(-1);
    return where;
  };

  // Kind and Branch stay right under the title, where `refinedBranch` reads them, and the review block
  // comes right after them. The criteria and question lines are the ones `refinedCriteria` and
  // `refinedQuestions` read, and the sections are the ones the output check asks for.
  it('refine writes the sections in order, with ids, levels and the review block', () => {
    const text = skillText('nolzu-refine');
    const order = ['# <KEY>: <title', 'Kind: feature', 'Branch: <two', '## Before you approve', '## Problem', '## Scope', '## Assumptions', '## Acceptance checks', '## Open questions', '## What the code does today', '## Rules that apply', '## Out of scope', '## Read first', 'Repositories: api, web'];
    const places = order.map((part) => at(text, part));
    expect(places).toEqual([...places].sort((a, b) => a - b));
    expect(text).toContain('- A1: ');
    expect(text).toMatch(/^ {4}- AC1 \(must\): .+\n {6}Check: /m);
    expect(text).toMatch(/^ {4}- AC2 \(should\): /m);
    expect(text).toMatch(/^ {4}- Q1: .+\? Default: .+\. blocks: yes$/m);
    expect(text).toMatch(/^ {4}Read at: /m);
    expect(text).toContain('`blocks: yes`');
    expect(text).toContain('`blocks: no`');
    expect(prose('nolzu-refine')).toMatch(/at most three/i);
    // The skeleton, out of its code block, reads back with its levels, checks and question.
    const skeleton = text.split('\n').filter((line) => line.startsWith('    ')).map((line) => line.slice(4)).join('\n');
    expect(refinedCriteria(skeleton).map((one) => [one.id, one.level, one.check !== null])).toEqual([['AC1', 'must', true], ['AC2', 'should', true]]);
    expect(refinedQuestions(skeleton)).toEqual([{ id: 'Q1', question: 'Should the search also match ingredients?', answer: 'no, titles only', blocks: true }]);
    // A Codex run once chose to fail the whole list on one bad recipe, marked it
    // blocks: no, and nobody was asked.
    expect(prose('nolzu-refine')).toMatch(/changes what a person using the product sees or gets, such as an error or a fallback, hiding or showing, failing or carrying on, is `blocks: yes` even with a default/);
  });

  // On a small model, two briefs of four put each `Check:` on its check's own line, where the output
  // check does not read it, because the rule to write each list item on one line seemed to cover it.
  it('refine shows a whole check with its Check: line where it gives the rule', () => {
    expect(prose('nolzu-refine')).toContain("Never put `Check:` on the check's own line");
    expect(skillText('nolzu-refine')).toMatch(/^ {4}- AC3 \(should\): .+\n {6}Check: /m);
  });

  it.each(['nolzu-refine', 'nolzu-research', 'nolzu-investigate'])('%s keeps the Check: line out of the one line rule', (folder) => {
    const text = skillText(folder);
    expect(text.slice(text.search(/^#+ .*output format/im)).replace(/\s+/g, ' ')).toContain('A `Check:` line is the one exception: it goes on its own line under its acceptance check.');
  });

  // The other phases that write Q lines carry the same rule, so an epic or a Research card does not
  // hide a choice the brief would have asked about.
  it.each(['nolzu-architecture', 'nolzu-design', 'nolzu-research', 'nolzu-investigate'])('%s marks a question about what a person using the product sees as blocks: yes', (folder) => {
    expect(prose(folder)).toMatch(/`(?:blocks: )?yes`.{0,40}changes what a person using the product sees or gets|changes what a person using the product sees or gets.{0,40}is `blocks: yes`/);
  });

  // The sections in the order the output check asks for them, and lines its readers take back.
  it('architecture opens with the review block, gives the interfaces, D ids and open questions, and keeps touch points and test surfaces', () => {
    const text = skillText('nolzu-architecture');
    const order = ['## Before you approve', '## The shape', 'Read at: ', '## The pieces', '## Where they meet', '## Interfaces', '## The data', '## The decisions', '## What is still open', '## Touch points', '## Test surfaces', '## Not doing', '## Read first'];
    const places = order.map((part) => at(text, `    ${part}`));
    expect(places).toEqual([...places].sort((a, b) => a - b));
    expect(text).toContain('| Piece | File or module | What changes |');
    const skeleton = text.split('\n').filter((line) => line.startsWith('    ')).map((line) => line.slice(4)).join('\n');
    expect(decisionLines(skeleton)).toEqual([{ id: 'D1', text: expect.stringMatching(/ Not: .+ Keep: /) }]);
    expect(refinedQuestions(skeleton, '## What is still open')).toEqual([{ id: 'Q2', question: 'Should the search match tags too?', answer: 'no, titles only', blocks: true }, { id: 'Q3', question: 'Should the filter get its own module?', answer: 'no, it stays in recipes.ts', blocks: false }]);
    expect(prose('nolzu-architecture')).toMatch(/the errors included, and every header the other side needs/);
    expect(prose('nolzu-architecture')).toMatch(/Go on from the brief's last `Q` id/);
    expect(prose('nolzu-architecture')).toMatch(/Plan goes on from your last id/);
  });

  it('design names the acceptance checks each screen covers', () => {
    expect(prose('nolzu-design')).toMatch(/acceptance checks it covers, by their ids/i);
  });

  // The design left the routing, the answer shapes and the error words open in earlier runs, so each
  // screen gives its address, its named states with their words, and where their data comes from.
  it('design gives each screen its address, named states, data and question in a fixed order', () => {
    const text = skillText('nolzu-design');
    const order = ['## Before you approve', '## Screens', 'Read at: ', 'Tokens: ', '### recipe-list.html', 'Address: ', 'States:', '- No match (AC1, AC2): ', 'Data: ', 'Reuse: ', 'Question: Q3: ', '## Not doing', '## Read first'];
    const places = order.map((part) => at(text, `    ${part}`));
    expect(places).toEqual([...places].sort((a, b) => a - b));
    expect(text).toMatch(/^ {4}Question: Q3: .+\? Default: .+\. blocks: yes$/m);
    expect(prose('nolzu-design')).toMatch(/never the design file's name/);
    expect(prose('nolzu-design')).toMatch(/named as its heading in the HTML file names it/);
  });

  // The design is the screen as it ships, so its text has to ask for every state, one shared tokens
  // file each screen links, the repository's own look first, and nothing a sandboxed frame refuses.
  it('design draws every state from one tokens.css taken from the repository, with no script', () => {
    const text = prose('nolzu-design');
    expect(text).toContain('<card folder>/design/tokens.css');
    expect(text).toContain('<card folder>/design/<screen-name>.html');
    expect(text).toContain('<link rel="stylesheet" href="tokens.css">');
    for (const state of ['nothing in it yet', 'a load that failed', 'far longer than anyone expected']) expect(text).toContain(state);
    expect(text).toMatch(/When it has a look, the design follows it and does not replace it/);
    expect(text).toMatch(/has no look yet, .*propose one/);
    expect(text).toContain('Write no script tag at all');
    expect(text).toContain('under 100 kB');
    expect(text).not.toMatch(/mockup/i);
  });

  it('plan reads the architecture and the design, the old mockups list when there is no design, and writes its sections with Covers on each step', () => {
    const text = skillText('nolzu-plan');
    for (const file of ['<card folder>/architecture/architecture.md', '<card folder>/design/design.md', '<card folder>/mockups/mockups.md']) expect(text).toContain(file);
    expect(at(text, '<card folder>/design/design.md')).toBeLessThan(at(text, '<card folder>/mockups/mockups.md'));
    expect(text).toContain('read that one when there is no design.md');
    // The sections in the order the output check asks for them, and the step fields in the order of
    // the example, which is the one parsePlan reads.
    const order = ['## Before you approve', '## Approach', 'Read at: ', '## Decisions', '## Steps', '## Risks', '## Order', '## Settled questions', '## Rules that apply', '## Not doing', '## Read first'];
    const places = order.map((part) => at(text, `    ${part}`));
    expect(places).toEqual([...places].sort((a, b) => a - b));
    const fields = ['Files: ', 'Uses: ', 'Copy: ', 'Tests: ', 'Check: ', 'Undo: ', 'Covers: '].map((field) => at(text, `       ${field}`));
    expect(fields).toEqual([...fields].sort((a, b) => a - b));
    expect(text).toMatch(/^ {4}- D1: .+ Not: /m);
    expect(text).toContain('       Covers: AC1, AC2');
    expect(text).toContain('    2. AC1 (must): Type a word');
    expect(text).toMatch(/^ {7}How: /m);
  });

  // Two tasks of a few lines each once paid a full run chain, and a step that covered none
  // became a task of its own. Each task's ticket copies the epic ids its step names.
  it('plan folds a small helper into the step that uses it on an epic, and names the decisions a step builds on', () => {
    const text = prose('nolzu-plan');
    expect(text).toContain('fold a small helper, or a step that covers none, into the step that first uses it');
    expect(text).toContain('by their `D` ids on its Uses line');
    expect(text).toContain("On an epic, go on from the architecture's last `D` id.");
    // The Q ids go on from the brief through the architecture and the design, and Plan settles them all.
    expect(text).toContain('and on an epic those of the architecture and the design too');
  });

  // The seed copies the epic's checks under its key, so a task's own AC1 never clashes with them.
  it("refine numbers a task's own checks and names the epic check each one serves", () => {
    expect(prose('nolzu-refine')).toContain('number your own from `AC1` anyway, and end each one that serves an epic check with it, such as `(serves APP-5 AC2)`');
    // Once an epic plan's check said the id reader gives no id for abc, and an earlier task
    // built it to give abc. The task's Refine checks what it carries against the code.
    expect(prose('nolzu-refine')).toContain('check every carried check and fact against the code in the checkout. When the code contradicts one, write the check the code supports and name the change under My calls');
  });

  // QA and the wrap-up cannot tell a planned change from a mistake without it.
  it('implement reads every document before it and writes its deviations', () => {
    const text = skillText('nolzu-implement');
    for (const file of ['<card folder>/refine/refined.md', '<card folder>/architecture/architecture.md', '<card folder>/design/design.md', '<card folder>/mockups/mockups.md', '<card folder>/implement/deviations.md']) expect(text).toContain(file);
    expect(text).toContain('`None.`');
  });

  // Implement builds to the approved design, so the look is never invented there.
  it('implement reuses the design tokens, matches the screens and lists each change from the design', () => {
    const text = prose('nolzu-implement');
    expect(text).toContain('Reuse the values in `<card folder>/design/tokens.css`');
    expect(text).toContain("or in the epic's `tokens.css` the prompt names");
    expect(text).toMatch(/Match the layout and the words of the screen's HTML file/);
    expect(text).toMatch(/left the plan or the design/);
  });

  it('qa compares the running screen with the design when it has a browser, and says so when it has none', () => {
    const text = prose('nolzu-qa');
    expect(text).toContain('<card folder>/design/design.md');
    expect(text).toMatch(/With a browser, open the running screen and the design file, and write in the report what differs/);
    expect(text).toMatch(/Without a browser, say in the report that the screens were not compared/);
  });

  it('qa reads the deviations and gives a failed row its expected and actual lines', () => {
    const text = skillText('nolzu-qa');
    expect(text).toContain('<card folder>/implement/deviations.md');
    expect(text).toContain('3. fail: AC2 (must): ');
    expect(text).toContain('       Expected: ');
    expect(text).toContain('       Actual: ');
  });

  it('wrap-up reads the discoveries first, and says which became knowledge', () => {
    const text = skillText('nolzu-wrapup');
    expect(at(text, DISCOVERIES)).toBeLessThan(at(text, '<card folder>/plan/plan.md'));
    for (const file of ['<card folder>/refine/refined.md', '<card folder>/implement/deviations.md']) expect(text).toContain(file);
    expect(prose('nolzu-wrapup')).toMatch(/the epic's `discoveries.md`/);
    expect(prose('nolzu-wrapup')).toMatch(/what became of each discovery/i);
  });
});

// The answers of the Research board and the Scout assessment open with the answer and how sure the
// run is, and Make a Delivery card hands Refine a draft in the brief's own lines. The headings are
// the ones the output check asks for, and `## Sources` stays last for the chips.
describe('the answers say how sure they are', () => {
  const at = (text: string, part: string) => {
    const where = text.indexOf(part);
    expect(where, part).toBeGreaterThan(-1);
    return where;
  };
  const skeleton = (folder: string) =>
    skillText(folder)
      .split('\n')
      .filter((line) => line.startsWith('    '))
      .map((line) => line.slice(4))
      .join('\n');

  it.each([
    ['nolzu-research', ['## Why', '## What this does not answer', '## Searched and not found', '## If this becomes a card', '## Sources']],
    ['nolzu-investigate', ['## What was reported', '## What was found', '## Hypotheses tried', '## The fix or next step', '## Searched and not found', '## If this becomes a card', '## Sources']],
  ])('%s opens with the answer and a confidence line, and keeps its sections in order', (folder, headings) => {
    const text = skeleton(folder);
    expect(text).toMatch(/^<The [^>]+, in one sentence\.>\nConfidence: \w+, because /m);
    const places = ['Confidence: ', ...headings].map((part) => at(text, part));
    expect(places).toEqual([...places].sort((a, b) => a - b));
    // The draft reads back as the brief reads its own lines.
    const draft = `## Acceptance checks\n${text.slice(text.indexOf('## If this becomes a card') + 26, text.indexOf('## Sources'))}`;
    expect(refinedCriteria(draft).map((one) => [one.id, one.level, one.check !== null])).toEqual([['AC1', 'must', true]]);
    expect(refinedQuestions(text, '## If this becomes a card').filter((one) => one.id !== null).map((one) => [one.id, one.blocks])).toEqual([['Q1', false]]);
    expect(text).toMatch(/^Problem: /m);
    expect(text).toMatch(/^Change: /m);
    // Markdown reads a line right under a list item as part of that item, so the Research page would
    // draw the places to change inside the last question. A blank line keeps it a paragraph.
    expect(skillText(folder)).toMatch(/\n\n {4}Change: /);
    const prose = skillText(folder).replace(/\s+/g, ' ');
    expect(prose).toContain('A claim you did not trace gets `(not checked)` after it.');
    expect(prose).toContain('`(confidence: low)`');
  });

  it('investigate gives each hypothesis one result', () => {
    expect(skeleton('nolzu-investigate')).toMatch(/^- .+\. Result: ruled out\. /m);
    expect(skillText('nolzu-investigate').replace(/\s+/g, ' ')).toContain('`held`, `ruled out` or `not settled`');
  });

  // An answer once listed options and took no side, so Refine had to guess three things.
  it('research takes a side on the options it finds', () => {
    expect(skillText('nolzu-research').replace(/\s+/g, ' ')).toContain('take a side: say which one the code points to, and why');
  });

  it('assess says how sure the cause is and what would change the call, with no heading inside a section', () => {
    const text = skillText('nolzu-assess');
    expect(text).toMatch(/^ {7}Confidence: medium, because .+\n {7}What would change it: /m);
    expect(text.replace(/\s+/g, ' ')).toContain('Put no heading inside a section, at any level');
  });

  it('refine starts from a draft a Research answer hands it', () => {
    expect(skillText('nolzu-refine').replace(/\s+/g, ' ')).toContain('When the extra context is a Research answer with `## If this becomes a card`');
  });
});

// A review round allows no heading, so its summary is the review block, and a re-review says what
// became of each earlier issue through the round itself.
describe('nolzu-pr-review reads its earlier rounds', () => {
  const prose = () => skillText('nolzu-pr-review').replace(/\s+/g, ' ');

  it('reads every earlier round first and repeats an issue that is still open', () => {
    expect(prose()).toContain('Read every earlier round before the diff');
    expect(prose()).toContain('"Still open from round 1."');
    expect(prose()).toContain('One that is fixed stays out of this round');
  });

  it('keeps to correctness and the stated intent', () => {
    expect(prose()).toContain('is the change correct, and does it do what its description says');
  });

  // A round marked a change that broke a rule every other file keeps as a suggestion, so it read as
  // optional.
  it('marks a broken rule of the code or of the knowledge as an issue', () => {
    expect(prose()).toContain('A change that breaks a rule the rest of the code keeps, or a rule in the project\'s knowledge, is an `issue`, not a `suggestion`');
  });

  it('writes the summary as the review block, with the verdict and the counts', () => {
    const text = skillText('nolzu-pr-review');
    const order = ['    Verdict: changes needed. ', '    Findings: 1 issue, ', '    Earlier issues: ', '    Not reviewed: '];
    const places = order.map((part) => text.indexOf(part));
    expect(places.every((place) => place !== -1)).toBe(true);
    expect(places).toEqual([...places].sort((a, b) => a - b));
    for (const verdict of ['`changes needed`', '`questions first`', '`ready to merge`']) expect(prose()).toContain(verdict);
  });
});

// The triage file is parsed whole or refused whole, so the skill has to give its exact shape, every
// verdict, and the rule that it posts nothing.
describe('nolzu-feedback writes the triage blocks', () => {
  const text = () => skillText('nolzu-feedback');
  const prose = () => text().replace(/\s+/g, ' ');

  it('gives the four line block and the five verdicts', () => {
    expect(text()).toMatch(/^T3: fix\nSummary: .+\nReason: .+\nReply: .+$/m);
    for (const verdict of ['`fix`', '`reject`', '`clarify`', '`defer`', '`none`']) expect(prose()).toContain(verdict);
  });

  it('posts nothing and keeps earlier verdicts', () => {
    expect(prose()).toContain('Commit nothing, push nothing and post nothing');
    expect(prose()).toContain('An earlier verdict stands unless a newer message changes it');
  });
});
