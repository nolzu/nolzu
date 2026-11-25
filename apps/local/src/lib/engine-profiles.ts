import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { CONFIG_DIR_VAR, ENGINE_LABELS, ENGINE_NAMES, type EngineName, type EngineProfile, isEngineName, phaseLabel, profileId } from '@nolzu/protocol';
import { ACTIONS, refusedPhases, type WallState } from '@nolzu/core';
import { getSetting } from '@nolzu/core/node';
import {
  checkLogin,
  detectEngines,
  ENGINE_INSTALLS,
  engineEnv,
  type EngineStatus,
  findExecutable,
  type LoginAnswer,
  loginShellPath,
  runVersion,
  signInCommand,
  STATUS_WAIT_MS,
  statusCommand,
  wallHere,
  wallKind,
} from '@nolzu/runner';
import { keepLimitsOf, type LimitBlock, limitBlock } from './engine-limits.ts';
import { homePath } from './home-path.ts';
import { storeSetting } from './settings-page.ts';
import { signInLine } from './sign-in.ts';

export interface ProfileRow extends EngineProfile {
  vendorLabel: string;
  // Where this profile's login lives, and which variable Nolzu sets to point the vendor at it.
  where: string;
  // What this profile's engine last said about its usage windows.
  limit: LimitBlock;
  // What this vendor's free plan can do here, or null for a vendor with nothing to say.
  plan: string | null;
  // The config folder with the home folder as ~, or null for the vendor's own default place.
  folder: string | null;
  // The variable Nolzu sets to the folder.
  variable: string;
  // The command Check login runs, or null for a vendor with no status command.
  status: string | null;
  // The line that signs this profile's folder in, shown when a check finds it signed out.
  signIn: string | null;
}

export interface VendorChoice {
  vendor: EngineName;
  label: string;
  // What the add form says under the folder field for this vendor.
  hint: string;
  // The variable and the bare sign-in command, which the add form turns into a line as the folder
  // is typed. The command is null where the vendor has none.
  variable: string;
  login: string | null;
}

export interface ProfilesSection {
  rows: ProfileRow[];
  // The vendors another profile can still be added for.
  vendors: VendorChoice[];
}

const label = (vendor: EngineName): string => ENGINE_LABELS[vendor];

/**
 * What a free plan of this vendor can do here, or null for a vendor with nothing to say.
 *
 * Only Cursor has any. Its free plan runs the Auto model and nothing else, and Nolzu always asks
 * for a model by name, because Auto lets the vendor change the model inside a run and the card
 * would then name a model the run did not use. So a free login cannot run a card.
 *
 * Nothing detects the plan. No command reports it, and the only sign of it is a run that fails, so
 * the row says the sentence to everybody: it is true whatever the person's plan is, and a guess
 * would be wrong for one of the two.
 *
 * The last sentence is the one `cursorFailure` gives a card that has already failed this way, so
 * the screen before the run and the card after it name the same two ways out.
 */
export function planNote(vendor: EngineName): string | null {
  if (vendor !== 'cursor') return null;
  return `A free ${label('cursor')} plan runs the Auto model and nothing else. Nolzu always asks for a model by name and never for Auto, so a card cannot run on a free login. Upgrade the plan, or run those cards on another engine.`;
}

// Said the same way in the row and in the add form, so the screen cannot describe a folder one way
// before it is typed and another way after.
const folderLine = (vendor: EngineName, variable: string, where: string): string =>
  `Nolzu sets ${variable} to ${where} on every run of this profile. Run the login of ${label(vendor)} there once, with the same variable set. Nolzu never opens the folder.`;

function whereLine(profile: EngineProfile): string {
  const variable = CONFIG_DIR_VAR[profile.vendor];
  if (profile.configDir === null) return `Nolzu sets no ${variable} for this profile, so ${label(profile.vendor)} reads the default place it uses on its own.`;
  return folderLine(profile.vendor, variable, profile.configDir);
}

export function vendorChoice(vendor: EngineName, profiles: readonly EngineProfile[]): VendorChoice {
  const variable = CONFIG_DIR_VAR[vendor];
  // An empty folder means the vendor's default place, and one profile already holds it. Offering it
  // again would be a field the person fills in and a save that comes back refused.
  const taken = profiles.some((one) => one.vendor === vendor && one.configDir === null);
  const empty = taken
    ? `The default place ${label(vendor)} uses on its own is taken by another profile, so this one needs a folder.`
    : `Leave it empty for the default place ${label(vendor)} uses on its own.`;
  return {
    vendor,
    label: label(vendor),
    hint: `${folderLine(vendor, variable, 'this folder')} ${empty}`,
    variable,
    login: signInCommand(vendor),
  };
}

