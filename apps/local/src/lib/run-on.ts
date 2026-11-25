import type { DatabaseSync } from 'node:sqlite';
import { boardFor, goneText, isAction, type ModelsByVendor, resolveModels, type RunPlace, vendorRefusal, type WallState } from '@nolzu/core';
import { cardBase, cardModels, cardPreset, getSetting, projectOutsideGit, projectProfiles } from '@nolzu/core/node';
import { atLimit, type BoardKind, ENGINE_LABELS, type EngineProfile } from '@nolzu/protocol';
import { wallHere } from '@nolzu/runner';
// The type the component reads, so the two sides of this prop cannot drift apart.
import type { RunOnOffer } from '@nolzu/ui';
import { refuseProfile } from './project-models.ts';

// Why this phase cannot start on this profile, or null when it can. The order is what a person can
// do about it: a phase this vendor can never run first, because nothing repairs that, then the
// profile's own state, then the model the row would run.
function refusalFor(
  profile: EngineProfile,
  phase: string,
  profiles: readonly EngineProfile[],
  models: ModelsByVendor,
  resolve: (profile: string) => { model: string; gone: boolean },
  place: RunPlace,
): string | null {
  const refused = vendorRefusal(profile.vendor, phase, place);
  if (refused !== null) return refused;
  const noLogin = refuseProfile(profile.id, profiles, models);
  if (noLogin !== null) return noLogin;
  const row = resolve(profile.id);
  if (row.gone) {
    return `${goneText(row.model)} ${profile.label} does not offer it, so pick a model for that profile on the card's Settings tab first.`;
  }
  return null;
}

/**
 * The vendor whose usage limit stopped the card's last run of this phase, or null when it stopped on
 * something else. The run row keeps no reason, so the sign is the one the Engines screen shows: the
 * run failed, and the stored reading of its login has a full window. A run reads its windows before
 * it fails, and `saveLimit` keeps them under the login.
 *
 * Limit: a run that failed for another reason while an old full reading is still stored counts
 * as a limit stop too. That only holds back the same vendor's other logins, the safe side. A reason
 * column on the run row is the upgrade if it ever matters.
 */
function limitedVendor(db: DatabaseSync, key: string, phase: string, profiles: readonly EngineProfile[]): EngineProfile['vendor'] | null {
  const last = db.prepare('SELECT engine, state FROM runs WHERE card_key = ? AND phase = ? ORDER BY id DESC LIMIT 1').get(key, phase) as { engine: string; state: string } | undefined;
  if (last?.state !== 'failed') return null;
  const seen = getSetting(db, 'engineLimits')[last.engine];
  if (seen === undefined || !seen.windows.some(atLimit)) return null;
  return profiles.find((one) => one.id === last.engine)?.vendor ?? null;
}

/**
 * What "Run on" offers for one card, read from the card's stage and the stored logins.
 *
 * The profile Retry would use is left out: that button sits next to these and starts the same
 * phase on the same login. Nothing here starts anything, and nothing here reads a run's state, so
 * the card decides when to show it.
 *
 * Null with one login. Empty with a sentence when no other login can run the phase. Where the wall cannot start, every
 * read-only phase is refused on Cursor, so a card whose only other login is Cursor says why instead
 * of drawing a button that fails on the click. `wall` is the runner's probe, passed by a test.
 *
 * After a run that stopped on a usage limit, the other logins of that vendor are left out, and the
 * other vendors' logins are still offered. A second account of the same vendor at that moment reads
 * as a way around the vendor's limit, which its terms forbid. After any other stop, every login is
 * offered, even one the Engines screen shows at its limit: that reading is the last one seen and not
 * a live one.
 */
export function runOnOffer(db: DatabaseSync, key: string, models: ModelsByVendor, wall: WallState = wallHere()): RunOnOffer | null {
  const card = db.prepare('SELECT stage, board FROM cards WHERE key = ?').get(key) as { stage: string; board: BoardKind } | undefined;
  if (card === undefined) return null;
  const phase = boardFor(card.board, getSetting(db, 'deliveryFlow')).stages.find((stage) => stage.id === card.stage)?.phase;
  // A stage that starts no run has nothing to offer another profile.
  if (phase === undefined || !isAction(phase)) return null;

  const profiles = projectProfiles(db);
  const own = cardModels(db, key);
  const global = cardBase(db, key);
  const preset = cardPreset(db, key);
  const resolve = (onProfile: string) => resolveModels(own, global, preset, models, profiles, onProfile)[phase];
  // The login this phase runs on as the card stands, which is the one Retry starts again.
  const here = resolveModels(own, global, preset, models, profiles)[phase].engine;
  const others = profiles.filter((one) => one.id !== here);
  const limited = limitedVendor(db, key, phase, profiles);
  const left = others.filter((one) => one.vendor !== limited);
  const place: RunPlace = { outsideGit: projectOutsideGit(db), wall };
  const checked = left.map((one) => ({ profile: one, why: refusalFor(one, phase, profiles, models, resolve, place) }));
  const can = checked.filter((one) => one.why === null).map(({ profile }) => ({ id: profile.id, label: profile.label }));

  if (can.length > 0) return { profiles: can, note: null };
  // One login has nowhere else to run, and a line saying so on every failed card is noise.
  if (others.length === 0) return null;
  const held = limited !== null && left.length < others.length ? [`The run stopped on a ${ENGINE_LABELS[limited]} usage limit, so no other ${ENGINE_LABELS[limited]} login is offered.`] : [];
  return { profiles: [], note: [...held, ...checked.map((one) => one.why)].join(' ') };
}
