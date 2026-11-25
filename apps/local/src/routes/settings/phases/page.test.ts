import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, writeSetting } from '@nolzu/core/node';
import { PHASE_HELP, PHASE_INSTRUCTION_HELP } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { afterAll, expect, it } from 'vitest';
import Page from './+page.svelte';

// The route reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported and opens anything.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-phases-route-'));
process.env.NOLZU_DATA_DIR = dir;
const project = join(dir, 'recipes');
mkdirSync(project);
const db = openDatabase(dir);
writeSetting(db, 'projectPath', project);
db.close();

const { actions, load } = await import('./+page.server.ts');
type Row = { phase: string; label: string; path: string; text: string; cut: boolean };
const page = load as unknown as () => { phases: Row[] };
const post = (body: Record<string, string>) => ({ request: new Request('http://localhost/settings/phases', { method: 'POST', body: new URLSearchParams(body) }) });
type Answer = { phase?: string; saved?: boolean; status?: number; data?: { phase: string; text: string; message: string } };
const file = join(project, '.nolzu', 'phases', 'plan.md');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('lists each phase with its label, its file and no text while there is none', () => {
  const rows = page().phases;

  expect(rows.find((row) => row.phase === 'plan')).toEqual({ phase: 'plan', label: 'Plan', path: '.nolzu/phases/plan.md', text: '', cut: false });
  expect(rows.find((row) => row.phase === 'pr-review')?.label).toBe('PR review');
  expect(rows.map((row) => row.phase)).not.toContain('extract-summary');
  // Assessment reads Scout findings only, and waits with Scout.
  expect(rows.map((row) => row.phase)).not.toContain('assess');
});

it('writes the file on Save and reads it back', async () => {
  const answer = (await actions.save!(post({ phase: 'plan', text: 'plan.md must also have a Risks section.' }) as never)) as Answer;

  expect(answer).toEqual({ phase: 'plan', saved: true });
  expect(readFileSync(file, 'utf8')).toBe('plan.md must also have a Risks section.\n');
  expect(page().phases.find((row) => row.phase === 'plan')?.text).toBe('plan.md must also have a Risks section.');
});

it('deletes the file on an empty Save', async () => {
  const answer = (await actions.save!(post({ phase: 'plan', text: '' }) as never)) as Answer;

  expect(answer).toEqual({ phase: 'plan', saved: true });
  expect(existsSync(file)).toBe(false);
});

it('refuses a phase Nolzu does not have, and keeps what was typed', async () => {
  const answer = (await actions.save!(post({ phase: '../../.ssh/config', text: 'Host *' }) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(answer.data).toEqual({ phase: '../../.ssh/config', text: 'Host *', message: 'There is no phase ../../.ssh/config.' });
  expect(existsSync(join(project, '.ssh'))).toBe(false);
});

it('draws a box per phase with its file, and the refusal under the phase it belongs to', () => {
  const form = { phase: 'qa', text: 'Check the login page.', message: 'There is no phase qa.' };
  const { body } = render(Page as never, { props: { data: { hasFolder: true, phases: page().phases }, form } } as never);

  expect(body).toContain('<label class="lb');
  expect(body).toContain('.nolzu/phases/plan.md');
  expect(body).toContain('Check the login page.</textarea>');
  expect(body).toContain('There is no phase qa.');
  // A run has no Skill tool and nobody answers inside it, so an example that asks for a skill cannot work.
  expect(body).toContain('plan.md must also have a Risks section');
  expect(body).not.toContain('brainstorming');
});

// The file is not only for Nolzu's runs: the skills point at it, so the page says it works without Nolzu too.
it('says the file also works when an engine runs without Nolzu', () => {
  const { body } = render(Page as never, { props: { data: { hasFolder: true, phases: page().phases }, form: null } } as never);

  expect(body).toContain('so it also works without Nolzu');
});

// The explanation is one info box under the title, in short lines.
it('explains the page in one info box under the title', () => {
  const { body } = render(Page as never, { props: { data: { hasFolder: true, phases: page().phases }, form: null } } as never);
  const box = body.slice(body.indexOf('data-info-box'), body.indexOf('</div></div>', body.indexOf('data-info-box')));

  expect(body.match(/data-info-box/g)).toHaveLength(1);
  expect(body.indexOf('data-info-box')).toBeGreaterThan(body.indexOf('id="phases-title"'));
  expect(body.indexOf('data-info-box')).toBeLessThan(body.indexOf('<form'));
  expect(box).toContain('plan.md must also have a Risks section');
  // Short: three lines at most, and the path says the project folder, which a workspace
  // of several repositories has one of.
  expect(box.match(/<p>/g)!.length).toBeLessThanOrEqual(3);
  expect(body).toContain('in the project folder.');
  expect(body).not.toContain('review block');
  // Said once in the box, not under each of the phases.
  expect(box).toContain('Commit the files to share them with your team. An empty Save deletes the file.');
  expect(body.match(/Commit the files/g)).toHaveLength(1);
});

// Each phase has a "?" with what it does (the same line Settings, Models shows), what it writes,
// what an instruction there is good for, and one example.
it('gives every phase a help tip with its Models line, what it writes and an example', () => {
  const { body } = render(Page as never, { props: { data: { hasFolder: true, phases: page().phases }, form: null } } as never);

  for (const row of page().phases) {
    const help = PHASE_INSTRUCTION_HELP[row.phase];
    expect(help, row.phase).toBeDefined();
    for (const line of [help!.writes, help!.use, help!.example]) expect(line, row.phase).toMatch(/^[A-Z].*\.$/);
    const form = body.slice(body.indexOf(`name="phase" value="${row.phase}"`));
    const tip = form.slice(0, form.indexOf('</textarea>'));
    expect(tip, row.phase).toContain(`aria-label="About ${row.label}"`);
    expect(tip, row.phase).toContain(`${PHASE_HELP[row.phase]} ${help!.writes} ${help!.use}`);
    expect(tip, row.phase).toContain(help!.example);
  }
});
