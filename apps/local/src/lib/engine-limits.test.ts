import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProfileLimit, RateLimitWindow } from '@nolzu/protocol';
import { boardVersion, getSetting, notifications, openDatabase, writeSetting } from '@nolzu/core/node';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EngineProfiles from './EngineProfiles.svelte';
import { limitBlock, saveLimit } from './engine-limits.ts';
import { profilesFor, saveProfile } from './engine-profiles.ts';

// One zone for every reading, so a machine in another one reads the same times here.
const ZONE = 'UTC';
// The windows of the run recorded in `docs/engines/claude-code.md`, in unix seconds.
const FIVE_HOUR = Date.UTC(2026, 8, 25, 19, 0) / 1000;
const SEVEN_DAY = Date.UTC(2026, 8, 29, 9, 0) / 1000;
const SEEN = Date.UTC(2026, 8, 25, 17, 12);

const seen = (windows: readonly RateLimitWindow[], at = SEEN): ProfileLimit => ({ seenAt: at, windows });
const window = (one: Partial<RateLimitWindow>): RateLimitWindow => ({ name: 'five_hour', used: null, resetsAt: null, status: null, ...one });

describe('what each engine can say about a usage window', () => {
  // One test per engine and not one over a list, so an engine added later has to be answered for
  // here rather than inheriting whatever the list did.
  it('reads the windows Claude Code reports, and says unknown until a run reports one', () => {
    const block = limitBlock('claude-code', undefined, ZONE);

    expect(block.state).toBe('unknown');
    expect(block.note).toContain('subscription login');
  });

  it('says not available for Cursor, which reports no usage window at all', () => {
    const block = limitBlock('cursor', undefined, ZONE);

    expect(block.state).toBe('unavailable');
    expect(block.headline).toBe('Not available for this engine.');
    expect(block.note).toContain('normal state and not a gap');
  });

  it('says unknown for Codex, where no run here has hit a usage limit', () => {
    const block = limitBlock('codex', undefined, ZONE);

    expect(block.state).toBe('unknown');
    expect(block.note).toContain('no Codex usage limit has been seen yet');
  });
});

