import { checkOutputs, isRepoStub, recipeSectionOf, repoKnowledge, runRecipe } from '@nolzu/core';
import { parseQuestionOptions, parseRound, parseTriage, QUESTION_FILE, refinedTitle, type RunEvent } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeEngine, fakeTriage, scenarioDelays } from './fake.ts';
import { claudeModels } from './models.ts';

async function replay(phase: string): Promise<RunEvent[]> {
  const engine = fakeEngine(0);
  const events: RunEvent[] = [];
  for await (const line of engine.spawn({ phase }, new AbortController().signal)) {
    events.push(...engine.parse(line));
  }
  return events;
}

it.each<[string, RunEvent['type'][], object]>([
  ['refine', ['session', 'text', 'tool', 'tool_result', 'text', 'complete'], { type: 'complete', costUsd: 0.0412 }],
  ['plan', ['session', 'text', 'tool', 'tool_result', 'text', 'tool', 'tool_result', 'text', 'complete'], { type: 'complete', costUsd: 0.0655 }],
  [
    'needs-input',
    ['session', 'tool', 'tool_result', 'text', 'needs_input', 'complete'],
    { type: 'needs_input', question: 'Should the search match ingredients as well as recipe titles?' },
  ],
  ['api-error', ['session', 'api_retry', 'api_retry', 'api_retry', 'failed'], { type: 'failed', status: 529 }],
  ['rate-limit', ['session', 'rate_limit', 'text', 'complete'], { type: 'rate_limit' }],
  ['commit-message', ['session', 'text', 'complete'], { type: 'text', text: 'feat(recipes): filter the list by title\n\nThe list was too long to scan by eye.' }],
  ['thread-title', ['session', 'text', 'complete'], { type: 'text', text: 'Where the recipe list comes from' }],
  [
    'implement',
    // Each call of this scenario reports its counts, so the fake engine shows the tokens so far.
    ['session', 'text', 'tool', 'usage', 'tool_result', 'text', 'tool', 'usage', 'tool_result', 'tool', 'usage', 'tool_result', 'tool', 'usage', 'tool_result', 'tool', 'usage', 'tool_result', 'tool', 'usage', 'tool_result', 'text', 'usage', 'complete'],
    { type: 'complete', costUsd: 0.1184 },
  ],
])('replays the %s scenario', async (phase, types, key) => {
  const events = await replay(phase);
  expect(events.map((event) => event.type)).toEqual(types);
  expect(events).toContainEqual(expect.objectContaining(key));
});

/**
 * The five phases of the boards beside Delivery.
 *
 * Fake mode is the only mode a person can walk a board in without spending money, and before these
 * every forward drop on Epics, Investigations, Questions and the PR review rounds ended failed with
 * this engine's own name on the card. Each one ends complete and reports a cost, because a run whose
 * cost never arrives draws no spend on the strip.
 */
it.each(['architecture', 'design', 'investigate', 'research', 'pr-review'])('replays the %s scenario to a complete run', async (phase) => {
  const events = await replay(phase);

  expect(events[0]?.type).toBe('session');
  expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'complete' }));
  expect(events.filter((event) => event.type === 'text').length).toBeGreaterThan(0);
  expect(events).toContainEqual(expect.objectContaining({ type: 'complete', costUsd: expect.any(Number) }));
});

// The streams were recorded on APP-1. Another card's run names its own folder, so its activity line,
// its peek and its log never point at APP-1's files.
it('names the running card in the paths of the recorded stream', async () => {
  const lines: string[] = [];
  for await (const line of fakeEngine(0).spawn({ phase: 'implement', cardKey: 'APP-2' }, new AbortController().signal)) lines.push(line);
  const stream = lines.join('\n');

  expect(stream).toContain('../../.tasks/APP-2/plan/plan.md');
  expect(stream).toContain('worktrees/APP-2"');
  expect(stream).not.toContain('APP-1/');

  const own: string[] = [];
  for await (const line of fakeEngine(0).spawn({ phase: 'implement', cardKey: 'APP-1' }, new AbortController().signal)) own.push(line);
  expect(own.join('\n')).toContain('../../.tasks/APP-1/plan/plan.md');
});

