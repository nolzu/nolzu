import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_KINDS, type BoardKind } from '@nolzu/protocol';
import { boardFor, isAction } from '@nolzu/core';
import { writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createLoop, type Loop } from './loop.ts';

/**
 * Every phase a stage names can be started.
 *
 * A phase runs when it has a skill, a policy row and a row in the action table. The three live in
 * three packages, and a stage that names a phase missing from any of them builds no job: the
 * person drags the card, the run fails, and the board says a phase nobody can repair. This walks
 * every agent stage of every board and asks the builder for the job that drop would start.
 */
let dir = '';
let project = '';
let loop: Loop;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-board-phases-'));
  // A project folder, because the wrap-up writes knowledge and its job names that folder.
  project = mkdtempSync(join(tmpdir(), 'nolzu-board-phases-project-'));
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  writeSetting(loop.db, 'projectPath', project);
});

afterEach(() => {
  loop.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// One card per board, sitting where the test puts it. The key is plain, because it names the card
// folder the job points at.
const addCard = (key: string, board: BoardKind, stage: string) =>
  loop.db.prepare('INSERT INTO cards (key, board, stage, state, title) VALUES (?, ?, ?, ?, ?)').run(key, board, stage, 'idle', 'Add a search box');

const stagesOf = (kind: BoardKind) => boardFor(kind, 'pull-request').stages.filter((stage) => stage.phase !== undefined);

it.each([...BOARD_KINDS])('builds a job for every phase a stage of %s names', (kind) => {
  const stages = stagesOf(kind);
  expect(stages.length).toBeGreaterThan(0);

  for (const [at, stage] of stages.entries()) {
    const phase = stage.phase ?? '';
    const key = `CARD-${at}`;
    addCard(key, kind, stage.id);
    // The action table is what the phase's model comes from, and the builder takes the action type.
    expect(isAction(phase), `${kind} ${stage.id}`).toBe(true);
    if (!isAction(phase)) continue;

    const job = loop.buildJob(key, phase, at + 1);

    expect(job.phase, stage.id).toBe(phase);
    // The model and the effort come off the action table, resolved for the profile the row runs on.
    expect(job.model, stage.id).not.toBe('');
    expect(job.effort, stage.id).not.toBe('');
    // The tools come off the policy row, and an empty list is a phase the policy table missed.
    expect(job.tools.length, stage.id).toBeGreaterThan(0);
    // The method, built from the phase's skill and named by the prompt's first line.
    // `phase-skills.test.ts` holds the phase against the folders this app ships.
    expect(job.instructions, stage.id).toContain(`${phase} phase`);
    expect(job.prompt.split('\n')[0], stage.id).toContain(`/${phase}/instructions.md\``);
  }
});