export function profilesFor(db: DatabaseSync, home: string = homedir()): ProfilesSection {
  const profiles = getSetting(db, 'engineProfiles');
  const limits = getSetting(db, 'engineLimits');
  // Every vendor separates its logins by folder, so another profile can be added for each.
  const vendors = ENGINE_NAMES.map((vendor) => vendorChoice(vendor, profiles));
  const rows = profiles.map((profile) => ({
    ...profile,
    vendorLabel: label(profile.vendor),
    where: whereLine(profile),
    limit: limitBlock(profile.vendor, limits[profile.id]),
    plan: planNote(profile.vendor),
    folder: profile.configDir === null ? null : homePath(profile.configDir, home),
    variable: CONFIG_DIR_VAR[profile.vendor],
    status: statusCommand(profile.vendor),
    signIn: signInOf(profile),
  }));
  return { rows, vendors };
}

function signInOf(profile: EngineProfile): string | null {
  const login = signInCommand(profile.vendor);
  return login === null ? null : signInLine(login, CONFIG_DIR_VAR[profile.vendor], profile.configDir ?? '');
}

// The environment the engines run with: the login shell's PATH, read once.
const shellEnv = (): Record<string, string | undefined> => ({ ...process.env, PATH: loginShellPath(process.env) });

export interface ToolRow extends EngineStatus {
  label: string;
  // Where the binary is, with the home folder as ~. Null when it is not found.
  path: string | null;
  // The install line with Copy, or null where the vendor's page installs with its own script.
  command: string | null;
  // Which phases this machine can run on the engine, and why (`phasesLine`). Null where the wall
  // starts, since every engine then runs every phase. Optional for a row drawn in a test without it.
  phases?: string | null;
}

// "QA, Wrap-up and Optimize".
const listed = (words: readonly string[]): string => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

const wallName = (platform: NodeJS.Platform): string => (platform === 'darwin' ? 'macOS sandbox-exec' : 'bubblewrap');

/**
 * Which phases this machine can run on one engine, and why, for Settings, Engines. The phases come
 * from `refusedPhases`, the rule the job builder refuses with, and the why from the wall that holds
 * the runs here. Null where the wall starts: then no engine has a phase refused, and the same sentence
 * on every row told nothing, so `wallLine` says it once for the section.
 */
export function phasesLine(vendor: EngineName, wall: WallState, platform: NodeJS.Platform): string | null {
  if (wall.ready) return null;
  const refused = refusedPhases(vendor, wall);
  const allowed = ACTIONS.filter((action) => !refused.includes(action));
  const scope = refused.length === 0 ? 'Every phase.' : allowed.length === 1 ? `${phaseLabel(allowed[0]!)} only.` : `Every phase but ${listed(refused.map(phaseLabel))}.`;
  if (wallKind(vendor, wall, platform) === 'codex') return `${scope} Runs are held by the Codex sandbox, because Nolzu's wall cannot start here, so secret files such as ~/.ssh and .env are not hidden from them. ${wall.reason}`;
  if (refused.length === 0) return `${scope} Nolzu's wall cannot start here, so secret files such as ~/.ssh and .env are not hidden from its runs. ${wall.reason}`;
  return `${scope} The read-only phases need Nolzu's wall, which cannot start here. ${wall.reason}`;
}

/**
 * The one line at the top of Settings, Engines that names the wall, or null where it cannot start,
 * because each tool row then says what that costs. `~/.ssh` and `.env` are in every wall: see
 * `HIDDEN_FOR_EVERY_RUN` and the `.env` rule in the runner.
 */
export const wallLine = (wall: WallState, platform: NodeJS.Platform): string | null =>
  wall.ready ? `Every run is walled by ${wallName(platform)}: secret files such as ~/.ssh and .env stay hidden.` : null;

/**
 * The tools on this machine, with version, place and install line, for the Engines section.
 *
 * Runs each binary's version flag, the look the section has always made when it opens and again on
 * Look again. It asks nothing about a login: that is Check login, on a click.
 */
export async function engineTools(
  env: Record<string, string | undefined> = shellEnv(),
  home: string = homedir(),
  wall: WallState = wallHere(),
  platform: NodeJS.Platform = process.platform,
): Promise<ToolRow[]> {
  const found = await detectEngines(runVersion(env));
  return found.map((one) => {
    const at = one.found ? findExecutable(one.binary, env.PATH ?? '') : null;
    const command = ENGINE_INSTALLS.find((install) => install.engine === one.engine)?.command ?? null;
    return { ...one, label: ENGINE_LABELS[one.engine], path: at === null ? null : homePath(at, home), command, phases: phasesLine(one.engine, wall, platform) };
  });
}