describe('the block built from what a run reported', () => {
  it('shows the share of each window with the time it was seen', () => {
    const block = limitBlock(
      'claude-code',
      seen([window({ name: 'five_hour', used: 0.62, resetsAt: FIVE_HOUR, status: 'allowed' }), window({ name: 'seven_day', used: 0.41, resetsAt: SEVEN_DAY })]),
      ZONE,
    );

    expect(block.state).toBe('share');
    expect(block.headline).toBe('Seen 25 Sept 2026, 17:12.');
    expect(block.windows).toEqual(['5-hour window: 62% used, resets 25 Sept 2026, 19:00', 'weekly window: 41% used, resets 29 Sept 2026, 09:00']);
    expect(block.note).toContain('the last one seen');
  });

  // The Engines screen draws a bar under each line, so the share travels as a number beside it.
  it('gives the percent of each window for its bar, and none where the engine gave no share', () => {
    const block = limitBlock('claude-code', seen([window({ name: 'five_hour', used: 0.62 }), window({ name: 'seven_day', used: null })]), ZONE);

    expect(block.shares).toEqual([62, null]);
    expect(limitBlock('cursor', undefined, ZONE).shares).toEqual([]);
  });

  it('says at its limit until the reset time when the engine refused the window', () => {
    const block = limitBlock('claude-code', seen([window({ used: 1.4, resetsAt: FIVE_HOUR, status: 'rejected' })]), ZONE);

    expect(block.state).toBe('until');
    expect(block.headline).toBe('At its limit until 25 Sept 2026, 19:00. Seen 25 Sept 2026, 17:12.');
    // Over the window, so the share is above 100 and is kept as the engine gave it.
    expect(block.windows).toEqual(['5-hour window: 140% used, resets 25 Sept 2026, 19:00']);
  });

  it('says at its limit with no reset time when the engine gave none', () => {
    const block = limitBlock('claude-code', seen([window({ used: null, resetsAt: null, status: 'rejected' })]), ZONE);

    expect(block.state).toBe('open');
    expect(block.headline).toContain('reported no reset time');
    expect(block.windows).toEqual(['5-hour window: share not reported, no reset time reported']);
  });

  it('waits for the window that frees up last when both are full', () => {
    const block = limitBlock(
      'claude-code',
      seen([window({ name: 'five_hour', used: 1, resetsAt: FIVE_HOUR }), window({ name: 'seven_day', used: 1, resetsAt: SEVEN_DAY })]),
      ZONE,
    );

    expect(block.headline).toContain('until 29 Sept 2026, 09:00');
  });

  // Half a reset time is no reset time: a person told to wait until the earlier one would start a
  // run that is refused again.
  it('gives no reset time when one full window has none', () => {
    const block = limitBlock(
      'claude-code',
      seen([window({ name: 'five_hour', used: 1, resetsAt: FIVE_HOUR }), window({ name: 'seven_day', used: 1, resetsAt: null })]),
      ZONE,
    );

    expect(block.state).toBe('open');
  });

  // A window at 100% is the limit. One at 99% is not, and a share the engine left out is not read
  // as full either, or a quiet engine would block a profile that is fine.
  it('calls a window full at its whole share and not before', () => {
    expect(limitBlock('claude-code', seen([window({ used: 0.99, resetsAt: FIVE_HOUR })]), ZONE).state).toBe('share');
    expect(limitBlock('claude-code', seen([window({ used: 1, resetsAt: FIVE_HOUR })]), ZONE).state).toBe('until');
    expect(limitBlock('claude-code', seen([window({ used: null, resetsAt: FIVE_HOUR, status: 'allowed' })]), ZONE).state).toBe('share');
  });

  // A status word this version has not seen is not a refusal. A new word would otherwise put every
  // profile at its limit on the day the engine starts using it.
  it('reads a status word it does not know as no refusal', () => {
    const block = limitBlock('claude-code', seen([window({ used: 0.2, resetsAt: FIVE_HOUR, status: 'throttled' })]), ZONE);

    expect(block.state).toBe('share');
  });

  // A refusal can name a window this version has never seen. Dropping it would leave the block
  // saying the account is fine on the two windows it does know.
  it('shows a refused window under the name the engine gave it', () => {
    const block = limitBlock(
      'claude-code',
      seen([window({ name: 'five_hour', used: 0.14, resetsAt: FIVE_HOUR, status: 'allowed' }), window({ name: 'opus_seven_day', resetsAt: SEVEN_DAY, status: 'rejected' })]),
      ZONE,
    );

    expect(block.state).toBe('until');
    expect(block.windows[1]).toBe('opus_seven_day: share not reported, resets 29 Sept 2026, 09:00');
  });

  it('says unknown when a reading carries no window', () => {
    expect(limitBlock('claude-code', seen([]), ZONE).state).toBe('unknown');
  });
});

describe('the time the numbers were seen', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The block says what was seen and when. Reading the clock instead would move the "seen" line
  // every time the page is opened, and the number next to it would not move with it.
  it('comes from the reading and not from the clock', () => {
    const reading = seen([window({ used: 0.62, resetsAt: FIVE_HOUR, status: 'allowed' })]);
    vi.useFakeTimers();

    vi.setSystemTime(new Date(SEEN + 60_000));
    const soon = limitBlock('claude-code', reading, ZONE);
    vi.setSystemTime(new Date(SEEN + 40 * 24 * 3600 * 1000));
    const later = limitBlock('claude-code', reading, ZONE);

    expect(soon).toEqual(later);
    expect(later.headline).toBe('Seen 25 Sept 2026, 17:12.');
  });
});