it('ends the stream when the signal aborts', async () => {
  const controller = new AbortController();
  const lines = fakeEngine(1000).spawn({ phase: 'refine' }, controller.signal)[Symbol.asyncIterator]();
  const next = lines.next();
  controller.abort();
  await expect(next).resolves.toEqual({ done: true, value: undefined });
});

it.each(['constructor', 'merge'])('names the missing scenario for the phase %j', async (phase) => {
  const lines = fakeEngine(0).spawn({ phase }, new AbortController().signal)[Symbol.asyncIterator]();
  await expect(lines.next()).rejects.toThrow(`The fake engine has no scenario for the phase "${phase}".`);
});

// The fake engine replays streams the Claude engine printed, so it offers the models that engine does.
it('offers the models the Claude engine offers', () => {
  expect(fakeEngine(0).listModels()).toEqual(claudeModels());
});

// The scenarios replay against a copy of the demo workspace, so every file they name is one it has,
// one in the card folder, which the prompt names from the checkout as `../../.tasks/<key>/`, or one
// in the knowledge folder, which the demo workspace ships nothing in because knowledge is earned.
// The card key is not pinned: each board's cards carry their own keys, and the card folder is never
// a file of the workspace whatever the key says.
it.each(Object.keys(scenarioDelays))('names only paths the demo workspace has in the %s scenario', (phase) => {
  const text = readFileSync(new URL(`../fake/${phase}.ndjson`, import.meta.url), 'utf8');
  const paths = [...text.matchAll(/"file_path": ?"([^"]+)"/g)].map((match) => match[1] ?? '');

  for (const path of paths) {
    if (path.startsWith('../../.tasks/') || path.startsWith('.nolzu/knowledge/')) continue;
    expect(existsSync(new URL(`../../../examples/recipe-workspace/${path}`, import.meta.url))).toBe(true);
  }
});

