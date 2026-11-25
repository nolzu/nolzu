import { checkOutputs, RUN_RECIPE_FILE } from '@nolzu/core';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ASK_PHASE, NEEDS_INPUT_PREFIX, SENTINEL_COMPLETE } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { detectSentinel } from './engine.ts';
import { askPrompt, buildPrompt, CARD_NOTES, DISCOVERIES_FILE, KNOWLEDGE_INDEX_CAP, nextStep, pickKnowledge, type PromptInput, QA_CHECKS_FILE, READ_FIRST, readFirstPaths, resumeMessage, serversLine, stepsDone, swapPromptLine } from './prompt.ts';

const card: PromptInput = {
  phase: 'refine',
  key: 'PROJ-123',
  title: 'Add sign in',
  ticket: 'A person signs in with an email and a password.',
  extra: '',
  readOnly: true,
  folder: '../../.tasks/PROJ-123',
};

// The whole prompt, stored, so a wording change has to show up in the diff and be looked at.
const REFINE = `Read \`../../.tasks/PROJ-123/refine/instructions.md\` first. It holds the method for this phase, and this run follows it.

Run the refine phase for PROJ-123.

The card folder is \`../../.tasks/PROJ-123/\`. Every file of this card lives there, and the
skills call it the card folder. Write what you produce to \`../../.tasks/PROJ-123/refine/\`,
and the short summary to \`../../.tasks/PROJ-123/refine/summary.md\`.

The code of this card is in the folder you start in, \`./\`, its own checkout. Read the code
there, and name a file by its path from there. The card folder lies in the project folder
\`../../\`, outside the checkout, like the other folders this prompt names. The code in
the project folder is not this card's code.

## The card

PROJ-123: Add sign in

A person signs in with an email and a password.

## How this run works

This run is not interactive. Nobody is reading along, so a question asked in the middle of
your output is never answered and the run is wasted.

This phase changes no code. Write only inside \`../../.tasks/PROJ-123/refine/\`.
Add what you met on the way to \`../../.tasks/PROJ-123/discoveries.md\`.

When a question blocks the work and a guess would waste the run, end with it on its own line:

    NOLZU: needs_input: <your question on one line>

When the work is done, end with this line on its own line, with nothing after it:

    NOLZU: complete
`;

it('builds the whole prompt', () => {
  expect(buildPrompt(card)).toBe(REFINE);
});

// The contract and the parser have to agree, so the parser is run over the contract itself.
it('writes both sentinels in the form the parser reads', () => {
  const text = buildPrompt(card);

  expect(detectSentinel(text)).toEqual({ kind: 'needs_input', question: '<your question on one line>' });
  // A question wins over complete in the parser, so the complete line is checked without it.
  const withoutQuestion = text.split('\n').filter((line) => !line.includes('needs_input')).join('\n');
  expect(detectSentinel(withoutQuestion)).toEqual({ kind: 'complete' });
});

it('adds the read-only line for a read-only phase and not for a write phase', () => {
  const readOnly = buildPrompt(card);
  const writes = buildPrompt({ ...card, phase: 'implement', readOnly: false });

  expect(readOnly).toContain('This phase changes no code.');
  expect(writes).not.toContain('changes no code');
});

// The plan skill writes the list of what QA will check into QA's folder. The
// read-only line must name that file, or it forbids what the skill asks for.
it('lets a plan run write the QA checks beside its own folder, and no other phase', () => {
  expect(buildPrompt({ ...card, phase: 'plan' })).toContain(
    'Write only inside `../../.tasks/PROJ-123/plan/`, and the list of what QA will check to `../../.tasks/PROJ-123/qa/checks.md`.',
  );
  expect(buildPrompt(card)).not.toContain('qa/checks.md');
});

