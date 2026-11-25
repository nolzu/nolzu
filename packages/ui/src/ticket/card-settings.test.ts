import { describe, expect, it } from 'vitest';
import { followsSaid, isChanged, ownValues, presetLabel, presetUses, resetSaid, switchSaid } from './card-settings.ts';

const MEASURED = { costUsd: 0.4, lowMs: 360_000, highMs: 600_000, from: 'history' as const, runs: 8 };

describe('the card settings words', () => {
  it('names the stored default Balanced', () => {
    expect(['light', 'default', 'heavy'].map(presetLabel)).toEqual(['Light', 'Balanced', 'Heavy']);
  });

  it('counts a row as changed only when the card stores a value for it', () => {
    expect(isChanged({})).toBe(false);
    expect(isChanged({ effort: 'high' })).toBe(true);
  });

  // What Reset gives back. The engine is named only when the row runs on another one now.
  it('says what the preset would use, with the figure only where runs measured it', () => {
    const heavy = { engine: 'claude-code', model: 'opus', effort: 'high', from: { model: 'preset', effort: 'preset' } };

    expect(presetUses('heavy', heavy, 'claude-code')).toBe('Heavy uses opus · high.');
    expect(presetUses('heavy', heavy, 'claude-code', MEASURED)).toBe('Heavy uses opus · high, about $0.40.');
    expect(presetUses('default', heavy, 'codex#work')).toBe('Balanced uses Claude Code · opus · high.');
    // Cursor reads the effort off the model id, so the note names none.
    const cursor = { engine: 'cursor', model: 'composer-2.5', effort: 'low', from: { model: 'preset', effort: 'preset' } };
    expect(presetUses('Light on Cursor', cursor, 'cursor', undefined, true)).toBe('Light on Cursor uses composer-2.5.');
    expect(presetUses('Light on Cursor', cursor, 'claude-code', undefined, true)).toBe('Light on Cursor uses Cursor · composer-2.5.');
  });

  // A step the project set in Settings, Models goes back to that row, which is not the preset's.
  it('names the project when Reset gives back a row of Settings, Models', () => {
    const project = { engine: 'claude-code', model: 'opus', effort: 'medium', from: { model: 'global', effort: 'preset' } };

    expect(presetUses('default', project, 'claude-code')).toBe('The project uses opus · medium.');
    expect(resetSaid('Plan', 'default', project)).toBe('Plan follows the project again.');
    expect(resetSaid('Plan', 'heavy', { from: { model: 'preset', effort: 'preset' } })).toBe('Plan follows Heavy again.');
  });

  // The line counts values, not steps: "With 2 values of its own."
  it('says how many values the card set itself', () => {
    expect(followsSaid('default', 0)).toBe('No values of its own. Every step changes when Balanced changes.');
    expect(followsSaid('default', 1)).toBe('With 1 value of its own. The rest changes when Balanced changes.');
    expect(followsSaid('heavy', 2)).toBe('With 2 values of its own. The rest changes when Heavy changes.');
  });

  // An engine is only ever stored with its model, so the pair is one value and the effort another.
  it('counts the engine and model as one value and the effort as another', () => {
    expect(ownValues({})).toBe(0);
    expect(ownValues({ model: 'opus' })).toBe(1);
    expect(ownValues({ engine: 'codex#work', model: 'gpt-9' })).toBe(1);
    expect(ownValues({ engine: 'claude-code', model: 'opus', effort: 'high' })).toBe(2);
    expect(ownValues({ effort: 'low' })).toBe(1);
  });

  // A switch clears the card's own rows and names each one in one line.
  it('names every step a preset switch cleared, in one line', () => {
    expect(switchSaid('heavy', [])).toBe('This card follows Heavy now.');
    expect(switchSaid('heavy', ['QA'])).toBe('This card follows Heavy now. It dropped its own choice for QA.');
    expect(switchSaid('light', ['Plan', 'Implement', 'QA'])).toBe('This card follows Light now. It dropped its own choice for Plan, Implement and QA.');
  });
});