// A wrap-up that wrote nothing would leave the runner's commit with nothing to commit, so the
// scenario writes one knowledge file the way the skill asks a real run to.
it('writes one knowledge file in the wrap-up scenario', async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const knowledgeDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-knowledge-'));
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-task-'));

  const engine = fakeEngine(0);
  for await (const line of engine.spawn({ phase: 'wrapup', taskDir, knowledgeDir }, new AbortController().signal)) void line;

  const written = readdirSync(knowledgeDir);
  expect(written).toHaveLength(1);
  const note = readFileSync(join(knowledgeDir, written[0] ?? ''), 'utf8');
  expect(note).toContain('description:');
  // The note the output check reads beside the card files, in the entry shape the rules give.
  expect(checkOutputs('wrapup', { 'wrapup/changes.md': 'Added it.\n', 'wrapup/summary.md': 'Done.\n', [`knowledge/${written[0]}`]: note })).toEqual([]);
  for (const folder of [knowledgeDir, taskDir]) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The optimize scenario rewrites the one file the job names, and leaves the rest of the folder
// alone, which is what the skill asks a real run to do.
it('rewrites the named knowledge file in the optimize scenario, and no other', async () => {
  const { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const knowledgeDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-optimize-'));
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-task-'));
  mkdirSync(join(knowledgeDir, 'deep'), { recursive: true });
  writeFileSync(join(knowledgeDir, 'deep', 'search.md'), 'the old note\n');
  writeFileSync(join(knowledgeDir, 'other.md'), 'somebody else\n');

  const engine = fakeEngine(0);
  const job = { phase: 'optimize', taskDir, knowledgeDir, knowledgeFile: 'deep/search.md' };
  for await (const line of engine.spawn(job, new AbortController().signal)) void line;

  const note = readFileSync(join(knowledgeDir, 'deep', 'search.md'), 'utf8');
  expect(note).toContain('description:');
  expect(checkOutputs('optimize', { 'optimize/changes.md': 'Cut it.\n', 'optimize/summary.md': 'Done.\n', 'knowledge/deep/search.md': note })).toEqual([]);
  expect(readFileSync(join(knowledgeDir, 'other.md'), 'utf8')).toBe('somebody else\n');
  expect(readdirSync(knowledgeDir).sort()).toEqual(['deep', 'other.md']);
  // The summary the runner reads back and records, as every other scenario writes one.
  expect(readFileSync(join(taskDir, 'optimize', 'summary.md'), 'utf8')).toBe('One knowledge file is shorter and still true. Nothing else in the folder changed.\n');
  for (const folder of [knowledgeDir, taskDir]) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Learn this project asks before it writes, so a walk in fake mode shows the question with its answer
// buttons. The answer resumes the session, and the resumed run writes one note in the shape the
// output check asks of it.
it('asks one question with answers, then writes one note once answered, in the orient scenario', async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const knowledgeDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-orient-'));
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-task-'));
  try {
    const engine = fakeEngine(0);
    const asked: string[] = [];
    for await (const line of engine.spawn({ phase: 'orient', taskDir, knowledgeDir }, new AbortController().signal)) asked.push(line);
    expect(asked.join('\n')).toContain('NOLZU: needs_input: ');
    expect(readFileSync(join(taskDir, 'orient', 'question.md'), 'utf8')).toMatch(/^- .+: .+\n- .+: .+/);
    expect(readdirSync(knowledgeDir)).toEqual([]);

    for await (const line of engine.spawn({ phase: 'orient', taskDir, knowledgeDir, resumeFrom: 'a-session' }, new AbortController().signal)) void line;
    const written = readdirSync(knowledgeDir);
    expect(written).toEqual(['project-rules.md']);
    const note = readFileSync(join(knowledgeDir, 'project-rules.md'), 'utf8');
    const changes = readFileSync(join(taskDir, 'orient', 'changes.md'), 'utf8');
    expect(checkOutputs('orient', { 'orient/changes.md': changes, 'orient/summary.md': 'Done.\n', 'knowledge/project-rules.md': note })).toEqual([]);
  } finally {
    for (const folder of [knowledgeDir, taskDir]) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Learn your repositories, one run per repository: the fake fills that repository's file and its run
// recipe section, and leaves every other section as it was, so a walk in fake mode has a change to review.
it('fills one repository file and its run recipe section in the learn-repo scenario', async () => {
  const knowledgeDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-learn-'));
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-task-'));
  try {
    mkdirSync(join(knowledgeDir, 'api'));
    writeFileSync(join(knowledgeDir, 'api', 'repository.md'), repoKnowledge({ path: 'api', base: 'main' }));
    const recipe = runRecipe([{ path: 'api', scripts: null, files: [] }, { path: 'web', scripts: { test: 'vitest' }, files: [] }], null) ?? '';
    writeFileSync(join(knowledgeDir, 'run-recipe.md'), recipe);

    const lines: string[] = [];
    for await (const line of fakeEngine(0).spawn({ phase: 'learn-repo', cardKey: 'kb-learn-api', taskDir, knowledgeDir }, new AbortController().signal)) lines.push(line);

    expect(lines.join('\n')).toContain('NOLZU: complete');
    const file = readFileSync(join(knowledgeDir, 'api', 'repository.md'), 'utf8');
    expect(isRepoStub(file)).toBe(false);
    expect(file).toContain('- Base branch: `main`.');
    expect(file).toMatch(/- Test: .*\(from .+\)/);
    const after = readFileSync(join(knowledgeDir, 'run-recipe.md'), 'utf8');
    expect(recipeSectionOf(after, 'api')).not.toContain('there is no `package.json` at its top');
    expect(recipeSectionOf(after, 'api')).toContain('- Test: `node --test`. (from the ci.yml workflow)');
    expect(recipeSectionOf(after, 'web')).toBe(recipeSectionOf(recipe, 'web'));
    const changes = readFileSync(join(taskDir, 'learn-repo', 'changes.md'), 'utf8');
    expect(checkOutputs('learn-repo', { 'learn-repo/changes.md': changes, 'learn-repo/summary.md': 'Done.\n', 'knowledge/api/repository.md': file })).toEqual([]);
  } finally {
    for (const folder of [knowledgeDir, taskDir]) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The round the Review tab draws, beside the summary every scenario writes. The runner may not
// import the parser, so `review.test.ts` in apps/local holds this text against it. Here it is the
// three labels and the blank line between blocks, which is what that parser reads.
it('writes a round of three labelled blocks in the pr-review scenario', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-round-'));
  const engine = fakeEngine(0);
  for await (const line of engine.spawn({ phase: 'pr-review', taskDir }, new AbortController().signal)) void line;

  const round = readFileSync(join(taskDir, 'pr-review', 'round.md'), 'utf8');

  // Read with the Review tab's own parser, so the fake round is one the page draws.
  const read = parseRound(round);
  expect(read.ok ? read.blocks.map((block) => [block.label, block.line, block.end]) : read.problem).toEqual([
    ['issue', 1, 3],
    ['suggestion', 2, null],
    ['praise', 1, null],
  ]);
  rmSync(taskDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it.each(['refine', 'plan', 'implement', 'architecture', 'design', 'investigate', 'research', 'pr-review'])('writes the plain summary the %s skill would, into the card folder', async (phase) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-'));
  const engine = fakeEngine(0);
  for await (const line of engine.spawn({ phase, taskDir }, new AbortController().signal)) void line;

  expect(readFileSync(join(taskDir, phase, 'summary.md'), 'utf8').trim().length).toBeGreaterThan(0);
  rmSync(taskDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The Files tab draws the screen with the tokens it links, so the fake leaves a design that does that.
it('writes a finished screen that links its tokens, the tokens and the list, as the design skill would', async () => {
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-design-'));
  for await (const line of fakeEngine(0).spawn({ phase: 'design', taskDir }, new AbortController().signal)) void line;

  const screen = readFileSync(join(taskDir, 'design', 'main-page.html'), 'utf8');
  expect(screen).toContain('<link rel="stylesheet" href="tokens.css">');
  expect(screen).not.toContain('<script');
  for (const state of ['Empty', 'Error', 'Long text']) expect(screen).toContain(`<h2>${state}</h2>`);
  expect(readFileSync(join(taskDir, 'design', 'tokens.css'), 'utf8')).toContain(':root {');
  const list = readFileSync(join(taskDir, 'design', 'design.md'), 'utf8');
  for (const part of ['## Before you approve', '### main-page.html', 'Address: ', '- Empty (AC1, AC2): ', 'Data: ', 'Question: Q2: ']) expect(list).toContain(part);
  rmSync(taskDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('writes no summary for a run that was stopped', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-'));
  const stop = new AbortController();
  stop.abort();
  for await (const line of fakeEngine(0).spawn({ phase: 'refine', taskDir }, stop.signal)) void line;

  expect(existsSync(join(taskDir, 'refine', 'summary.md'))).toBe(false);
  rmSync(taskDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The plan names every repository the job lists, so a two-repository smoke run gets a list for its card.
it('writes a plan that ends in a line naming every repository the job lists', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-plan-'));
  for await (const line of fakeEngine(0).spawn({ phase: 'plan', taskDir, repositories: ['.', 'api', 'web'] }, new AbortController().signal)) void line;

  const plan = readFileSync(join(taskDir, 'plan', 'plan.md'), 'utf8');
  expect(plan.trim().split('\n').at(-1)).toBe('Repositories: ., api, web');

  // One repository: the same plan with no such line.
  for await (const line of fakeEngine(0).spawn({ phase: 'plan', taskDir }, new AbortController().signal)) void line;
  expect(readFileSync(join(taskDir, 'plan', 'plan.md'), 'utf8')).not.toContain('Repositories:');
  rmSync(taskDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Plan writes what QA will check, and QA reports one row per check in that
// order. The parser lives in ui, so `files.test.ts` in apps/local reads these rows with it. Here it
// is the shared order and the row form that parser reads.
it('writes the checks in the plan scenario and one row per check in the qa scenario', async () => {
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-checks-'));
  try {
    for (const phase of ['plan', 'qa']) {
      for await (const line of fakeEngine(0).spawn({ phase, taskDir }, new AbortController().signal)) void line;
    }
    // The How line under a check says how to observe it, and the report row leaves it out.
    const lines = readFileSync(join(taskDir, 'qa', 'checks.md'), 'utf8').trim().split('\n');
    const steps = lines.filter((line) => !line.startsWith('   How: '));
    const report = readFileSync(join(taskDir, 'qa', 'report.md'), 'utf8');
    // Each row carries its How and Evidence lines under it, which the plan's list does not have.
    const rows = report.split('## 2. What QA checked')[1]?.split('## 3.')[0]?.trim().split('\n').filter((line) => !line.startsWith('   '));

    expect(steps.every((step) => /^\d+\. \S/.test(step))).toBe(true);
    expect(lines).toHaveLength(steps.length * 2);
    expect(rows).toEqual(steps.map((step) => step.replace(/^(\d+\.) /, '$1 pass: ')));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

// The summary is there while the run goes on, after the first file it changed, as
// the skill writes it, and not only once the run has ended.
it('writes the summary after its first edit, while the replay still runs', async () => {
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-summary-'));
  try {
    const engine = fakeEngine(0);
    const seen: boolean[] = [];
    for await (const line of engine.spawn({ phase: 'implement', taskDir }, new AbortController().signal)) {
      seen.push(existsSync(join(taskDir, 'implement', 'summary.md')));
      void line;
    }
    // Not before the first edit, and there before the last line.
    expect(seen[0]).toBe(false);
    expect(seen.at(-1)).toBe(true);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

// The switches a walk in fake mode turns on to reach a QA FAIL and a question with options. Each one
// takes a card's first round only, read off what the card folder holds, so the next round is the
// phase's own scenario.
async function round(engine: ReturnType<typeof fakeEngine>, job: Parameters<ReturnType<typeof fakeEngine>['spawn']>[0]): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const line of engine.spawn(job, new AbortController().signal)) events.push(...engine.parse(line));
  return events;
}
const said = (events: RunEvent[]) => events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('\n');

it('fails the first QA round with a reason and a screenshot, then passes, with the QA switch on', async () => {
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-qa-fail-'));
  try {
    const engine = fakeEngine(0, { qaFailsFirst: true });

    const first = await round(engine, { phase: 'qa', taskDir });
    expect(said(first)).toContain('NOLZU: verdict: FAIL Typing a word in the search box leaves every recipe in the list');
    expect(first.at(-1)?.type).toBe('complete');
    const report = readFileSync(join(taskDir, 'qa', 'report.md'), 'utf8');
    expect(report).toContain('2. fail: AC1 (must): Type a word in the search box');
    expect(report).toContain('   Reason: every recipe stayed in the list');
    expect(report).toContain('   Expected: only recipes with that word in the title show');
    expect(readFileSync(join(taskDir, 'qa', 'evidence', '2-search-box.png')).subarray(1, 4).toString()).toBe('PNG');

    const second = await round(engine, { phase: 'qa', taskDir });
    expect(said(second)).toContain('NOLZU: verdict: PASS');
    expect(readFileSync(join(taskDir, 'qa', 'report.md'), 'utf8')).not.toContain('fail:');
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

it('asks one question with options on the first plan round, then plans after the answer, with the plan switch on', async () => {
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-plan-asks-'));
  try {
    const engine = fakeEngine(0, { planAsks: true });

    const first = await round(engine, { phase: 'plan', taskDir });
    expect(first).toContainEqual(expect.objectContaining({ type: 'needs_input', question: 'Should the search match ingredients as well as recipe titles?' }));
    expect(parseQuestionOptions(readFileSync(join(taskDir, 'plan', QUESTION_FILE), 'utf8'))?.map((option) => option.label)).toEqual(['Titles only', 'Titles and ingredients']);
    expect(existsSync(join(taskDir, 'plan', 'plan.md'))).toBe(false);

    // The answer resumes the session, and the plan goes on.
    const answered = await round(engine, { phase: 'plan', taskDir, resumeFrom: 'c2a91f5e-6d38-4b07-8e4a-1f9d3b6c0a25' });
    expect(answered.some((event) => event.type === 'needs_input')).toBe(false);
    expect(existsSync(join(taskDir, 'plan', 'plan.md'))).toBe(true);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

it('asks on a Fix of a pull request comment and goes on after the answer, with the fix switch on', async () => {
  const engine = fakeEngine(0, { fixAsks: true });
  const prompt = 'A reviewer left this on the pull request of your change. Change the code so it answers it.';
  expect(await round(engine, { phase: 'implement', prompt })).toContainEqual(expect.objectContaining({ type: 'needs_input' }));
  expect((await round(engine, { phase: 'implement', prompt: 'Titles only.' })).some((event) => event.type === 'needs_input')).toBe(false);
  expect((await round(fakeEngine(0), { phase: 'implement', prompt })).some((event) => event.type === 'needs_input')).toBe(false);
  expect((await round(engine, { phase: 'qa', prompt })).some((event) => event.type === 'needs_input')).toBe(false);
});

it('replays every phase as before with no switch on', async () => {
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-plain-'));
  try {
    expect(said(await round(fakeEngine(0), { phase: 'qa', taskDir }))).toContain('NOLZU: verdict: PASS');
    expect((await round(fakeEngine(0), { phase: 'plan', taskDir })).some((event) => event.type === 'needs_input')).toBe(false);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

// The refine skill's first lines: the key and a short title, then the kind and the branch words.
it('writes a brief that starts with the key, a short title, the kind and the branch', async () => {
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-refine-'));
  try {
    for await (const line of fakeEngine(0).spawn({ phase: 'refine', taskDir, cardKey: 'APP-7' }, new AbortController().signal)) void line;
    const brief = readFileSync(join(taskDir, 'refine', 'refined.md'), 'utf8');
    expect(brief.split('\n').slice(0, 3)).toEqual(['# APP-7: Search the recipe list', 'Kind: feature', 'Branch: recipe-search']);
    expect(refinedTitle(brief, 'APP-7')).toBe('Search the recipe list');
  } finally {
    rmSync(taskDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Each phase leaves the shapes its skill now asks for: numbered assumptions and checks in the brief,
// Covers on each plan step, the architecture's review block and sections, the deviations and one discovery line.
it('writes the new document shapes, the deviations and one discovery line', async () => {
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-shapes-'));
  try {
    for (const phase of ['refine', 'architecture', 'plan', 'implement']) {
      for await (const line of fakeEngine(0).spawn({ phase, taskDir, cardKey: 'APP-7' }, new AbortController().signal)) void line;
    }
    const brief = readFileSync(join(taskDir, 'refine', 'refined.md'), 'utf8');
    for (const part of ['## Before you approve', '## Assumptions', '- A1: ', '- AC1 (must): ', '- AC2 (should): ', '- Q1: ', 'blocks: no', '## What the code does today', '## Read first']) expect(brief).toContain(part);
    const plan = readFileSync(join(taskDir, 'plan', 'plan.md'), 'utf8');
    expect(plan.match(/^ {3}Covers: AC1, AC2$/gm)).toHaveLength(2);
    expect(plan).toContain('## Settled questions');
    // The architecture ran first, so the plan goes on from its D1.
    for (const part of ['## Before you approve', 'Read at: ', '- D2: ', '## Rules that apply', '## Read first']) expect(plan).toContain(part);
    expect(plan.match(/^ {3}Check: /gm)).toHaveLength(2);
    const architecture = readFileSync(join(taskDir, 'architecture', 'architecture.md'), 'utf8');
    expect(architecture.match(/^## /gm)).toHaveLength(12);
    for (const part of ['## Before you approve', 'Read at: ', '## Interfaces', '- D1: ', 'Not: ', '## Not doing', '## Read first']) expect(architecture).toContain(part);
    expect(readFileSync(join(taskDir, 'implement', 'deviations.md'), 'utf8')).toBe('None.\n');
    // The two files for other people, which every Implement run writes.
    expect(readFileSync(join(taskDir, 'share', 'SUMMARY.md'), 'utf8')).toContain('search box');
    expect(readFileSync(join(taskDir, 'share', 'TESTING.md'), 'utf8')).toContain('Open the recipe list');
    expect(readFileSync(join(taskDir, 'qa', 'checks.md'), 'utf8')).toContain('2. AC1 (must): ');
    const discoveries = readFileSync(join(taskDir, 'discoveries.md'), 'utf8').trim().split('\n');
    expect(discoveries).toHaveLength(1);
    expect(discoveries[0]).toMatch(/^- .+, in \S+\/\S+: .+ \(plan\)$/);

    // A second plan keeps what is there, its own line included, and adds nothing it already said.
    const earlier = '- The list page caches the first fetch, in web/src/routes/+page.ts: a filter has to ask again (implement)';
    writeFileSync(join(taskDir, 'discoveries.md'), `${earlier}\n`);
    for (let round = 0; round < 2; round++) {
      for await (const line of fakeEngine(0).spawn({ phase: 'plan', taskDir }, new AbortController().signal)) void line;
    }
    expect(readFileSync(join(taskDir, 'discoveries.md'), 'utf8').trim().split('\n')).toEqual([earlier, discoveries[0]]);
  } finally {
    rmSync(taskDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The loop checks what every run that ended ready wrote, so a walk in fake mode would show a badge on
// every card if the fake left out a file the check reads.
it('leaves files the output check passes, phase after phase', async () => {
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-check-'));
  const phases = ['refine', 'architecture', 'design', 'plan', 'implement', 'qa', 'wrapup', 'research', 'investigate', 'pr-review', 'assess', 'optimize'];
  try {
    const found: Record<string, unknown> = {};
    for (const phase of phases) {
      for await (const line of fakeEngine(0).spawn({ phase, taskDir, cardKey: 'APP-7' }, new AbortController().signal)) void line;
      const files: Record<string, string> = {};
      for (const folder of readdirSync(taskDir).filter((name) => !name.includes('.'))) {
        for (const name of readdirSync(join(taskDir, folder)).filter((one) => one.endsWith('.md'))) files[`${folder}/${name}`] = readFileSync(join(taskDir, folder, name), 'utf8');
      }
      // The walk has an architecture, so its plan is an epic's and writes the plan for other people.
      found[phase] = checkOutputs(phase, files, phase === 'plan' ? 'epics' : undefined);
    }
    expect(found).toEqual(Object.fromEntries(phases.map((phase) => [phase, []])));
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

// The knowledge rules' own example passes the note check, so a wrap-up that copies it gets no badge.
it('the knowledge rules teach a note the output check passes', () => {
  const lines = readFileSync(join(import.meta.dirname, '..', '..', 'skills', 'shared', 'knowledge.md'), 'utf8').split('\n');
  const start = lines.indexOf('    ---');
  const end = lines.findIndex((line, at) => at > start && line.startsWith('    Why:'));
  expect(start).toBeGreaterThan(-1);
  const note = lines.slice(start, end + 1).map((line) => line.slice(4)).join('\n');
  expect(checkOutputs('wrapup', { 'wrapup/changes.md': 'Added it.\n', 'wrapup/summary.md': 'Done.\n', 'knowledge/rows.md': `${note}\n` })).toEqual([]);
  expect(note).toContain('paths: ');
});

// The same check holds the skills to their own skeletons: filled in, each passes it, so a run that
// follows its skill to the letter gets no badge. The review skeleton is a re-review's summary.
const SECOND_ROUND = 'issue: a.ts:1\nWrong.\n\nsuggestion: b.ts:2\nBetter.\n\npraise: c.ts:3\nGood.\n';
it.each<[string, string, string, number, (text: string) => Record<string, string>]>([
  ['research', '<The answer', '- api/src/validate.ts:14', 4, (text) => ({ 'research/answer.md': text, 'research/summary.md': 'Done.\n' })],
  ['investigate', '<The cause', '- api/src/upload.ts:88', 4, (text) => ({ 'investigate/report.md': text, 'investigate/summary.md': 'Done.\n' })],
  ['pr-review', 'Verdict:', 'Not reviewed:', 4, (text) => ({ 'pr-review/round.md': 'issue: a.ts:1\nWrong.\n', 'pr-review/round-2.md': SECOND_ROUND, 'pr-review/summary.md': text })],
  ['assess', 'Confidence:', 'What would change it:', 7, (text) => ({ 'assess/assessment.md': `## The evidence\n\na.ts:1\n\n## The likely cause\n\nIt.\n\n${text}\n\n## The proposal\n\nIt.\n\n## The effort\n\nIt.\n\n## The risks\n\nIt.\n`, 'assess/summary.md': 'Done.\n' })],
])('the %s skill teaches a file the output check passes', (phase, first, last, indent, files) => {
  const lines = readFileSync(join(import.meta.dirname, '..', '..', 'skills', 'skills', `nolzu-${phase}`, 'SKILL.md'), 'utf8').split('\n');
  const margin = ' '.repeat(indent);
  const start = lines.findIndex((line) => line.startsWith(`${margin}${first}`));
  const end = lines.findIndex((line, at) => at > start && line.startsWith(`${margin}${last}`));
  expect(start).toBeGreaterThan(-1);
  const text = lines.slice(start, end + 1).map((line) => line.slice(indent)).join('\n').replace(/<[^>]+>/g, 'it');
  expect(checkOutputs(phase, files(`${text}\n`))).toEqual([]);
});

// The triage the PRs tab applies: one block per ref of the comments file the loop wrote, in the shape
// the loop's parser takes whole, and one it refuses whole behind the switch.
it('writes one triage block per ref in the feedback scenario, and a broken one behind its switch', async () => {
  const taskDir = mkdtempSync(join(tmpdir(), 'nolzu-fake-triage-'));
  try {
    mkdirSync(join(taskDir, 'feedback'), { recursive: true });
    writeFileSync(join(taskDir, 'feedback', 'discussions.md'), '# Open discussions\n\n## T2\n\nKind: comment\n\n## T5\n\nKind: comment\n\n## T7\n\nKind: comment\n');
    for await (const line of fakeEngine(0).spawn({ phase: 'feedback', taskDir }, new AbortController().signal)) void line;
    const read = parseTriage(readFileSync(join(taskDir, 'feedback', 'triage.md'), 'utf8'));
    expect(read.ok && read.blocks.map((one) => [one.ref, one.verdict, one.reply === null])).toEqual([
      ['T2', 'fix', false],
      ['T5', 'clarify', false],
      ['T7', 'none', true],
    ]);
    expect(parseTriage(fakeTriage('## T1\n', true)).ok).toBe(false);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});
