import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS, type SettingKey, type Settings } from '@nolzu/core';
import { getSetting, settingProblem, writeSetting } from '@nolzu/core/node';

const minutes = (ms: number) => Math.round(ms / 60_000);

export const RETRY_CHOICES = [
  // Resuming the same session after a wait, which is what an API error deserves: the work already done is kept.
  { id: 'default', waits: DEFAULTS.retryWaitsMs },
  { id: 'none', waits: [] },
] as const;

export interface AgentsSection {
  slots: number;
  timeoutMinutes: number;
  quietMinutes: number;
  keepAwake: boolean;
  // The stored waits in minutes, empty for no retry. A list written into the database by hand is
  // shown as itself rather than as the default.
  waits: number[];
  // The three retry boxes in minutes. A stored list shorter than three is filled from the defaults.
  boxes: number[];
}

// The stored waits with the first three places filled, so a box always has a wait to change.
const threeWaits = (stored: readonly number[]): number[] => DEFAULTS.retryWaitsMs.map((wait, at) => stored[at] ?? wait).concat(stored.slice(3));
const RETRY_BOX = /^wait([123])$/;
const NTH = ['first', 'second', 'third'];

export function agentsFor(db: DatabaseSync): AgentsSection {
  return {
    slots: getSetting(db, 'agentSlots'),
    timeoutMinutes: minutes(getSetting(db, 'runTimeoutMs')),
    quietMinutes: minutes(getSetting(db, 'quietAfterMs')),
    keepAwake: getSetting(db, 'keepAwake'),
    waits: getSetting(db, 'retryWaitsMs').map(minutes),
    boxes: threeWaits(getSetting(db, 'retryWaitsMs')).slice(0, 3).map(minutes),
  };
}

// The message the value was refused with, or null when it is stored. The settings module owns the
// rules, so a screen never carries a second copy of them.
export function storeSetting<K extends SettingKey>(db: DatabaseSync, key: K, value: Settings[K]): string | null {
  const refused = settingProblem(db, key, value);
  if (refused !== null) return refused;
  writeSetting(db, key, value);
  return null;
}

// One field of the Runs section. The timeout and the quiet time are minutes on the screen and
// milliseconds in the store, so each is refused in the words the person typed in.
export function saveAgentField(db: DatabaseSync, field: string, value: string): string | null {
  if (field === 'slots') return storeSetting(db, 'agentSlots', Number(value));
  if (field === 'timeout') {
    const asked = Number(value);
    if (!Number.isInteger(asked) || asked < 1) return 'The run timeout is a whole number of minutes, one or more.';
    return storeSetting(db, 'runTimeoutMs', asked * 60_000);
  }
  if (field === 'quiet') {
    const asked = Number(value);
    if (!Number.isInteger(asked) || asked < 1) return 'The quiet time is a whole number of minutes, one or more.';
    return storeSetting(db, 'quietAfterMs', asked * 60_000);
  }
  if (field === 'retry') {
    // The switch posts the default's id when on and nothing when off.
    const choice = RETRY_CHOICES.find((one) => one.id === (value === '' ? 'none' : value));
    if (choice === undefined) return `There is no retry policy ${value}. Turn the switch on for the default waits, or off for none.`;
    return storeSetting(db, 'retryWaitsMs', [...choice.waits]);
  }
  const box = RETRY_BOX.exec(field);
  if (box !== null) {
    const at = Number(box[1]) - 1;
    const asked = Number(value);
    if (!Number.isInteger(asked) || asked < 1) return `The ${NTH[at]} retry is a whole number of minutes, one or more.`;
    const waits = threeWaits(getSetting(db, 'retryWaitsMs'));
    waits[at] = asked * 60_000;
    return storeSetting(db, 'retryWaitsMs', waits);
  }
  if (field === 'keepAwake') return storeSetting(db, 'keepAwake', value === 'on');
  return `There is no setting ${field} on this screen.`;
}

export interface KnowledgeSection {
  review: boolean;
}

export function knowledgeFor(db: DatabaseSync): KnowledgeSection {
  return { review: getSetting(db, 'reviewKnowledge') };
}

// One field of the Knowledge section. The knowledge location joins it when something writes that
// setting.
export function saveKnowledgeField(db: DatabaseSync, field: string, value: string): string | null {
  if (field === 'reviewKnowledge') return storeSetting(db, 'reviewKnowledge', value === 'on');
  return `There is no setting ${field} on this screen.`;
}

// What a section's form posts. A checkbox that is off sends no value at all, which is how keep awake
// and retry are turned off, so a missing value is a value here and not a bad request.
export function postSetting(
  db: DatabaseSync,
  form: FormData,
  save: (db: DatabaseSync, field: string, value: string) => string | null,
): { ok: boolean; field: string; typed: string; message: string | null } {
  const field = form.get('field')?.toString() ?? '';
  const typed = form.get('value')?.toString() ?? '';
  const message = save(db, field, typed);
  // The typed value goes back with a refusal, so the row still shows the value the message is about.
  return { ok: message === null, field, typed, message };
}

export const postAgents = (db: DatabaseSync, form: FormData) => postSetting(db, form, saveAgentField);
export const postKnowledge = (db: DatabaseSync, form: FormData) => postSetting(db, form, saveKnowledgeField);