describe('the store on this machine', () => {
  let dir = '';
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nolzu-engine-limits-'));
    db = openDatabase(dir);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const shown = () => text(render(EngineProfiles, { props: { profiles: profilesFor(db) } }).body);
  const post = (body: Record<string, string>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(body)) form.set(name, value);
    return saveProfile(db, form);
  };

  it('keeps the last reading of a profile and hands it to the screen', () => {
    saveLimit(db, 'claude-code', [window({ used: 0.2, resetsAt: FIVE_HOUR, status: 'allowed' })], SEEN);
    saveLimit(db, 'claude-code', [window({ used: 0.62, resetsAt: FIVE_HOUR, status: 'allowed' })], SEEN + 3600_000);

    // The time is written in the zone of the machine that reads it, so only the share is named here.
    expect(profilesFor(db).rows[0]?.limit.windows[0]).toMatch(/^5-hour window: 62% used, resets /);
  });

  // The near-limit toast says which card's run saw the numbers. A run with no card names none.
  it('keeps the card whose run read the line, and none for a run with no card', () => {
    saveLimit(db, 'claude-code', [window({ used: 0.92, resetsAt: FIVE_HOUR })], SEEN, 'APP-16');
    expect(getSetting(db, 'engineLimits')['claude-code']).toEqual({ seenAt: SEEN, windows: [window({ used: 0.92, resetsAt: FIVE_HOUR })], card: 'APP-16' });

    saveLimit(db, 'claude-code', [window({ used: 0.95, resetsAt: FIVE_HOUR })], SEEN + 60_000);
    expect(getSetting(db, 'engineLimits')['claude-code']).not.toHaveProperty('card');
  });

  // The bell keeps the warning the toast raises, once per window and reset time, with the card.
  it('keeps one near-limit notification per window crossing 90%', () => {
    saveLimit(db, 'claude-code', [window({ used: 0.5, resetsAt: FIVE_HOUR })], SEEN);
    saveLimit(db, 'claude-code', [window({ used: 0.92, resetsAt: FIVE_HOUR })], SEEN, 'APP-16');
    saveLimit(db, 'claude-code', [window({ used: 0.95, resetsAt: FIVE_HOUR })], SEEN + 60_000);

    const kept = notifications(db);
    expect(kept.map((one) => [one.kind, one.card, one.href])).toEqual([['warning', 'APP-16', '/settings/engines']]);
    expect(kept[0]?.text).toMatch(/^Claude Code, 5-hour window: 92% used, resets /);
  });

  // A reading of a window that has already reset says nothing about the window now.
  it('keeps nothing for a window whose reset time has passed', () => {
    saveLimit(db, 'claude-code', [window({ used: 0.95, resetsAt: SEEN / 1000 - 60 })], SEEN);
    expect(notifications(db)).toEqual([]);
  });

  // With no reset time to tell one window from the next, each crossing of 90% is its own item.
  it('keeps a window with no reset time at each crossing and not at each reading', () => {
    saveLimit(db, 'claude-code', [window({ used: 0.92, resetsAt: null })], SEEN);
    saveLimit(db, 'claude-code', [window({ used: 0.95, resetsAt: null })], SEEN + 60_000);
    saveLimit(db, 'claude-code', [window({ used: 0.1, resetsAt: null })], SEEN + 120_000);
    saveLimit(db, 'claude-code', [window({ used: 0.91, resetsAt: null })], SEEN + 180_000);

    expect(notifications(db).map((one) => one.text)).toEqual(['Claude Code, 5-hour window: 91% used, no reset time reported', 'Claude Code, 5-hour window: 92% used, no reset time reported']);
  });

  // The id of a removed profile is free again, so the same label makes the same id. Without this
  // the new login would open showing the share of the one that is gone.
  it('drops the reading of a profile that is removed', () => {
    post({ do: 'add', vendor: 'codex', label: 'Work', configDir: '/tmp/nolzu-engine-limits-codex' });
    saveLimit(db, 'codex#work', [window({ used: 0.5, resetsAt: FIVE_HOUR })], SEEN);

    post({ do: 'remove', id: 'codex#work' });

    expect(getSetting(db, 'engineLimits')).toEqual({});
  });

  it('keeps the reading of every profile that stays', () => {
    post({ do: 'add', vendor: 'codex', label: 'Work', configDir: '/tmp/nolzu-engine-limits-codex' });
    saveLimit(db, 'claude-code', [window({ used: 0.5, resetsAt: FIVE_HOUR })], SEEN);

    post({ do: 'remove', id: 'codex#work' });

    expect(Object.keys(getSetting(db, 'engineLimits'))).toEqual(['claude-code']);
  });

  // A hand edited database must not draw a share of NaN on the screen.
  it('falls back to no reading at all when the stored state is not one', () => {
    const broken = { 'claude-code': { seenAt: 'yesterday', windows: [{ name: 'five_hour', used: 'lots', resetsAt: null, status: null }] } };
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('engineLimits', JSON.stringify(broken));

    expect(profilesFor(db).rows[0]?.limit.state).toBe('unknown');
    expect(shown()).not.toContain('NaN');
  });

  // One reading is one moment. The newest replaces the last one whole, window and all, so every
  // number in the block was seen at the time above it. A window the newest reading leaves out is
  // gone from the block, which is the price of that.
  it('replaces the whole reading, and does not keep a window the newest one left out', () => {
    saveLimit(db, 'claude-code', [window({ name: 'five_hour', used: 0.6, resetsAt: FIVE_HOUR, status: 'allowed' }), window({ name: 'seven_day', used: 0.4, resetsAt: SEVEN_DAY })], SEEN);

    saveLimit(db, 'claude-code', [window({ name: 'seven_day', resetsAt: SEVEN_DAY, status: 'rejected' })], SEEN + 60_000);

    expect(getSetting(db, 'engineLimits')['claude-code']?.windows.map((one) => one.name)).toEqual(['seven_day']);
  });

  // Every setting write makes each open board fetch its snapshot again, and a run can report the
  // same numbers many times.
  it('writes nothing when a run reports the numbers it already stored', () => {
    const windows = [window({ used: 0.6, resetsAt: FIVE_HOUR, status: 'allowed' })];
    saveLimit(db, 'claude-code', windows, SEEN);
    const version = boardVersion(db);

    saveLimit(db, 'claude-code', windows, SEEN + 60_000);

    expect(boardVersion(db)).toBe(version);
    expect(getSetting(db, 'engineLimits')['claude-code']?.seenAt).toBe(SEEN);
  });

  describe('the block on the Engines screen', () => {
    it('shows the share and the reset time of each window', () => {
      saveLimit(db, 'claude-code', [window({ name: 'five_hour', used: 0.62, resetsAt: FIVE_HOUR, status: 'allowed' }), window({ name: 'seven_day', used: 0.41, resetsAt: SEVEN_DAY })], SEEN);

      expect(shown()).toContain('5-hour window: 62% used');
      expect(shown()).toContain('weekly window: 41% used');
      expect(shown()).toContain('covers the whole account');
    });

    // No limit has been hit on any login here, so this state and the one below it are drawn from
    // the documented fields alone. A person meets them the first time a run is refused.
    it('shows a profile at its limit until a time', () => {
      saveLimit(db, 'claude-code', [window({ used: 1.2, resetsAt: FIVE_HOUR, status: 'rejected' })], SEEN);

      expect(shown()).toContain('At its limit until');
      expect(render(EngineProfiles, { props: { profiles: profilesFor(db) } }).body).toContain('data-limit="until"');
    });

    it('shows a profile at its limit with no reset time', () => {
      saveLimit(db, 'claude-code', [window({ status: 'rejected' })], SEEN);

      expect(shown()).toContain('The engine reported no reset time');
      expect(render(EngineProfiles, { props: { profiles: profilesFor(db) } }).body).toContain('data-limit="open"');
    });

    it('shows unknown for a profile no run has reported a window for', () => {
      expect(shown()).toContain('No usage window has been seen for this profile');
      expect(render(EngineProfiles, { props: { profiles: profilesFor(db) } }).body).toContain('data-limit="unknown"');
    });

    it('shows not available for a Cursor profile', () => {
      writeSetting(db, 'engineProfiles', [{ id: 'cursor', label: 'Cursor', vendor: 'cursor', configDir: null }]);

      expect(shown()).toContain('Not available for this engine.');
      expect(render(EngineProfiles, { props: { profiles: profilesFor(db) } }).body).toContain('data-limit="unavailable"');
    });
  });
});
