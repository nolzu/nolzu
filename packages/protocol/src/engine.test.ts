import { describe, expect, it } from 'vitest';
import {
  CONFIG_DIR_VAR,
  DEFAULT_PROFILE,
  ENGINE_NAMES,
  goneProblem,
  isEngineName,
  isProfileId,
  missingProfileText,
  profileId,
  wallLabel,
} from './engine.ts';

describe('profileId', () => {
  // The form is the vendor, then the label. The vendor is in it
  // so the id says which CLI it runs without a lookup.
  it('makes an id from the vendor and the label a person typed', () => {
    expect(profileId('Work account', 'codex', [])).toBe('codex#work-account');
  });

  it('folds punctuation and case into one shape', () => {
    expect(profileId("  Péter's  MAIN  box!! ", 'codex', [])).toBe('codex#p-ter-s-main-box');
  });

  // Two vendors, one label. Without the vendor in the id these would be `work` and `work-2`, which
  // reads as two logins of one vendor.
  it('keeps two vendors apart when the labels are the same', () => {
    expect(profileId('Work', 'codex', [])).toBe('codex#work');
    expect(profileId('Work', 'cursor', ['codex#work'])).toBe('cursor#work');
  });

  // Both paths of the collision rule. A base that is free is kept, and one that is taken gets a
  // number, because two profiles under one id would share every stored choice in silence.
  it('numbers an id that is already taken, and keeps counting', () => {
    expect(profileId('Work', 'codex', ['codex#work'])).toBe('codex#work-2');
    expect(profileId('Work', 'codex', ['codex#work', 'codex#work-2'])).toBe('codex#work-3');
    expect(profileId('Work', 'codex', ['codex#work', 'codex#work-3'])).toBe('codex#work-2');
  });

  // A label with nothing to slug, which a person typing in a script with no ASCII letters reaches
  // at once. Without the fallback the id would end in a bare `#`.
  it('falls back to the bare vendor when the label slugs to nothing', () => {
    expect(profileId('!!!', 'cursor', [])).toBe('cursor');
    expect(profileId('東京', 'cursor', [])).toBe('cursor');
    expect(profileId('', 'cursor', ['cursor'])).toBe('cursor-2');
  });

  it('keeps an id short enough to read, and ends it on a word', () => {
    const id = profileId('x'.repeat(200), 'codex', []);

    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toMatch(/[a-z0-9]$/);
    // And still short enough after a collision, which appends to it.
    const next = profileId('x'.repeat(200), 'codex', [id]);
    expect(next.length).toBeLessThanOrEqual(64);
  });

  // Whatever it makes has to pass the check a stored list is read back through, or a profile the
  // person just added would be refused the next time the app opens.
  it('makes an id the stored shape accepts', () => {
    for (const label of ['Work account', '!!!', 'x'.repeat(200), 'a b c']) {
      expect(isProfileId(profileId(label, 'codex', [])), label).toBe(true);
    }
    expect(isProfileId('has space')).toBe(false);
    expect(isProfileId('#work')).toBe(false);
    expect(isProfileId('codex#')).toBe(false);
  });

  // The id is made once and frozen, so this is the property a rename depends on: the same label
  // always gives the same id, and nothing about the answer depends on the order of `taken`.
  it('gives the same answer twice for the same label', () => {
    expect(profileId('Work account', 'codex', ['a', 'b'])).toBe(profileId('Work account', 'codex', ['b', 'a']));
  });
});

describe('the engine names', () => {
  it('knows the three this product runs, and nothing else', () => {
    expect([...ENGINE_NAMES]).toEqual(['claude-code', 'cursor', 'codex']);
    expect(isEngineName('antigravity')).toBe(false);
    expect(isEngineName('claude-code')).toBe(true);
    expect(isEngineName('gemini-cli')).toBe(false);
  });

  // One row per engine, so a fifth engine cannot be added without answering this for it. A map
  // read with a missing key would hand back undefined and set no variable at all.
  it('says for every engine which variable points at a second login', () => {
    for (const name of ENGINE_NAMES) expect(Object.hasOwn(CONFIG_DIR_VAR, name)).toBe(true);
    expect(CONFIG_DIR_VAR['claude-code']).toBe('CLAUDE_CONFIG_DIR');
    expect(CONFIG_DIR_VAR.codex).toBe('CODEX_HOME');
    expect(CONFIG_DIR_VAR.cursor).toBe('CURSOR_CONFIG_DIR');
  });
});

it('ships one profile whose id a stored action table already names', () => {
  // The id every installation starts on. Changing it would orphan every row that stored it.
  expect(DEFAULT_PROFILE.id).toBe('claude-code');
  expect(DEFAULT_PROFILE.vendor).toBe('claude-code');
  expect(DEFAULT_PROFILE.configDir).toBeNull();
});

it('names the profile in the sentence a screen shows', () => {
  expect(missingProfileText('codex-work')).toContain('codex-work');
});

// One wording for a gone model on both settings screens and the refused drop.
it('says a gone model with the engine that dropped it and what to do', () => {
  expect(goneProblem('Refine', 'claude-opus-3-old', 'claude-code#work')).toBe('Refine uses claude-opus-3-old, which Claude Code no longer offers. Refine will not start until you pick another.');
});

describe('wallLabel', () => {
  // What the card History row and the run log say beside the engine.
  it('names each wall a run row can store', () => {
    expect(wallLabel('macos')).toBe('walled by macOS');
    expect(wallLabel('bubblewrap')).toBe('walled by bubblewrap');
    expect(wallLabel('codex')).toBe('Codex sandbox');
    expect(wallLabel('none')).toBe('not walled');
  });

  // A row made before the column holds none, and a value this version does not know is not guessed.
  it('says nothing for an old row or an unknown value', () => {
    expect(wallLabel(null)).toBeNull();
    expect(wallLabel(undefined)).toBeNull();
    expect(wallLabel('seatbelt')).toBeNull();
  });
});