export interface LoginCheck extends LoginAnswer {
  id: string;
  // When the tool answered, for "checked 14:02". Kept nowhere: a reload shows no answer until the
  // next press, because a stored one would say signed in long after the login ran out.
  at: number;
}

export type LoginReply = { ok: true; check: LoginCheck } | { ok: false; message: string };

/**
 * Check login on one profile row: the tool's own status command, with the environment a run of that
 * profile gets, so the folder asked about is the one its runs use.
 *
 * Only the `login` action calls this. No page load and no timer does, because each press may start a
 * CLI that asks its vendor over the network.
 */
export async function checkProfileLogin(db: DatabaseSync, form: FormData, env: Record<string, string | undefined> = shellEnv(), now: () => number = Date.now): Promise<LoginReply> {
  const id = asked(form, 'id');
  const profile = getSetting(db, 'engineProfiles').find((one) => one.id === id);
  if (profile === undefined) return { ok: false, message: `There is no engine profile ${id} on this machine.` };
  if (statusCommand(profile.vendor) === null) return { ok: false, message: `${label(profile.vendor)} has no login command. It signs in inside its own app.` };
  let runEnv: Record<string, string>;
  try {
    runEnv = engineEnv(env, { readOnlyTaskDir: null, profile });
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  const answer = await checkLogin(profile.vendor, runVersion(runEnv, STATUS_WAIT_MS));
  return { ok: true, check: { id, ...answer, at: now() } };
}

export interface ProfileAnswer {
  ok: boolean;
  // Which of the three the person asked for, so the screen prints the line that belongs to it.
  did: string;
  // The id of the profile that was added, so the screen names it. Null for a rename and a removal.
  id: string | null;
  message: string | null;
}

const no = (did: string, message: string): ProfileAnswer => ({ ok: false, did, id: null, message });
const yes = (did: string, id: string | null = null): ProfileAnswer => ({ ok: true, did, id, message: null });

const asked = (form: FormData, name: string): string => (form.get(name)?.toString() ?? '').trim();

/**
 * Add, rename or remove one profile.
 *
 * The rules live in the settings module, so a list this refuses here is refused the same way when
 * a run resolves it. A rename writes the label alone: the id was made once and every stored choice
 * points at it. A removal is allowed even while a card points at the profile, because a person who
 * lost a login has to be able to clear it, and the card then says the profile has no login here.
 * A removed id is free again, so the same label makes the same id and a row that named it runs on
 * the new profile. The screen names the id an add made, because that is the only warning of it.
 */
export function saveProfile(db: DatabaseSync, form: FormData): ProfileAnswer {
  const did = asked(form, 'do');
  const profiles = getSetting(db, 'engineProfiles');
  const write = (next: readonly EngineProfile[], id: string | null = null): ProfileAnswer => {
    const refused = storeSetting(db, 'engineProfiles', next);
    if (refused !== null) return no(did, refused);
    // A removed profile's numbers go with it. The id is free again, so the next profile with that
    // label would otherwise open with the limit state of a login it never had.
    keepLimitsOf(db, next.map((one) => one.id));
    return yes(did, id);
  };

  if (did === 'add') {
    const vendor = asked(form, 'vendor');
    const name = asked(form, 'label');
    const configDir = asked(form, 'configDir');
    if (!isEngineName(vendor)) return no(did, `There is no engine ${vendor}. The engines are ${ENGINE_NAMES.join(', ')}.`);
    if (name === '') return no(did, 'The profile needs a label, so you can tell it apart from the others.');
    const id = profileId(name, vendor, profiles.map((one) => one.id));
    return write([...profiles, { id, label: name, vendor, configDir: configDir === '' ? null : configDir }], id);
  }

  const id = asked(form, 'id');
  if (did === 'rename' || did === 'remove') {
    if (!profiles.some((one) => one.id === id)) return no(did, `There is no engine profile ${id} on this machine.`);
  }

  if (did === 'rename') {
    const name = asked(form, 'label');
    if (name === '') return no(did, 'The profile needs a label, so you can tell it apart from the others.');
    return write(profiles.map((one) => (one.id === id ? { ...one, label: name } : one)));
  }

  if (did === 'remove') return write(profiles.filter((one) => one.id !== id));

  return no(did, `There is no ${did} to do to an engine profile. The screen adds, renames and removes one.`);
}
