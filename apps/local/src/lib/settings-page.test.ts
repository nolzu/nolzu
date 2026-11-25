import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS } from '@nolzu/core';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentsFor, knowledgeFor, postAgents, postKnowledge, saveAgentField, saveKnowledgeField } from './settings-page.ts';

const posted = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return form;
};

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-settings-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the Agents section', () => {
  it('reads the defaults from a fresh database, with the timeout in minutes', () => {
    expect(agentsFor(db)).toMatchObject({ slots: 3, timeoutMinutes: 30, keepAwake: true, waits: [2, 5, 15] });
  });

  it('stores five slots', () => {
    expect(saveAgentField(db, 'slots', '5')).toBeNull();
    expect(getSetting(db, 'agentSlots')).toBe(5);
  });

  it.each(['0', '21', 'four', '', '2.5'])('refuses %j slots with the rule, and stores nothing', (asked) => {
    expect(saveAgentField(db, 'slots', asked)).toMatch(/whole number from 1 to 20/);
    expect(getSetting(db, 'agentSlots')).toBe(DEFAULTS.agentSlots);
  });

  it('stores the timeout as milliseconds of the minutes that were typed', () => {
    expect(saveAgentField(db, 'timeout', '45')).toBeNull();
    expect(getSetting(db, 'runTimeoutMs')).toBe(45 * 60_000);
    expect(agentsFor(db).timeoutMinutes).toBe(45);
  });

  // The store counts milliseconds, the person typed minutes. The refusal has to say minutes.
  it.each(['0', '-5', 'soon', '1.5'])('refuses %j minutes in minutes, and stores nothing', (asked) => {
    expect(saveAgentField(db, 'timeout', asked)).toBe('The run timeout is a whole number of minutes, one or more.');
    expect(getSetting(db, 'runTimeoutMs')).toBe(DEFAULTS.runTimeoutMs);
  });

  it('reads the quiet time in minutes, five by default, and stores it as milliseconds', () => {
    expect(agentsFor(db).quietMinutes).toBe(5);

    expect(saveAgentField(db, 'quiet', '10')).toBeNull();
    expect(getSetting(db, 'quietAfterMs')).toBe(10 * 60_000);
    expect(agentsFor(db).quietMinutes).toBe(10);
  });

  it.each(['0', '-5', 'soon', '1.5', ''])('refuses %j quiet minutes in minutes, and stores nothing', (asked) => {
    expect(saveAgentField(db, 'quiet', asked)).toBe('The quiet time is a whole number of minutes, one or more.');
    expect(getSetting(db, 'quietAfterMs')).toBe(DEFAULTS.quietAfterMs);
  });

  it('turns keep awake off and on again', () => {
    expect(saveAgentField(db, 'keepAwake', '')).toBeNull();
    expect(getSetting(db, 'keepAwake')).toBe(false);
    expect(saveAgentField(db, 'keepAwake', 'on')).toBeNull();
    expect(getSetting(db, 'keepAwake')).toBe(true);
  });

  it('stores no retry as an empty list of waits', () => {
    expect(saveAgentField(db, 'retry', 'none')).toBeNull();
    expect(getSetting(db, 'retryWaitsMs')).toEqual([]);
    expect(agentsFor(db).waits).toEqual([]);
  });

  // The switch has two values, so a third one comes from a hand-made post. It is refused in the
  // switch's words and stores nothing.
  it('refuses a retry policy the switch does not send', () => {
    expect(saveAgentField(db, 'retry', 'weekly')).toBe('There is no retry policy weekly. Turn the switch on for the default waits, or off for none.');
    expect(getSetting(db, 'retryWaitsMs')).toEqual(DEFAULTS.retryWaitsMs);
  });

  it('puts the waits back when the default policy is picked again', () => {
    saveAgentField(db, 'retry', 'none');

    expect(saveAgentField(db, 'retry', 'default')).toBeNull();
    expect(getSetting(db, 'retryWaitsMs')).toEqual(DEFAULTS.retryWaitsMs);
  });

  it('refuses a policy it does not offer', () => {
    expect(saveAgentField(db, 'retry', 'forever')).toMatch(/forever/);
    expect(getSetting(db, 'retryWaitsMs')).toEqual(DEFAULTS.retryWaitsMs);
  });

  it('refuses a field this screen does not have', () => {
    expect(saveAgentField(db, 'workingHours', 'Mon-Fri')).toMatch(/workingHours/);
  });

  it('takes a posted form, and names the field it answers about', () => {
    expect(postAgents(db, posted({ field: 'slots', value: '5' }))).toEqual({ ok: true, field: 'slots', typed: '5', message: null });
    expect(getSetting(db, 'agentSlots')).toBe(5);
    // The refused value comes back, so the row shows the value the message is about.
    expect(postAgents(db, posted({ field: 'slots', value: '0' }))).toMatchObject({ ok: false, field: 'slots', typed: '0' });
    expect(getSetting(db, 'agentSlots')).toBe(5);
  });

  // A checkbox that is off sends no value at all. Read as a bad request it would be impossible to turn off.
  it('reads a keep awake checkbox that sends nothing as off', () => {
    expect(postAgents(db, posted({ field: 'keepAwake' }))).toMatchObject({ ok: true });
    expect(getSetting(db, 'keepAwake')).toBe(false);
  });

  // The Retry on API errors switch posts the default policy's id when on and nothing when off.
  it('reads a retry switch that sends nothing as no retry, and its id as the default waits', () => {
    expect(postAgents(db, posted({ field: 'retry' }))).toMatchObject({ ok: true, field: 'retry' });
    expect(getSetting(db, 'retryWaitsMs')).toEqual([]);

    expect(postAgents(db, posted({ field: 'retry', value: 'default' }))).toMatchObject({ ok: true });
    expect(getSetting(db, 'retryWaitsMs')).toEqual(DEFAULTS.retryWaitsMs);
  });

  // A list written into the database by hand is a real policy. Showing it as the default would be a lie.
  it('shows waits it did not offer as themselves', () => {
    writeSetting(db, 'retryWaitsMs', [60_000, 180_000]);

    expect(agentsFor(db).waits).toEqual([1, 3]);
  });

  // Three minute boxes that write the same wait list the retry policy reads.
  it('stores each retry box as its place in the wait list, in milliseconds', () => {
    expect(saveAgentField(db, 'wait2', '7')).toBeNull();
    expect(getSetting(db, 'retryWaitsMs')).toEqual([120_000, 420_000, 900_000]);
    expect(postAgents(db, posted({ field: 'wait3', value: '30' }))).toMatchObject({ ok: true, field: 'wait3' });
    expect(agentsFor(db).waits).toEqual([2, 7, 30]);
  });

  it('refuses a retry box that is not whole minutes, and keeps the waits', () => {
    expect(saveAgentField(db, 'wait1', '0')).toBe('The first retry is a whole number of minutes, one or more.');
    expect(saveAgentField(db, 'wait3', '2.5')).toBe('The third retry is a whole number of minutes, one or more.');
    expect(getSetting(db, 'retryWaitsMs')).toEqual(DEFAULTS.retryWaitsMs);
  });

  it('keeps a wait past the third when a box is saved', () => {
    writeSetting(db, 'retryWaitsMs', [60_000, 120_000, 180_000, 240_000]);
    expect(saveAgentField(db, 'wait2', '9')).toBeNull();
    expect(getSetting(db, 'retryWaitsMs')).toEqual([60_000, 540_000, 180_000, 240_000]);
  });

  it('shows three boxes, filling a short list from the default waits', () => {
    expect(agentsFor(db).boxes).toEqual([2, 5, 15]);
    writeSetting(db, 'retryWaitsMs', [60_000]);
    expect(agentsFor(db).boxes).toEqual([1, 5, 15]);
    expect(saveAgentField(db, 'wait1', '4')).toBeNull();
    expect(getSetting(db, 'retryWaitsMs')).toEqual([240_000, 300_000, 900_000]);
  });

  // Half a minute either way, so a timeout written by hand reads as the nearest minute and not as zero.
  it('reads a timeout that is not whole minutes as the nearest minute', () => {
    writeSetting(db, 'runTimeoutMs', 90_000);

    expect(agentsFor(db).timeoutMinutes).toBe(2);
  });
});

describe('the Knowledge section', () => {
  // Off by default, and free. A wrap-up then commits what it wrote, which is the state the app
  // ships in.
  it('reads the review toggle as off from a fresh database', () => {
    expect(knowledgeFor(db)).toEqual({ review: false });
  });

  it('turns review on, and back off when the checkbox sends nothing', () => {
    expect(saveKnowledgeField(db, 'reviewKnowledge', 'on')).toBeNull();
    expect(knowledgeFor(db).review).toBe(true);

    expect(postKnowledge(db, posted({ field: 'reviewKnowledge' }))).toMatchObject({ ok: true, field: 'reviewKnowledge' });
    expect(knowledgeFor(db).review).toBe(false);
  });

  it('names a field this screen does not have, rather than storing it', () => {
    expect(saveKnowledgeField(db, 'somethingElse', 'on')).toBe('There is no setting somethingElse on this screen.');
    expect(getSetting(db, 'reviewKnowledge')).toBe(false);
  });
});