// A task's ticket holds the shareable text, and the epic's internal notes for it sit
// in the card folder, which every run of the task reads.
it('names the epic notes of a task, and says nothing of them on a card with none', () => {
  const text = buildPrompt({ ...card, epicNotes: '../../.tasks/PROJ-123/from-epic.md' });
  expect(text).toContain("## The epic\n\n`../../.tasks/PROJ-123/from-epic.md` holds the epic's notes for this task");
  expect(buildPrompt({ ...card, epicNotes: '../../.tasks/PROJ-123/from-epic.md', epic: { key: 'APP-5', title: 'Search', files: ['../../.tasks/APP-5/plan/plan.md'] } }).match(/## The epic\n/g)).toHaveLength(1);
  expect(buildPrompt(card)).not.toContain('from-epic.md');
  expect(() => buildPrompt({ ...card, epicNotes: '/home/x/.tasks/PROJ-123/from-epic.md' })).toThrow();
});

// An epic's Plan writes the plan colleagues read, and a Delivery Plan does not.
it('tells the plan of an epic to write the plan for other people, and no other run', () => {
  expect(buildPrompt({ ...card, phase: 'plan', epicCard: true })).toContain('This card is an epic. Write the plan for other people to `../../.tasks/PROJ-123/share/PLAN.md` too');
  expect(buildPrompt({ ...card, phase: 'plan' })).not.toContain('PLAN.md');
  expect(buildPrompt({ ...card, phase: 'refine', epicCard: true })).not.toContain('PLAN.md');
});

// Every phase adds to the discoveries file at the top of the card folder, so the read-only line has to
// allow it, or it forbids what the finish rules ask for.
it('lets a read-only run add to the discoveries file, and says nothing of it to a write phase', () => {
  for (const phase of ['refine', 'plan', 'qa']) expect(buildPrompt({ ...card, phase })).toContain('Add what you met on the way to `../../.tasks/PROJ-123/discoveries.md`.');
  expect(buildPrompt({ ...card, phase: 'implement', readOnly: false })).not.toContain('discoveries.md');
});

// The wrap-up skill says the knowledge folder is named in the prompt, because it is the one folder
// outside the card folder the phase may write in.
it('names the knowledge folder for a phase that writes knowledge', () => {
  const text = buildPrompt({ ...card, phase: 'wrapup', knowledgeFolder: '../../.nolzu/knowledge' });

  expect(text).toContain('The knowledge folder is `../../.nolzu/knowledge/`');
  expect(text).toContain('This phase changes no code.');
  // The runner reads the folder and commits what is there, so a run that committed would put its
  // own work where nobody reviewed it.
  expect(text).toContain('Make no commit');
});

// A return nobody ever reads is the same as a silent delete, so the note is in the prompt of the
// next run of that card.
it("carries the note a person returned this card's last knowledge change with", () => {
  const text = buildPrompt({ ...card, phase: 'wrapup', knowledgeFolder: '../../.nolzu/knowledge', knowledgeNote: 'Name the endpoint, not the file.' });

  expect(text).toContain('## The last knowledge change of this card was returned');
  expect(text).toContain('Name the endpoint, not the file.');
});

it('adds no returned-change heading when nothing was returned', () => {
  expect(buildPrompt({ ...card, phase: 'wrapup', knowledgeFolder: '../../.nolzu/knowledge' })).not.toContain('returned');
});

// A maintenance run rewrites the one file the button named. Nothing else in the prompt says which
// file, so without this line the run would pick one itself.
it('names the one file a maintenance run rewrites', () => {
  const text = buildPrompt({
    ...card,
    phase: 'optimize',
    key: 'kb-maintenance',
    title: 'Optimize a knowledge file',
    ticket: 'This run belongs to no card.',
    knowledgeFolder: '.nolzu/knowledge',
    knowledgeFile: 'search.md',
  });

  expect(text).toContain('Rewrite `.nolzu/knowledge/search.md` and no other file.');
  // The block a card's run calls the card. This run has none, and the line inside it says so.
  expect(text).toContain('## This run');
  expect(text).not.toContain('## The card');
});

// Reachable: return an Optimize change, then press Optimize again. The note is read back for the
// reserved key, and the heading over it cannot call a run with no card a card.
it('says a maintenance run made the change that was returned, not a card', () => {
  const text = buildPrompt({
    ...card,
    phase: 'optimize',
    key: 'kb-maintenance',
    title: 'Optimize a knowledge file',
    ticket: 'This run belongs to no card.',
    knowledgeFolder: '.nolzu/knowledge',
    knowledgeFile: 'search.md',
    knowledgeNote: 'It lost the part about the list.',
  });

  expect(text).toContain('## The last knowledge change a maintenance run made was returned');
  expect(text).not.toContain('The last knowledge change of this card');
  expect(text).toContain('It lost the part about the list.');
});

// Learn this project belongs to no card and names no file to rewrite: it writes the few files it
// picks, so the block says what the run is, and no Rewrite line narrows it to one file.
it('calls the block this run for Learn this project, and names no one file', () => {
  const text = buildPrompt({
    ...card,
    phase: 'orient',
    key: 'kb-maintenance',
    title: 'Learn this project',
    ticket: 'This run belongs to no card.',
    knowledgeFolder: '.nolzu/knowledge',
    knowledgeNote: 'Name where each rule came from.',
  });

  expect(text).toContain('## This run');
  expect(text).not.toContain('## The card');
  expect(text).not.toContain('Rewrite `');
  expect(text).toContain('## The last knowledge change a maintenance run made was returned');
});

// Learn your repositories runs once per repository. The prompt names the repository, where it is read,
// and the two files it writes, so a run of one repository never rewrites another one's section.
it('names the repository a Learn your repositories run learns and the two files it writes', () => {
  const text = buildPrompt({
    ...card,
    phase: 'learn-repo',
    key: 'kb-learn-api',
    title: 'Learn the api repository',
    ticket: 'This run belongs to no card.',
    folder: '.tasks/kb-learn-api',
    knowledgeFolder: '.nolzu/knowledge',
    learnRepo: { name: 'api', path: 'api' },
  });

  expect(text).toContain('## This run');
  expect(text).not.toContain('## The card');
  expect(text).toContain('Learn the repository `api` at `api/`. Write `.nolzu/knowledge/api/repository.md`');
  expect(text).toContain(`the \`## The api repository\` section of \`.nolzu/knowledge/${RUN_RECIPE_FILE}\``);
  expect(text).toContain('Leave every other section of the run recipe as it is.');
  // The project folder's repository has a file of its own name, never `./repository.md`.
  expect(buildPrompt({ ...card, phase: 'learn-repo', knowledgeFolder: '.nolzu/knowledge', learnRepo: { name: '.', path: '.' } })).toContain('`.nolzu/knowledge/repository.md`');
  expect(() => buildPrompt({ ...card, phase: 'learn-repo', knowledgeFolder: '.nolzu/knowledge', learnRepo: { name: 'api', path: '/home/you/api' } })).toThrow(/relative to the working folder/);
});

it('calls the block the card for a run that has one', () => {
  expect(buildPrompt({ ...card, phase: 'wrapup', knowledgeFolder: '../../.nolzu/knowledge' })).toContain('## The card');
});

it('says nothing about knowledge to a phase that writes none', () => {
  expect(buildPrompt(card)).not.toContain('knowledge');
});

// As for the card folder: an absolute path would name a folder on the person's machine, and it
// then travels into the log and into whatever the agent writes from it.
it('refuses a knowledge folder that is a machine path', () => {
  expect(() => buildPrompt({ ...card, phase: 'wrapup', knowledgeFolder: '/home/dev/recipes/.nolzu/knowledge' })).toThrow(/knowledge folder/);
});

it('carries the card, and adds no empty heading when there is no extra context', () => {
  const text = buildPrompt(card);

  expect(text).toContain('PROJ-123: Add sign in');
  expect(text).toContain('A person signs in with an email and a password.');
  expect(text).not.toContain('## Extra context');
});

it('adds the extra context under its own heading when there is some', () => {
  const text = buildPrompt({ ...card, extra: 'The login page already exists.' });

  expect(text).toContain('## Extra context');
  expect(text).toContain('The login page already exists.');
});

// A prompt that named a folder on this machine would leak the path into the engine's log and
// into anything the agent writes from it.
it('holds no absolute path', () => {
  // The first line is the skill command, which starts with a slash and is no path.
  const text = buildPrompt({ ...card, phase: 'implement', readOnly: false, extra: 'see the notes' }).split('\n').slice(1).join('\n');

  // A path can also start after a backtick or a quote, which is how every path in this prompt
  // is written, so matching only after whitespace missed the case that can happen.
  expect(text).not.toMatch(/(^|[\s`'"(])\//m);
});

// Output alone cannot catch this: a hard-coded line identical to the constant reads the same. The
// constants are imported here, so a change in protocol that the builder does not follow fails.
it('takes the sentinel lines from protocol, so the contract cannot drift from the parser', () => {
  const text = buildPrompt(card);

  expect(text).toContain(`    ${NEEDS_INPUT_PREFIX}`);
  expect(text).toContain(`    ${SENTINEL_COMPLETE}`);
});

// The folder travels into the log and into whatever the agent writes from it, so a path that names
// a folder on the person's machine must never reach the prompt.
it('refuses an absolute card folder', () => {
  expect(() => buildPrompt({ ...card, folder: '/home/dev/work/app/.tasks/PROJ-123' })).toThrow(/relative/);
});

it('names the folder the way it was given when the card folder sits inside the working folder', () => {
  const text = buildPrompt({ ...card, folder: '.tasks/PROJ-123' });

  expect(text).toContain('The card folder is `.tasks/PROJ-123/`.');
  expect(text).toContain('`.tasks/PROJ-123/refine/summary.md`');
});

// Every engine reads the phase method from the file the run writes from the installed skill. Claude
// Code once got the skill as a slash command, which opened the project's committed copy and kept the
// old method after an upgrade. A model handed the method as a file opens it, because the first line
// says to.
it('opens with the instructions file of the phase, on every engine', () => {
  expect(buildPrompt(card).split('\n')[0]).toBe('Read `../../.tasks/PROJ-123/refine/instructions.md` first. It holds the method for this phase, and this run follows it.');
  expect(buildPrompt({ ...card, phase: 'implement', readOnly: false }).split('\n')[0]).toBe(
    'Read `../../.tasks/PROJ-123/implement/instructions.md` first. It holds the method for this phase, and this run follows it.',
  );
  expect(buildPrompt(card)).not.toContain('/nolzu-');
});

// The steps come off the start of a line, because that is where the skill writes them. A number
// anywhere in a line would count a line such as "3 tests pass" as a finished step 3.
describe('stepsDone', () => {
  it('reads the step numbers the skill writes, in order and once each', () => {
    const file = '1. Wrote the parser test, proved by the failing run.\n- step 2: wrote the parser, 3 tests pass.\n2. Same step again.\n';

    expect(stepsDone(file)).toEqual([1, 2]);
  });

  it('reads no step out of a file that lists none', () => {
    expect(stepsDone('Nothing is done yet. The plan has 4 steps.\n')).toEqual([]);
  });

  // A step number is at most three digits, so a line that opens with a date is not a step. Read as
  // one, it would put step 2026 in the prompt and the card would name a step nobody planned.
  it('reads no step out of a line that opens with a date', () => {
    expect(stepsDone('2026-09-25 wrote the parser.\n')).toEqual([]);
  });

  // The record the implement skill teaches: the review block on top and the proof lines under each
  // step must read as no step, or the next run would skip one. The output check holds a run to the
  // same example, so it passes there too.
  it('reads only the steps out of the implement skill\'s own example, which the output check passes', () => {
    const skill = readFileSync(join(import.meta.dirname, '..', '..', 'skills', 'skills', 'nolzu-implement', 'SKILL.md'), 'utf8');
    const lines = skill.split('\n');
    const start = lines.findIndex((line) => line.startsWith('    Base: '));
    const end = lines.findIndex((line, at) => at > start && line !== '' && !line.startsWith('    '));
    const progress = lines.slice(start, end).map((line) => line.slice(4)).join('\n');
    const deviation = (lines.find((line) => line.startsWith('    - Step 2: ')) ?? '').slice(4);
    const pr = 'Search recipes by title\n\n## What changed\n\nA q option.\n\n## How to test\n\nnpm test\n';

    expect(stepsDone(progress)).toEqual([1, 2]);
    expect(checkOutputs('implement', { 'implement/progress.md': progress, 'implement/pr.md': pr, 'implement/deviations.md': deviation, 'implement/summary.md': 'Done.\n', 'share/SUMMARY.md': 'Search.\n', 'share/TESTING.md': 'Open the list.\n' })).toEqual([]);
  });
});

describe('nextStep', () => {
  it('is the first step the file does not list', () => {
    expect(nextStep([1, 2])).toBe(3);
    expect(nextStep([])).toBe(1);
  });

  // A run that skipped a step and finished a later one leaves the skipped one open, and the next
  // run has to do it rather than carrying on past it.
  it('is the gap when a later step is done and an earlier one is not', () => {
    expect(nextStep([1, 3])).toBe(2);
  });
});

// A fresh run has no session and no memory of the run that stopped. Without this the prompt sent it
// back to step 1, and it would redo work that is already in the checkout.
it('names the first open step when an earlier run left a progress file', () => {
  const text = buildPrompt({
    ...card,
    phase: 'implement',
    readOnly: false,
    progress: '1. Wrote the failing test for the parser.\n2. Wrote the parser, the test passes.\n',
  });

  // The heading tells the run what the block below it is. Without it the steps read as part of the
  // contract above them.
  expect(text).toContain('## An earlier run of this phase stopped');
  expect(text).toContain('`../../.tasks/PROJ-123/implement/progress.md` lists steps 1, 2 as done.');
  expect(text).toContain('go on from step 3');
  // The changes of the stopped run are in the checkout and nothing was committed, so the checks
  // come before the next step.
  expect(text).toContain("Run the\nproject's checks first");
});

it('says nothing about a progress file when there is none, and nothing when it lists no step', () => {
  expect(buildPrompt({ ...card, phase: 'implement', readOnly: false })).not.toContain('progress.md');
  expect(buildPrompt({ ...card, phase: 'implement', readOnly: false, progress: 'Nothing finished yet.\n' })).not.toContain('progress.md');
});

/**
 * A run that starts in the card folder is told where the project is.
 *
 * A read-only phase on Codex starts there, because that is what makes the project unwritable for
 * it. Without this the agent would read the folder it starts in as the project, and a plan would
 * name its files from the wrong place for the implement run that reads that plan back.
 */
it('names the project and its own folder for a run that starts in the card folder', () => {
  const prompt = buildPrompt({ ...card, folder: '.', checkout: '../../worktrees/PROJ-123' });

  expect(prompt).toContain('The card folder is `./`');
  expect(prompt).toContain('Write what you produce to `./refine/`');
  expect(prompt).toContain('the project is at `../../worktrees/PROJ-123/`');
  expect(prompt).toContain('Name a file of the project by its');
});

// The other path. A run that starts in the checkout reads the project under its feet, so a line
// telling it where the project is would be one more thing to read and nothing to do.
it('says nothing about a checkout for a run that starts in one', () => {
  expect(buildPrompt(card)).not.toContain('You start in the card folder');
});

// A run in a card checkout sees the project folder in every card and knowledge path, and a refine
// run read the code there and was refused. One rule for every phase, from where the card folder is.
it('says the code is in the checkout for every run that starts in one, at any depth', () => {
  expect(buildPrompt({ ...card, phase: 'qa', readOnly: true })).toContain("The card folder lies in the project folder\n`../../`, outside the checkout");
  const inRepo = buildPrompt({ ...card, phase: 'implement', readOnly: false, folder: '../../../.tasks/PROJ-123' });
  expect(inRepo).toContain('The code of this card is in the folder you start in, `./`');
  expect(inRepo).toContain('project folder\n`../../../`, outside the checkout');
});

// The project folder itself, and the card folder with its own line, need none. Nor does a list of
// repositories, which reads one the card has no checkout of in the project folder.
it('says nothing about the project folder for a run that starts in it or in the card folder', () => {
  expect(buildPrompt({ ...card, folder: '.tasks/PROJ-123' })).not.toContain('The code of this card');
  expect(buildPrompt({ ...card, folder: '.', checkout: '../../worktrees/PROJ-123' })).not.toContain('The code of this card');
  const repositories = [
    { name: 'api', path: 'api', knowledge: null },
    { name: 'web', path: '../../web', knowledge: null },
  ];
  expect(buildPrompt({ ...card, repositories })).not.toContain('The code of this card');
});

// An empty folder would be joined to the phase and read as `/refine/`, which is a folder on the
// machine's root and not the card's. `.` is what a run that starts in the card folder is given.
it('refuses an empty card folder, which would read as an absolute path', () => {
  expect(() => buildPrompt({ ...card, folder: '' })).toThrow(/relative path/);
});

// The same rule the card folder gets. An absolute path would name a folder on the person's machine
// and travel into the log and into whatever the agent writes from it.
it('refuses a checkout path that names a folder on this machine', () => {
  expect(() => buildPrompt({ ...card, folder: '.', checkout: '/Users/somebody/projects/recipes' })).toThrow(/relative/);
});

// A project of several repositories: refine and plan read them all and name the ones the card changes.
describe('the repositories of a project with several', () => {
  const repositories = [
    { name: '.', path: '.', knowledge: '.nolzu/knowledge/repository.md' },
    { name: 'api', path: 'api', knowledge: '.nolzu/knowledge/api/repository.md' },
    { name: 'web', path: 'web', knowledge: null },
  ];

  it('lists each repository with its path and knowledge file', () => {
    const prompt = buildPrompt({ ...card, folder: '.tasks/PROJ-123', repositories });

    expect(prompt).toContain('This project has several repositories.');
    expect(prompt).toContain('- `.` at `./`, knowledge in `.nolzu/knowledge/repository.md`');
    expect(prompt).toContain('- `api` at `api/`, knowledge in `.nolzu/knowledge/api/repository.md`');
    // A knowledge file that is not there is not named, so the agent does not look for it.
    expect(prompt).toContain('- `web` at `web/`\n');
    expect(prompt.indexOf('several repositories')).toBeLessThan(prompt.indexOf(SENTINEL_COMPLETE));
  });

  it('holds no absolute path', () => {
    const text = buildPrompt({ ...card, repositories }).split('\n').slice(1).join('\n');
    expect(text).not.toMatch(/(^|[\s`'"(])\//m);
  });

  it('refuses a repository path or knowledge file that names a folder on this machine', () => {
    expect(() => buildPrompt({ ...card, repositories: [{ name: 'api', path: '/home/someone/api', knowledge: null }] })).toThrow(/relative/);
    expect(() => buildPrompt({ ...card, repositories: [{ name: 'api', path: 'api', knowledge: '/Users/somebody/api.md' }] })).toThrow(/relative/);
  });

  it('leaves the prompt as it was without a list', () => {
    expect(buildPrompt({ ...card, repositories: [] })).toBe(buildPrompt(card));
    expect(buildPrompt(card)).not.toContain('several repositories');
  });
});

// A card that changes several repositories starts at the checkout root, and an allowed command matches
// the start of the line, so `cd api && npm test` is never allowed. The prompt says to use a folder flag.
describe('the folder flags of a card on several repositories', () => {
  const implement: PromptInput = { ...card, phase: 'implement', readOnly: false };
  const folderRepos = [
    { name: 'api', path: 'api' },
    { name: 'web', path: 'web' },
  ];

  it('names each repository with its folder and says to use a folder flag, not cd', () => {
    const prompt = buildPrompt({ ...implement, folderRepos });

    expect(prompt).toContain('This card changes several repositories');
    expect(prompt).toContain('- `api` in `api/`');
    expect(prompt).toContain('- `web` in `web/`');
    expect(prompt).toContain('`npm --prefix api test`');
    expect(prompt).toContain('`pnpm --dir api test`');
    expect(prompt).toContain('`git -C api status`');
    expect(prompt).toContain('Never `cd api && ...`');
    expect(prompt.indexOf('several repositories')).toBeLessThan(prompt.indexOf(SENTINEL_COMPLETE));
  });

  it('picks a child folder for the example when the root repository comes first', () => {
    const prompt = buildPrompt({ ...implement, folderRepos: [{ name: '.', path: '.' }, ...folderRepos] });
    expect(prompt).toContain('- `.` in `./`');
    expect(prompt).toContain('`npm --prefix api test`');
  });

  it('refuses a folder that names a place on this machine', () => {
    expect(() => buildPrompt({ ...implement, folderRepos: [{ name: 'api', path: '/home/someone/api' }, ...folderRepos] })).toThrow(/relative/);
  });

  it('leaves the prompt as it was with one repository or none', () => {
    expect(buildPrompt({ ...implement, folderRepos: [] })).toBe(buildPrompt(implement));
    expect(buildPrompt({ ...implement, folderRepos: [{ name: 'api', path: 'api' }] })).toBe(buildPrompt(implement));
  });
});

// The prompt of an Ask run, stored whole like the refine one. It has no skill and
// writes nothing, so it asks for no file and no summary, and the question goes under its last heading.
const ASK = `Answer a question about PROJ-123. A person asks it on the card's Discussion tab.

## The card

PROJ-123: Add sign in

A person signs in with an email and a password.

## How this run works

This run reads and answers. It changes nothing: you can read and search, and you have no tool that
writes a file or runs a command. Read the code from here. The card folder is \`../../.tasks/PROJ-123/\`, and it
holds what the card's phases wrote, such as the plan, their summaries and the QA report.

Answer in plain words in your last message. Name each file you read by its path. Say what the code
shows, and say so when it does not show the answer. Nobody reads along while you work, so do not
ask a question in the middle. A person reads the answer and can ask a follow-up in this session.

## The question
`;

describe('askPrompt', () => {
  it('names the card and its folder, asks for no file, and ends on the question heading', () => {
    expect(askPrompt(card)).toBe(ASK);
    expect(askPrompt(card)).not.toContain('summary.md');
    expect(askPrompt(card)).not.toContain('/nolzu-');
  });

  it('adds the extra context when the card has some', () => {
    expect(askPrompt({ ...card, extra: 'Use the session cookie.' })).toContain('## Extra context\n\nUse the session cookie.');
  });

  it('refuses a card folder that is absolute or empty, so no machine path reaches the prompt', () => {
    expect(() => askPrompt({ ...card, folder: '/home/dev/recipes/.tasks/PROJ-123' })).toThrow(/relative path/);
    expect(() => askPrompt({ ...card, folder: '' })).toThrow(/relative path/);
  });
});

// A task of an epic starts from what the epic's phases found, read in place and never changed.
it("names the epic's documents the loop found, read only, and adds nothing for a card with no epic", () => {
  const text = buildPrompt({
    ...card,
    epic: { key: 'APP-1', title: 'Meal plans', files: ['../../.tasks/APP-1/refine/refined.md', '../../.tasks/APP-1/plan/plan.md'] },
  });

  expect(text).toContain(
    [
      '## The epic',
      '',
      'This card is a task of APP-1: Meal plans. Read the epic\'s documents first: they say what the',
      'whole epic is for and how it is split. They are read only. Never change a file in that folder.',
      '',
      '- `../../.tasks/APP-1/refine/refined.md`',
      '- `../../.tasks/APP-1/plan/plan.md`',
    ].join('\n'),
  );
  expect(text).not.toContain('architecture.md');
  expect(buildPrompt(card)).toBe(REFINE);
  expect(buildPrompt({ ...card, epic: { key: 'APP-1', title: 'Meal plans', files: [] } })).toBe(REFINE);
});

// QA runs in a throwaway copy in the data folder, and from there the card folder was
// `../../../recipes/.tasks/APP-8`, which Codex wrote one or two folders too high. So a run in the copy
// gets full paths, and the line that keeps the card's code in `./` stays.
describe('a QA run in its throwaway copy', () => {
  const qa: PromptInput = {
    ...card,
    phase: 'qa',
    key: 'APP-8',
    readOnly: true,
    folder: '/home/dev/recipes/.tasks/APP-8',
    fullPaths: true,
    epic: { key: 'APP-5', title: 'A page for one recipe', files: ['/home/dev/recipes/.tasks/APP-5/plan/plan.md'] },
    readFirst: ['/home/dev/recipes/.tasks/APP-8/qa/checks.md'],
    knowledgeIndex: { folder: '/home/dev/recipes/.nolzu/knowledge', files: [{ path: 'run-recipe.md', about: 'How to run it.' }], left: 0 },
  };

  it('names the card folder and every path outside the copy in full, and says so', () => {
    const text = buildPrompt(qa);
    expect(text).toContain('The card folder is `/home/dev/recipes/.tasks/APP-8/`.');
    expect(text).toContain('Write what you produce to `/home/dev/recipes/.tasks/APP-8/qa/`,\nand the short summary to `/home/dev/recipes/.tasks/APP-8/qa/summary.md`.');
    expect(text).toContain('- `/home/dev/recipes/.tasks/APP-5/plan/plan.md`');
    expect(text).toContain('- `/home/dev/recipes/.tasks/APP-8/qa/checks.md`');
    expect(text).toContain("The project's knowledge folder is `/home/dev/recipes/.nolzu/knowledge/`.");
    expect(text).toContain('Every path this prompt names outside `./` is a full path. Use it as it stands, and do not\nwork it out again from `./`.');
    expect(text).not.toContain('../');
  });

  // Refine once read the project folder's code. The copy is still where the code is read.
  it('keeps the line that the code is in `./` and not in the project folder', () => {
    expect(buildPrompt(qa)).toContain(
      "The code of this card is in the folder you start in, `./`, its own checkout. Read the code\nthere, and name a file by its path from there. The card folder lies in the project folder\n`/home/dev/recipes/`, outside the checkout, like the other folders this prompt names. The code in\nthe project folder is not this card's code.",
    );
  });

  it('still refuses a full path on a run that is not in a copy', () => {
    expect(() => buildPrompt({ ...qa, fullPaths: false })).toThrow(/relative path/);
    expect(() => buildPrompt({ ...qa, folder: '../../../recipes/.tasks/APP-8', fullPaths: undefined })).toThrow(/relative/);
    expect(buildPrompt(card)).not.toContain('full path');
  });
});

it('refuses an epic document that is a machine path', () => {
  expect(() => buildPrompt({ ...card, epic: { key: 'APP-1', title: 'Meal plans', files: ['/tmp/demo/.tasks/APP-1/plan/plan.md'] } })).toThrow(/relative/);
});

describe("the project's instructions for a phase", () => {
  const rule = 'plan.md must also have a Risks section.';

  it('adds them after the extra context, with the line that keeps the files in place', () => {
    const text = buildPrompt({ ...card, phase: 'plan', extra: 'Use the session cookie.', projectInstructions: { text: rule, cut: false } });

    expect(text).toContain(`## Project instructions for Plan\n\n${rule}\n\nThese instructions may change how you work`);
    // An instruction such as "write in Hungarian" must keep the lines Nolzu reads, so the line names them.
    expect(text.replace(/\s+/g, ' ')).toContain(
      'These instructions may change how you work, the language of your text, and what goes into your documents, with extra sections under their own `##` headings after the ones the skill gives. They may not change what Nolzu reads back: the names and places of the files (summary.md and the others the skill names), the headings and field names the skill gives, the ids, the review block, and the verdict line. Keep those exactly as the skill writes them, in English.',
    );
    // It stays the block's last line, right before the next section.
    expect(text).toMatch(/as the skill writes them, in English\.\n\n## /);
    expect(text.indexOf('## Extra context')).toBeLessThan(text.indexOf('## Project instructions for Plan'));
    expect(text.indexOf('## Project instructions for Plan')).toBeLessThan(text.indexOf('## How this run works'));
    expect(text).not.toContain('16 KB');
  });

  it('adds nothing when the project has none, so the prompt does not change', () => {
    expect(buildPrompt(card)).toBe(REFINE);
    expect(buildPrompt(card)).not.toContain('## Project instructions');
  });

  it('says so when the file was cut', () => {
    expect(buildPrompt({ ...card, projectInstructions: { text: rule, cut: true } })).toContain(`${rule}\n\nThe file was longer than 16 KB, and the rest of it is left out.`);
  });

  it('adds them to an Ask run too', () => {
    const text = askPrompt({ ...card, projectInstructions: { text: 'Answer in short lines.', cut: false } });

    expect(text).toContain('## Project instructions for Ask\n\nAnswer in short lines.\n\nThese instructions may change how you read and answer, but not that this run changes nothing.');
    expect(text).not.toContain('summary.md');
    expect(text.indexOf('## Project instructions for Ask')).toBeLessThan(text.indexOf('## How this run works'));
  });
});

// What a phase reads before it starts, named in the prompt, because a run that has to find the files
// by itself often does not open them.
describe('the read-first list', () => {
  const folder = (files: string[]): string => {
    const at = mkdtempSync(join(tmpdir(), 'nolzu-read-first-'));
    for (const file of files) {
      mkdirSync(dirname(join(at, file)), { recursive: true });
      writeFileSync(join(at, file), 'x\n');
    }
    return at;
  };

  it('gives each phase the files the phases before it write', () => {
    expect(READ_FIRST.refine).toBeUndefined();
    expect(READ_FIRST.architecture).toEqual(['refine/refined.md', DISCOVERIES_FILE]);
    expect(READ_FIRST.plan).toEqual(['refine/refined.md', 'architecture/architecture.md', 'mockups/mockups.md', 'design/design.md', DISCOVERIES_FILE]);
    expect(READ_FIRST.implement).toEqual(expect.arrayContaining(['plan/plan.md', QA_CHECKS_FILE, DISCOVERIES_FILE]));
    expect(READ_FIRST.qa).toEqual(expect.arrayContaining(['refine/refined.md', 'architecture/architecture.md', 'plan/plan.md', QA_CHECKS_FILE, 'implement/progress.md', 'implement/pr.md', 'implement/deviations.md', DISCOVERIES_FILE]));
    expect(READ_FIRST.wrapup).toEqual(expect.arrayContaining(['architecture/architecture.md', 'design/design.md', QA_CHECKS_FILE, 'qa/report.md', DISCOVERIES_FILE]));
    // QA corrects the test steps and the wrap-up gives both share files a last pass, so both read them.
    for (const phase of ['qa', 'wrapup']) expect(READ_FIRST[phase], phase).toEqual(expect.arrayContaining(['share/SUMMARY.md', 'share/TESTING.md']));
    // Every phase after Refine reads the discoveries, and no phase is told to read its own folder,
    // except QA's checks, which Plan writes there.
    for (const [phase, files] of Object.entries(READ_FIRST)) {
      expect(files, phase).toContain(DISCOVERIES_FILE);
      expect(files.some((file) => file !== QA_CHECKS_FILE && file.startsWith(`${phase}/`)), phase).toBe(false);
    }
  });

  it('lists only the files that exist, in the order of the table', () => {
    const at = folder(['plan/plan.md', 'refine/refined.md', DISCOVERIES_FILE, 'implement/progress.md']);

    expect(readFirstPaths(at, 'implement')).toEqual([join(at, 'refine/refined.md'), join(at, 'plan/plan.md'), join(at, DISCOVERIES_FILE)]);
    expect(readFirstPaths(at, 'refine')).toEqual([]);
    expect(readFirstPaths(at, 'research')).toEqual([]);
    expect(readFirstPaths(folder([]), 'qa')).toEqual([]);
  });

  // The wrap-up of a question or an investigation has no plan or diff to read: the answer or the report
  // is the whole work of the card, so its prompt names that file with the discoveries.
  it('names the answer or the report to the wrap-up of a Research card', () => {
    const question = folder(['research/answer.md', DISCOVERIES_FILE]);
    const investigation = folder(['investigate/report.md']);

    expect(readFirstPaths(question, 'wrapup')).toEqual([join(question, DISCOVERIES_FILE), join(question, 'research/answer.md')]);
    expect(readFirstPaths(investigation, 'wrapup')).toEqual([join(investigation, 'investigate/report.md')]);
  });

  it('names the files after the epic and before how the run works', () => {
    const text = buildPrompt({
      ...card,
      phase: 'implement',
      epic: { key: 'APP-9', title: 'Recipes', files: ['../../.tasks/APP-9/plan/plan.md'] },
      readFirst: ['../../.tasks/PROJ-123/plan/plan.md', '../../.tasks/PROJ-123/qa/checks.md'],
    });

    expect(text).toContain('## Read first\n\nEarlier phases of this card wrote these files. Read them before you start.\n\n- `../../.tasks/PROJ-123/plan/plan.md`\n- `../../.tasks/PROJ-123/qa/checks.md`');
    expect(text.indexOf('## The epic')).toBeLessThan(text.indexOf('## Read first'));
    expect(text.indexOf('## Read first')).toBeLessThan(text.indexOf('## How this run works'));
  });

  it("gives Plan the project's instructions for the later phases, read only", () => {
    const text = buildPrompt({
      ...card,
      phase: 'plan',
      laterInstructions: [
        { phase: 'implement', path: '../../.nolzu/phases/implement.md' },
        { phase: 'qa', path: '../../.nolzu/phases/qa.md' },
      ],
    });

    expect(text).toContain('## Read first');
    expect(text).toContain('- `../../.nolzu/phases/implement.md`, for Implement\n- `../../.nolzu/phases/qa.md`, for QA');
    expect(text).toContain('Turn each rule in them that you can check into a plan step or a line in\n`../../.tasks/PROJ-123/qa/checks.md`, and name the file the rule came from.');
    expect(text).not.toContain('Earlier phases of this card wrote');
  });

  it('adds nothing when there is nothing to read, so the prompt does not change', () => {
    expect(buildPrompt({ ...card, readFirst: [], laterInstructions: [] })).toBe(REFINE);
  });

  it('refuses a path that names a folder on this machine', () => {
    expect(() => buildPrompt({ ...card, readFirst: ['/Users/somebody/.tasks/PROJ-123/plan/plan.md'] })).toThrow(/relative/);
    expect(() => buildPrompt({ ...card, laterInstructions: [{ phase: 'qa', path: '/Users/somebody/.nolzu/phases/qa.md' }] })).toThrow(/relative/);
  });
});

// What the person said on this card. A fresh run of a later phase has no session, so without this
// block an answer or a correction reaches only the one run it was typed to.
describe("the person's words", () => {
  const none = { questions: [], moves: [], messages: [], allowedCommands: [] };

  it('lists an answered question and a reason typed on a move, after the extra context', () => {
    const text = buildPrompt({
      ...card,
      phase: 'plan',
      extra: 'Use the new font.',
      projectInstructions: { text: 'Keep steps small.', cut: false },
      personsWords: {
        ...none,
        questions: [{ phase: 'refine', question: 'Does search cover the ingredients?', answer: 'Yes, titles and ingredients.' }],
        moves: [{ from: 'QA', to: 'Wrap-up', back: false, reason: 'The flaky test fails on main too.' }],
      },
    });

    expect(text).toContain(
      "## What the person said\n\nA person wrote these on this card. They are decisions: follow them, and do not ask again\nwhat an answer here already says.\n\nThe questions earlier runs asked, with the answers:\n\n- Refine asked: Does search cover the ingredients?\n  Answer: Yes, titles and ingredients.\n\nWhat the person wrote when the card moved:\n\n- Moved on anyway from QA to Wrap-up: The flaky test fails on main too.",
    );
    expect(text.indexOf('## Extra context')).toBeLessThan(text.indexOf('## What the person said'));
    expect(text.indexOf('## What the person said')).toBeLessThan(text.indexOf('## Project instructions'));
    expect(text).not.toContain('Discussion');
    expect(text).not.toContain('may use');
  });

  it('says so when a question has no answer stored, and names a move back as a send back', () => {
    const text = buildPrompt({
      ...card,
      personsWords: { ...none, questions: [{ phase: 'qa', question: 'Which port?', answer: null }], moves: [{ from: 'Review', to: 'Implement', back: true, reason: 'Keep the old helper.' }] },
    });

    expect(text).toContain('- QA asked: Which port?\n  No answer is stored.');
    expect(text).toContain('- Sent back from Review to Implement: Keep the old helper.');
  });

  it('keeps the newest Discussion messages, newest last, and says how many it left out', () => {
    const messages = Array.from({ length: 12 }, (_, at) => ({ thread: 'plan', text: `Message ${at + 1} ${'x'.repeat(400)}` }));
    const text = buildPrompt({ ...card, personsWords: { ...none, messages } });

    expect(text).toContain("The person's own messages in the card's Discussion, newest last:");
    expect(text).toContain('- On Plan: Message 12 ');
    expect(text).not.toContain('Message 1 ');
    expect(text.indexOf('Message 11 ')).toBeLessThan(text.indexOf('Message 12 '));
    expect(text).toMatch(/\d+ older messages are left out\. The Discussion tab has them all\./);
    const block = text.slice(text.indexOf('## What the person said'), text.indexOf('## How this run works'));
    expect(block.length).toBeLessThan(4000);
  });

  it('keeps the newest questions and moves of a long-lived card, and counts the rest', () => {
    const questions = Array.from({ length: 20 }, (_, at) => ({ phase: 'implement', question: `Question ${at + 1} ${'q'.repeat(400)}`, answer: 'a'.repeat(400) }));
    const moves = Array.from({ length: 20 }, (_, at) => ({ from: 'QA', to: 'Wrap-up', back: false, reason: `Reason ${at + 1} ${'r'.repeat(400)}` }));
    const text = buildPrompt({ ...card, personsWords: { ...none, questions, moves } });

    expect(text).toContain('- Implement asked: Question 20 ');
    expect(text).not.toContain('Question 1 ');
    expect(text).toMatch(/\d+ older questions are left out\. The Discussion tab has them all\./);
    expect(text).toContain('Moved on anyway from QA to Wrap-up: Reason 20 ');
    expect(text).not.toContain('Reason 1 ');
    expect(text).toMatch(/\d+ older moves are left out\. The trail on the Overview has them all\./);
    const block = text.slice(text.indexOf('## What the person said'), text.indexOf('## How this run works'));
    expect(block.length).toBeLessThan(9000);
  });

  it('cuts one long item and puts each on one line', () => {
    const text = buildPrompt({ ...card, personsWords: { ...none, messages: [{ thread: 'ask', text: `First line\n\nsecond ${'y'.repeat(2000)}` }] } });

    expect(text).toContain('- On Ask: First line second yyy');
    expect(text).toContain('y (cut)');
    expect(text).not.toContain('y'.repeat(700));
  });

  it("names the person's answer at the first QA and the allowed commands", () => {
    const words = (firstQa: NonNullable<PromptInput['personsWords']>['firstQa']) =>
      buildPrompt({ ...card, phase: 'qa', personsWords: { ...none, firstQa, allowedCommands: ['npm test', 'git diff *'] } });

    expect(words([{ mode: 'dev', command: 'npm run dev', repo: 'web' }])).toContain(
      '## What the person said\n\nAt the first QA the person chose how QA gets the app: Nolzu starts it with `npm run dev` in `web`.\n\nThe commands this run may use. Any other command is refused, and nobody is there to\nallow it:\n\n- `npm test`\n- `git diff *`',
    );
    expect(words([{ mode: 'dev', command: 'npm run dev', repo: '.' }])).toContain('Nolzu starts it with `npm run dev`.');
    expect(words([{ mode: 'running', address: 'http://localhost:3000' }])).toContain('it is already running at http://localhost:3000, and Nolzu leaves it alone.');
    expect(words([{ mode: 'code' }])).toContain('QA checks the code only, with no app running.');
    expect(words([{ mode: 'own', start: 'docker compose up -d', stop: null, status: null }])).toContain('Nolzu starts it with their own command `docker compose up -d` before the run and stops it after.');
    // A refused write under the home folder is the wall, and the caches are elsewhere already.
    expect(words([{ mode: 'code' }])).toContain('- `git diff *`\n\nYour home folder is read-only by design, so a write refused under it comes from the wall, not\nfrom files owned by root.');
    expect(words([{ mode: 'code' }])).toContain('Never put a package cache or an install log in the card folder.');
    // A card of two repositories with an answer each gets a line each.
    expect(words([{ mode: 'dev', command: 'npm run dev', repo: 'web' }, { mode: 'code' }])).toContain(
      'Nolzu starts it with `npm run dev` in `web`.\nAt the first QA the person chose how QA gets the app: QA checks the code only, with no app running.',
    );
  });

  it('adds nothing when the person said nothing, so the prompt does not change', () => {
    expect(buildPrompt({ ...card, personsWords: none })).toBe(REFINE);
  });
});

// The wrap-up looks for what cost time on the card, and a QA that failed is the clearest sign of it.
// Its report is written over by the next QA, so the prompt carries every verdict.
describe("the card's history", () => {
  it('counts the runs of each phase and lists each QA that did not pass, after the person\'s words', () => {
    const text = buildPrompt({
      ...card,
      phase: 'wrapup',
      personsWords: { questions: [], moves: [{ from: 'Review', to: 'Implement', back: true, reason: 'Keep the old helper.' }], messages: [], allowedCommands: [] },
      history: {
        runs: [{ phase: 'refine', count: 1 }, { phase: 'implement', count: 3 }, { phase: 'qa', count: 2 }],
        verdicts: [{ verdict: 'FAIL', reason: 'AC2 fails:\nthe search is case sensitive.' }, { verdict: 'BLOCKED', reason: null }],
      },
    });

    expect(text).toContain(
      "## What this card went through\n\nHow often each phase ran: Refine 1, Implement 3, QA 2.\n\nThe QA runs that did not pass, oldest first:\n\n- FAIL: AC2 fails: the search is case sensitive.\n- BLOCKED: no reason is stored.",
    );
    expect(text.indexOf('## What the person said')).toBeLessThan(text.indexOf('## What this card went through'));
  });

  it('adds nothing for a card with no runs before this one, so the prompt does not change', () => {
    expect(buildPrompt({ ...card, history: { runs: [], verdicts: [] } })).toBe(REFINE);
  });
});

// The knowledge index: one line per file of the project's knowledge folder, so a phase that reads code
// knows what the project wrote down and picks what to open.
describe('the knowledge index', () => {
  const entry = (path: string, changed: number, about = `What ${path} holds.`) => ({ path, about, changed });

  it('keeps the run recipe and the repository files first, then the newest', () => {
    const files = [entry('a.md', 1), entry('web/repository.md', 2), entry('b.md', 5), entry(RUN_RECIPE_FILE, 0), entry('c.md', 3), entry('api/repository.md', 1)];

    const all = pickKnowledge(files);
    expect(all.kept.map((one) => one.path)).toEqual([RUN_RECIPE_FILE, 'api/repository.md', 'web/repository.md', 'b.md', 'c.md', 'a.md']);
    expect(all.left).toBe(0);
    expect(all.other).toBe(0);

    const cut = pickKnowledge(files, 4);
    expect(cut.kept.map((one) => one.path)).toEqual([RUN_RECIPE_FILE, 'api/repository.md', 'web/repository.md', 'b.md']);
    expect(cut.left).toBe(2);
    expect(KNOWLEDGE_INDEX_CAP).toBe(30);
  });

  // A workspace of 31 repositories filled the cap with the run recipe and 29 repository files, so no
  // note ever reached a card's prompt.
  it('gives a card on one of 31 repositories its own notes, and only counts the files of the others', () => {
    const repos = Array.from({ length: 31 }, (_, at) => `repo${String(at).padStart(2, '0')}`);
    const files = [
      entry(RUN_RECIPE_FILE, 0),
      ...repos.map((repo) => entry(`${repo}/repository.md`, 1)),
      ...['a', 'b', 'c'].map((name, at) => entry(`repo07/${name}.md`, 10 + at)),
      entry('repo03/other.md', 50),
    ];

    const picked = pickKnowledge(files, undefined, { card: ['repo07'], repos });

    expect(picked.kept.map((one) => one.path)).toEqual([RUN_RECIPE_FILE, 'repo07/repository.md', 'repo07/c.md', 'repo07/b.md', 'repo07/a.md']);
    expect(picked.left).toBe(0);
    expect(picked.other).toBe(31);
  });

  it('lists the card repositories, then shared/, then the other notes, and keeps the card part past the cap', () => {
    const files = [
      entry('loose.md', 9),
      entry('shared/lists.md', 8),
      entry('web/repository.md', 1),
      entry('web/form.md', 7),
      entry('api/search.md', 2),
      entry('api/repository.md', 1),
      entry('api/sort.md', 3),
      entry(RUN_RECIPE_FILE, 0),
    ];
    const scope = { card: ['api'], repos: ['api', 'web'] };

    const picked = pickKnowledge(files, undefined, scope);
    expect(picked.kept.map((one) => one.path)).toEqual([RUN_RECIPE_FILE, 'api/repository.md', 'api/sort.md', 'api/search.md', 'shared/lists.md', 'loose.md']);
    expect(picked.other).toBe(2);

    const cut = pickKnowledge(files, 2, scope);
    expect(cut.kept.map((one) => one.path)).toEqual([RUN_RECIPE_FILE, 'api/repository.md', 'api/sort.md', 'api/search.md']);
    expect(cut.left).toBe(2);
  });

  // A card with no list gets every repository, and then nothing is about another repository: the cap holds.
  it('caps the index of a card on every repository like a run of no card', () => {
    const files = [entry(RUN_RECIPE_FILE, 0), ...Array.from({ length: 40 }, (_, at) => entry(`api/n${at}.md`, at)), entry('api/repository.md', 0), entry('web/repository.md', 0)];

    const picked = pickKnowledge(files, undefined, { card: ['api', 'web'], repos: ['api', 'web'] });
    expect(picked.kept).toHaveLength(KNOWLEDGE_INDEX_CAP);
    expect(picked.kept.slice(0, 3).map((one) => one.path)).toEqual([RUN_RECIPE_FILE, 'api/repository.md', 'web/repository.md']);
    expect(picked.left).toBe(files.length - KNOWLEDGE_INDEX_CAP);
    expect(picked.other).toBe(0);
  });

  // Only the card's file and its newest notes may pass the cap, so a repository with many notes stays bounded.
  it('lets only each card repository file and its newest notes pass the cap', () => {
    const notes = Array.from({ length: 40 }, (_, at) => entry(`api/n${String(at).padStart(2, '0')}.md`, at));
    const files = [entry(RUN_RECIPE_FILE, 0), entry('api/repository.md', 0), ...notes, entry('web/repository.md', 0)];

    const tight = pickKnowledge(files, 2, { card: ['api'], repos: ['api', 'web'] });
    expect(tight.kept.map((one) => one.path)).toEqual([RUN_RECIPE_FILE, 'api/repository.md', 'api/n39.md', 'api/n38.md', 'api/n37.md', 'api/n36.md', 'api/n35.md']);
    expect(tight.kept).toHaveLength(2 + CARD_NOTES);
    expect(tight.left).toBe(40 - CARD_NOTES);
    expect(tight.other).toBe(1);
    // With room under the cap, the rest of the card's notes follow, newest first.
    expect(pickKnowledge(files, undefined, { card: ['api'], repos: ['api', 'web'] }).kept).toHaveLength(KNOWLEDGE_INDEX_CAP);
  });

  // The project folder's own repository keeps its file and notes at the top of the knowledge folder.
  it('reads the top of the folder as the project folder repository when the project lists one', () => {
    const files = [entry(RUN_RECIPE_FILE, 0), entry('repository.md', 1), entry('build.md', 2), entry('api/repository.md', 1), entry('api/search.md', 3)];

    expect(pickKnowledge(files, undefined, { card: ['.'], repos: ['.', 'api'] })).toEqual({ kept: [files[0], files[1], files[2]], left: 0, other: 2 });
    expect(pickKnowledge(files, undefined, { card: ['api'], repos: ['.', 'api'] }).kept.map((one) => one.path)).toEqual([RUN_RECIPE_FILE, 'api/repository.md', 'api/search.md']);
  });

  it('says how many files about other repositories were left out', () => {
    const text = buildPrompt({ ...card, knowledgeIndex: { folder: '../../k', files: [entry('a.md', 0)], left: 0, other: 29 } });
    expect(text).toContain('29 files about other repositories are left out.');
    expect(buildPrompt({ ...card, knowledgeIndex: { folder: '../../k', files: [entry('a.md', 0)], left: 0, other: 1 } })).toContain('1 file about another repository is left out.');
    expect(buildPrompt({ ...card, knowledgeIndex: { folder: '../../k', files: [entry('a.md', 0)], left: 0, other: 0 } })).not.toContain('left out');
  });

  it('lists the files under the folder, after the read-first list and before how the run works', () => {
    const text = buildPrompt({
      ...card,
      phase: 'implement',
      readFirst: ['../../.tasks/PROJ-123/plan/plan.md'],
      knowledgeIndex: {
        folder: '../../.nolzu/knowledge',
        files: [entry(RUN_RECIPE_FILE, 0, 'How to install, test and start each repository.'), entry('api/repository.md', 0, 'Where the api repository sits and its base branch.'), entry('importer.md', 0, 'Read before changing the importer: why it refuses a row with no id.')],
        left: 0,
      },
    });

    expect(text).toContain(
      [
        '## Project knowledge',
        '',
        "The project's knowledge folder is `../../.nolzu/knowledge/`. Each line names one of its files and\nwhat it holds. Pick at most three files that match your work and read them before the code. The\nfolder is read only for this run.",
        '',
        '- `run-recipe.md`: How to install, test and start each repository.\n- `api/repository.md`: Where the api repository sits and its base branch.\n- `importer.md`: Read before changing the importer: why it refuses a row with no id.',
      ].join('\n'),
    );
    // A line that only says an area has no knowledge file tells the wrap-up nothing it can keep.
    expect(text).not.toContain('has no knowledge file');
    expect(text.indexOf('## Read first')).toBeLessThan(text.indexOf('## Project knowledge'));
    expect(text.indexOf('## Project knowledge')).toBeLessThan(text.indexOf('## How this run works'));
  });

  it('says how many files were left out, and cuts a long line', () => {
    const text = buildPrompt({ ...card, knowledgeIndex: { folder: '../../k', files: [entry('long.md', 0, 'x'.repeat(151))], left: 3 } });

    expect(text).toContain(`- \`long.md\`: ${'x'.repeat(150)} (cut)`);
    expect(text).toContain('3 more files are left out. The folder holds them all.');
    expect(buildPrompt({ ...card, knowledgeIndex: { folder: '../../k', files: [entry('a.md', 0)], left: 1 } })).toContain('1 more file is left out.');
  });

  it('adds nothing for an empty folder, so the prompt does not change', () => {
    expect(buildPrompt({ ...card, knowledgeIndex: { folder: '../../k', files: [], left: 0 } })).toBe(REFINE);
  });

  it('refuses a folder that names a path on this machine', () => {
    expect(() => buildPrompt({ ...card, knowledgeIndex: { folder: '/Users/somebody/.nolzu/knowledge', files: [entry('a.md', 0)], left: 0 } })).toThrow(/relative/);
  });
});

// Refine and Plan have no shell, so the prompt names the commit they read for `Read at:`.
it('names the commit the run reads under the card folder, and nothing when there is none', () => {
  const text = buildPrompt({ ...card, commit: { sha: '4f2a91c', date: '2026-10-25' } });
  expect(text).toBe(REFINE.replace('/refine/summary.md`.\n', '/refine/summary.md`.\n\nThe code you read is at commit 4f2a91c (2026-10-25).\n'));
  expect(buildPrompt(card)).toBe(REFINE);
});

// Codex lists no browser tool until one is called, and a QA run there wrote that no browser was
// configured. Every engine gets the same line.
describe('the browser', () => {
  const qa = { ...card, phase: 'qa', readOnly: false };

  it('names the browser servers of a QA run and says to use them', () => {
    const text = buildPrompt({ ...qa, browser: ['playwright'] });
    expect(text).toContain(
      'A browser is configured for this run, as the MCP server `playwright`. Its tools may not be\nlisted until you call one, so do not decide there is no browser. Use it for every check that\nneeds a page, and for the screenshots.',
    );
    expect(text.indexOf('A browser is configured')).toBeGreaterThan(text.indexOf('## How this run works'));
    expect(buildPrompt({ ...qa, browser: ['playwright', 'chrome'] })).toContain('as the MCP servers `playwright` and `chrome`.');
  });

  it('adds nothing without a browser, or to another phase', () => {
    expect(buildPrompt({ ...qa, browser: [] })).toBe(buildPrompt(qa));
    expect(buildPrompt({ ...card, browser: ['playwright'] })).toBe(REFINE);
  });

  it("names any other phase's servers with their descriptions, and adds nothing with none", () => {
    expect(buildPrompt({ ...card, servers: [{ name: 'db', description: 'The test database' }, { name: 'docs', description: '' }] })).toContain(
      'This run has the MCP servers `db` (The test database) and `docs`. Its tools may not be\nlisted until you call one, so do not decide a server is missing.',
    );
    expect(buildPrompt({ ...card, servers: [] })).toBe(REFINE);
  });

  // A run that got fewer servers than it was queued with names only the ones it got.
  it('swaps a server line for the one the run really got, or takes it out with its blank line', () => {
    const both = buildPrompt({ ...card, servers: [{ name: 'db', description: '' }, { name: 'docs', description: '' }] });
    const one = swapPromptLine(both, serversLine([{ name: 'db', description: '' }, { name: 'docs', description: '' }]), serversLine([{ name: 'db', description: '' }]));
    expect(one).toBe(buildPrompt({ ...card, servers: [{ name: 'db', description: '' }] }));
    expect(swapPromptLine(both, serversLine([{ name: 'db', description: '' }, { name: 'docs', description: '' }]), '')).toBe(REFINE);
    expect(swapPromptLine(REFINE, '', serversLine([{ name: 'db', description: '' }]))).toBe(REFINE);
    const priced = serversLine([{ name: 'db', description: 'costs $& per call' }]);
    expect(swapPromptLine(`a\n\nold`, 'old', priced)).toBe(`a\n\n${priced}`);
  });
});

// A fix round resumes the Implement session with a short message, and the run starts with
// implement/summary.md removed, so the message has to say to write it again.
it('tells a resumed run to write its summary again, and Implement to update the share files', () => {
  const fix = resumeMessage('implement', 'QA failed on the empty search.\n');

  expect(fix.startsWith('QA failed on the empty search.\n\n## Before you end\n')).toBe(true);
  expect(fix).toContain('`implement/summary.md`');
  expect(fix).toContain('`share/SUMMARY.md` and `share/TESTING.md`');
  const plan = resumeMessage('plan', 'Titles only.');
  expect(plan).toContain('`plan/summary.md`');
  expect(plan).not.toContain('share/');
  // An Ask writes no summary.
  expect(resumeMessage(ASK_PHASE, 'Why this name?')).toBe('Why this name?');
});
