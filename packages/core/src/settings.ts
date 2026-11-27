import { type AccountProject, BOARD_LABELS, type BoardKind, DEFAULT_PROFILE, type DeliveryFlow, type EngineName, type EngineProfile, isBoardKind, isEngineName, isResearchKind, isProfileId, type ProfileLimit, readProjectList, SETUP_MARKS, SETUP_STEPS, type SetupMarks, type WallLists } from '@nolzu/protocol';
import { type ModelTable, PRESET_NAMES, presetNameProblem, type PresetName, renamedActions, type SavedPreset, validateModelTable } from './models.ts';
import { allowedCommandProblem } from './allowed-commands.ts';
import { appAddress, type Progress, START, validateProgress } from './onboarding.ts';
import { siteOrigin } from './jira-site.ts';

// The presets live with the rest of the model rules; they are named here too for the callers that
// read them with the settings.
export { presetRows, type PhaseModel, type PresetName, type PresetRows } from './models.ts';

export interface Settings {
  agentSlots: number;
  // Idle time since the last stream line, not wall clock. An implement run can honestly take
  // an hour while printing all the way through.
  runTimeoutMs: number;
  // How long a run may print nothing before its card reads Quiet. It only changes what the board
  // shows: nothing stops the run, and the run timeout above stays the one that ends it.
  quietAfterMs: number;
  retryWaitsMs: readonly number[];
  keepAwake: boolean;
  modelPreset: PresetName;
  // The project's own model, effort and engine per action, over the preset. Empty until the Models
  // screen edits it, so every action follows the preset.
  models: ModelTable;
  // The action tables the person saved under a name. Each holds a row per action, so applying one
  // is one write of the table above and the rows come back as they were saved, whatever the
  // built-in preset says by then. Empty until somebody saves one.
  savedPresets: readonly SavedPreset[];
  // The engine a built-in preset runs on, by vendor: its first login takes every row with no engine of
  // its own. Null keeps the first stored profile, which is how a project read before the choice.
  presetEngine: EngineName | null;
  // The saved preset the project chose, by name, or null while a built-in one is in use. Settings,
  // Models and a card's Settings tab read it: what runs is the table above.
  savedPreset: string | null;
  // True once Settings, Models wrote anything. Until then a project from before `savedPreset` opens on
  // the saved preset its table matches; after it, a null `savedPreset` is a built-in one picked.
  presetChosen: boolean;
  // The phases a person changed on a built-in preset, per preset and engine ("heavy:cursor"), each a
  // whole row: engine, model and the effort where the id does not carry it. Kept as their choice, so
  // a new built-in list in a later Nolzu never rewrites it. While a built-in preset is in use, its
  // entry is what `models` holds. Null until Settings, Models writes after this key came in, and the
  // first write then takes the rows `models` holds as the person's own.
  presetChoices: Readonly<Record<string, ModelTable>> | null;
  // The logins of the vendor CLIs this machine holds. One per login, not one per vendor: a work
  // account and a personal account are two profiles of the same vendor. The first one is what an
  // action with no engine of its own inherits, unless the project's `presetEngine` puts another
  // vendor's main login first (`projectProfiles`), and its vendor is the CLI a run spawns. A row that
  // names a profile runs on that profile's vendor.
  engineProfiles: readonly EngineProfile[];
  // What each profile's CLI last said about its usage windows, by profile id. It stays on this
  // machine: limit state stays off the wire in every tier. Empty until a run reports
  // one, and a profile with no entry reads "unknown" on the Engines screen.
  engineLimits: Readonly<Record<string, ProfileLimit>>;
  deliveryFlow: DeliveryFlow;
  baseBranch: string;
  // The git repositories the project holds, by folder: "." for the project folder itself, or one
  // folder name inside it. Null is one repository at ".", so a project saved before this list
  // existed reads the same as before. A null base means the base branch setting above.
  repos: readonly ProjectRepo[] | null;
  // True when the project folder is a workspace: a folder that holds the repositories and is a git
  // repository of its own for the Nolzu files, but never one a card changes. So its list may be
  // empty and never holds ".". Null is an ordinary project, and every rule above holds as before.
  workspace: true | null;
  branchTemplate: string;
  // The boards this project has turned off, which leave the rail until they are on again. The off
  // ones and not the on ones, so a board a later version adds is on for everybody. Delivery is never
  // in it. Turning a board off changes none of its cards.
  offBoards: readonly BoardKind[];
  // The boards where a person allowed a chain in advance, from the suggestion card on Now. Empty by
  // default, so nothing chains until a person turns it on. Only Delivery
  // has a chain to allow (`SMALL_CHAINS`).
  chainBoards: readonly BoardKind[];
  // The newest card move when a person pressed Not now on the chain suggestion, as its card_events
  // id. Zero until then. The suggestion counts only plans decided after it.
  chainNotNow: number;
  // Local or Jira. With Jira, Add card reads a typed key or a pasted Jira link from the site below,
  // with the token from the keychain. A GitHub ref is read from the shape of what a person typed and
  // not from this setting. Linear and GitHub Issues are no system here: Linear has no reader with a
  // keychain token yet, and GitHub rides on the shape of the ref.
  ticketSystem: TicketSystem;
  // The Jira site and the account the token belongs to. Not secrets, so they are settings. The token
  // is in the keychain under `JIRA_TOKEN_NAME`. Machine keys, because the token is the machine's too:
  // Settings, Integrations connects Jira once and every project picks whether it reads it. Kept when a
  // project goes back to local, so switching back to Jira is one press. The worklog export has its own
  // three and never reads these.
  jiraSite: string | null;
  jiraEmail: string | null;
  // What Jira said the last time it was asked whether a project has the local key prefix as its key:
  // the prefix and the site asked, and a prefix no Jira project uses. Null when none had it.
  // Stored, because Jira is asked only on a save or a connect, never on a page load.
  jiraKeyClash: { prefix: string; site: string; suggestion: string | null } | null;
  // The key prefix of local tickets, for both systems: a card typed as text and a Scout finding from a
  // log are local tickets on a Jira project too. A key with this prefix reads as local.
  localKeyPrefix: string;
  // The MCP config file that gives a QA run a browser, or null for QA without one. It is a path on
  // this machine, so it is a setting and never a hard-coded name: another person keeps their config
  // somewhere else. Only the QA phase is handed it, and `policyFor` in the runner is where that
  // rule lives.
  qaMcpConfigPath: string | null;
  // How QA gets the app it checks, per repository, answered when the first card that changed the
  // repository enters QA, or under Start the app on Settings, Project. Null until any answer. The
  // project-wide stack hook of earlier versions became an `own` answer under `*` (`migrations.ts`).
  qaApp: QaApps | null;
  // The shell commands the agent may run, one `Bash(<command>)` entry each for Claude Code. Null
  // until the list is filled from the project's stack the first time; an empty list is the person's
  // own answer and is never filled again. Both allow no command.
  allowedCommands: readonly string[] | null;
  // What this project adds to the fixed wall rules: more hidden paths, `.env` exceptions, and
  // writable cache folders for Implement and QA. Only the shape is checked here, because the path
  // rules need the disk; `wallEntryProblem` in the runner checks each entry on save and at spawn.
  wallLists: WallLists;
  // Where this project's knowledge lives. Null until the person picks one, and
  // `resolveKnowledgeDir` then answers `.nolzu/knowledge` in the project. Nothing writes this
  // setting yet. The field that arrives with it leaves the setting null when the person keeps the
  // default folder, because a stored path would stop following a project that moves.
  // `checkKnowledgeDir` in the runner holds the rules for a path a person typed.
  knowledgeDir: string | null;
  // Off by default: a wrap-up's knowledge is committed as it is written. On, the change is held
  // aside and one `pending` row per file waits for the person to approve or return it.
  reviewKnowledge: boolean;
  projectPath: string | null;
  // Where the project's `.git` led when Nolzu first opened the project: the plain folder itself, or
  // where a link or a file that names a git folder elsewhere leads. Nolzu's git writes there and
  // refuses when it later leads anywhere else. Null until the project has a `.git`.
  gitLink: string | null;
  // The top folder of the repository the knowledge folder is in, recorded when the knowledge folder
  // is set or first used. A later answer from git that names another repository is refused.
  knowledgeRepo: string | null;
  // Who the project is for, typed on Evidence beside the timesheet. Null until somebody types it. It
  // is a label and nothing reads it as an id.
  clientName: string | null;
  // What an hour of work on this project is billed at, in the currency below. Null until somebody
  // types it, because a rate guessed for a person would put a wrong number in every margin line.
  hourlyRate: number | null;
  // The currency the rate is in, as a three-letter code. Engines report cost in US dollars, so
  // that is the default and a person who bills in another currency changes it.
  currency: string;
  // Whether Evidence asked "Bill this project?". The first visit asks and sets it, so the prompt shows
  // once; the three fields stay at #billing for a later answer.
  billingAsked: boolean;
  // The project this machine is registered as on Nolzu cloud, or null while it is registered
  // nowhere. The hub mints no id: the machine keeps one and every row the hub stores for the project
  // carries it. A settings frame that names no project cannot be sent, so a null here is what stops
  // one.
  projectId: string | null;
  // The team project this machine works on, or null on a personal project. The id above is minted
  // here and names this machine's own project; this one is minted by the team hub and names a project
  // a team shares, so the two sit beside each other and neither replaces the other. A machine holding
  // one dials the team hub as well as its own.
  teamProjectId: string | null;
  // The project id inside every timesheet entry this machine exports, minted at the first export. Its
  // own key and not `projectId`, because that one says the machine is registered with the hub, and an
  // export registers nothing.
  exportProjectId: string | null;
  // The highest hub job id this machine has finished. The hub keeps a job until the runner acks it, so
  // a crash between the two sends the job again on the next connect, and this is what makes the second
  // delivery safe: a job at or below the mark is dropped and acked. Zero until the first job runs.
  hubJobDone: number;
  // The same mark for the team hub, and its own key rather than a share of the one above. A job id
  // counts from 1 inside each hub, so a machine that has finished 57 jobs on one hub would drop the
  // other hub's first 57 without running them and ack every one.
  teamHubJobDone: number;
  // Every project of the account, as the personal hub last listed them on a `project.list` job, or null
  // while no hub has answered. A free machine has no hub socket, so it stays null there.
  accountProjects: readonly AccountProject[] | null;
  // True after the person deleted their cloud data: the hub link dials nothing and sends nothing until
  // they turn sync back on in Settings, Cloud.
  syncPaused: boolean;
  // Whether New project was finished, so a first run lands on it until then.
  onboarding: Progress;
  // The coach notes the person closed, by name, so each one shows once. A machine key, as `onboarding`
  // is: a note closed once stays closed in every project.
  seenNotes: readonly string[];
  // The steps of Getting started that leave no row of their own: a plain summary read and the first
  // push. The first card and the first drag are read off their own rows. Null on a project New project
  // did not make, which shows no list; New project starts it empty. A machine key, as `seenNotes` is.
  gettingStarted: readonly GettingStartedStep[] | null;
  // The project the person opened last, by its id in the machine's project registry. Null is the first
  // project. A route works on this one unless it names another, and on Free it is the one open project.
  currentProject: number | null;
  // The first seen stamp of the newest finding the person has seen on the Scout page. A finding first
  // seen after it is new, which is what the rail's dot on Scout and Now's Scout count say. Null until
  // Scout is opened once, so every finding is new then.
  scoutSeen: string | null;
  // When Read pull requests last finished on the PR reviews board, for the "read 12m ago" beside its
  // button. Null until the first read.
  pullsReadAt: string | null;
  // True once Read pull requests finished taking only the pull requests that ask for the person's
  // review. Until then a read also removes the untouched cards an older read added for every one.
  pullsAskOnly: boolean;
  // What the person did with each step of Set up the project: done, "I will write it myself" or
  // put away. A step with no mark is read off the project's own rows, such as its knowledge files. Null
  // on a project made before the steps, which shows the steps but never holds a run back; New project
  // starts it empty.
  setupSteps: SetupMarks | null;
  // The moves "Learn and then start" holds until no Learn your repositories run is left in the queue:
  // the card, the column it goes to and when the person pressed. Kept here so a restart still makes
  // the move.
  afterLearn: AfterLearn[];
  // The version of the terms the person accepted on the first start, and when. Null until then. When
  // Nolzu starts with it null or older than the app's version, no run starts until the person accepts.
  // A machine key: one person, one machine.
  termsAccepted: TermsAccepted | null;
}

export interface TermsAccepted {
  version: string;
  at: string;
}

export interface AfterLearn {
  key: string;
  to: string;
  at: string;
}

/**
 * How QA gets the app, as the question at the first QA stores it.
 *
 * `dev` starts the project's own start command in the card's copy of one repository, on a free port,
 * and stops it after the run. `running` checks against an app the person started at that address and
 * leaves it alone. `code` loads no app: QA reads the change and runs the tests.
 *
 * `own` runs the person's own commands outside the wall, because they may start Docker: `start` before the
 * run, `stop` after it, and `status` for the card page. `{key}` in each becomes the card key.
 *
 * `folder` is a folder one level down in the repository, when the repository's own package.json names no
 * start script and that folder's does. The scripts hash, the install and the start all happen there.
 *
 * `scripts` is the sha256 of the package.json `scripts` block the person saw when they said yes. A run
 * on the card's branch can change what `npm run dev` does, so QA asks again when it no longer matches.
 */
export type QaApp =
  | { mode: 'dev'; command: string; repo: string; folder?: string; scripts?: string }
  | { mode: 'running'; address: string }
  | { mode: 'code' }
  | { mode: 'own'; start: string; stop: string | null; status: string | null };

/**
 * The answers by repository path. `*` holds an answer for every repository: the one answer a project
 * gave before answers were per repository, when it named no repository (`running` or `code`).
 */
export type QaApps = Readonly<Record<string, QaApp>>;
export const EVERY_REPO = '*';

export const TICKET_SYSTEMS = ['local', 'jira'] as const;
export type TicketSystem = (typeof TICKET_SYSTEMS)[number];

export const GETTING_STARTED_STEPS = ['summary', 'push'] as const;
export type GettingStartedStep = (typeof GETTING_STARTED_STEPS)[number];

export interface ProjectRepo {
  path: string;
  base: string | null;
}

export type SettingKey = keyof Settings;

// The branch template New project stores, such as feature/APP-1/search-box.
export const NEW_PROJECT_BRANCH_TEMPLATE = '{type}/{key}/{desc}';

export const DEFAULTS: Settings = {
  agentSlots: 3,
  runTimeoutMs: 30 * 60 * 1000,
  quietAfterMs: 5 * 60 * 1000,
  retryWaitsMs: [2 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000],
  keepAwake: true,
  modelPreset: 'default',
  models: {},
  savedPresets: [],
  presetEngine: null,
  savedPreset: null,
  presetChosen: false,
  presetChoices: null,
  engineProfiles: [DEFAULT_PROFILE],
  engineLimits: {},
  deliveryFlow: 'pull-request',
  baseBranch: 'main',
  repos: null,
  workspace: null,
  // A project that stored no template takes the Gitflow names too. A card already started keeps the
  // branch its checkout is on, so only cards not started yet get the new names.
  branchTemplate: NEW_PROJECT_BRANCH_TEMPLATE,
  offBoards: [],
  chainBoards: [],
  chainNotNow: 0,
  ticketSystem: 'local',
  jiraSite: null,
  jiraEmail: null,
  jiraKeyClash: null,
  localKeyPrefix: 'APP',
  qaMcpConfigPath: null,
  qaApp: null,
  allowedCommands: null,
  wallLists: { hidden: [], exceptions: [], writable: [] },
  knowledgeDir: null,
  reviewKnowledge: false,
  projectPath: null,
  gitLink: null,
  knowledgeRepo: null,
  clientName: null,
  hourlyRate: null,
  currency: 'USD',
  billingAsked: false,
  projectId: null,
  teamProjectId: null,
  exportProjectId: null,
  hubJobDone: 0,
  teamHubJobDone: 0,
  accountProjects: null,
  syncPaused: false,
  onboarding: START,
  seenNotes: [],
  gettingStarted: null,
  currentProject: null,
  scoutSeen: null,
  pullsReadAt: null,
  pullsAskOnly: false,
  setupSteps: null,
  afterLearn: [],
  termsAccepted: null,
};

// The keys that follow the machine and not one project. The settings store keeps
// them in the machine database, so a caller asks for one the way it asks for any other key.
// `gettingStarted` joins them because New project starts it once per machine, and `currentProject`
// because it picks among the machine's projects. `jiraSite` and `jiraEmail` joined with Settings,
// Integrations, because the token they go with is the data folder's; an older project's row is
// copied over by `machineRow` the first time it is read. `teamHubJobDone` is not one: each team project dials a
// team socket of its own, so each keeps the mark of the jobs that socket finished.
export const MACHINE_KEYS = [
  'agentSlots',
  'runTimeoutMs',
  'retryWaitsMs',
  'keepAwake',
  'engineProfiles',
  'engineLimits',
  'hubJobDone',
  'accountProjects',
  'syncPaused',
  'onboarding',
  'seenNotes',
  'gettingStarted',
  'currentProject',
  'jiraSite',
  'jiraEmail',
  'termsAccepted',
] as const satisfies readonly SettingKey[];

export const isMachineKey = (key: SettingKey): boolean => (MACHINE_KEYS as readonly SettingKey[]).includes(key);

/**
 * The sentence that refuses a saved preset list, or null when it is fine.
 *
 * The same rules the screen refuses a typed name with, so a hand edited database cannot hold a
 * name the screen would not take. A row of a profile this machine no longer holds passes, because
 * applying such a preset marks that row and writes the rest.
 */
export function validateSavedPresets(value: unknown): string | null {
  if (!Array.isArray(value)) return 'The saved presets are a list.';
  const taken: string[] = [];
  for (const row of value) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return 'A saved preset is a name and a table of actions.';
    const { name, models } = row as Record<string, unknown>;
    if (typeof name !== 'string') return 'A saved preset needs a name.';
    const refusedName = presetNameProblem(name, [...PRESET_NAMES, ...taken]);
    if (refusedName !== null) return refusedName;
    const refused = validateModelTable(models);
    if (refused !== null) return refused;
    taken.push(name.trim());
  }
  return null;
}

// Vendors an earlier build ran and this one does not. Antigravity left before 0.1.0, because Google's
// terms do not allow third-party apps on its consumer plans. A machine that used it still stores its
// profile, so the read drops that profile, as if the person removed it, rather than refusing the whole
// list and losing every other login with it. A row that still names the profile then reads as one of
// a removed profile.
const RETIRED_VENDORS: readonly string[] = ['antigravity'];
const retired = (row: unknown): boolean =>
  typeof row === 'object' && row !== null && RETIRED_VENDORS.includes(String((row as Record<string, unknown>).vendor));

/**
 * The sentence that refuses a profile list, or null when it is fine.
 *
 * An empty list is refused rather than filled in: the list is what every action with no engine of
 * its own inherits from, so an empty one would make every drop fail with a message about a
 * profile nobody removed on purpose.
 */
export function validateProfiles(value: unknown): string | null {
  if (!Array.isArray(value)) return 'The engine profiles are a list.';
  if (value.length === 0) return 'There has to be at least one engine profile.';
  const seen = new Set<string>();
  // The first profile found on each vendor and place, so a second one on the same place is caught.
  const vendors = new Map<string, string>();
  for (const row of value) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return 'An engine profile is an id, a label, a vendor and a config folder.';
    const { id, label, vendor, configDir } = row as Record<string, unknown>;
    if (typeof id !== 'string' || !isProfileId(id)) return `${String(id)} is not an engine profile id. One looks like claude-code or codex#work.`;
    // Two profiles under one id would share every stored choice without saying so.
    if (seen.has(id)) return `There are two engine profiles with the id ${id}.`;
    seen.add(id);
    if (typeof label !== 'string' || label.trim() === '') return `The profile ${id} needs a label.`;
    if (typeof vendor !== 'string' || !isEngineName(vendor)) return `The profile ${id} names the vendor ${String(vendor)}, which this version does not know.`;
    if (configDir !== null && typeof configDir !== 'string') return `The config folder of ${id} is a path, or nothing for the vendor's own place.`;

    // Refused here as well as where a run is spawned. Refusing at the moment the person types it is
    // the only place they can do anything about it.
    if (typeof configDir === 'string') {
      // The vendor resolves a relative folder against the card's checkout, so a relative one makes
      // a login folder inside somebody's repository.
      // `~` is the shell's, not the vendor's: nothing expands it here, so a run would make a folder
      // called `~` in the working directory.
      if (!configDir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(configDir))
        return `The config folder of ${id} is not a full path. A path starting with ~ is not expanded, so write the folder out in full.`;
    }

    // A second login of one vendor needs a folder of its own. Two profiles on the same place, the
    // vendor's default one or a folder named twice, read the same login, so a card that picks one
    // would run on the other and "a session belongs to one profile" would stop being true.
    const place = `${vendor}\u0000${configDir ?? ''}`;
    const sharing = vendors.get(place);
    if (sharing !== undefined)
      return configDir === null
        ? `The profiles ${sharing} and ${id} are both ${vendor} with no config folder, so they would share one login. Give the second one a folder of its own.`
        : `The profiles ${sharing} and ${id} are both ${vendor} on the config folder ${configDir}, so they would share one login. Give the second one a folder of its own.`;
    vendors.set(place, id);
  }
  return null;
}

/**
 * The sentence that refuses a stored limit state, or null when it is fine.
 *
 * Nothing but a run writes this, so a person never reads these sentences. It is checked all the
 * same, because a hand edited database would otherwise draw a share of NaN on the Engines screen,
 * and every field here is one an engine may leave out.
 */
export function validateLimits(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'The engine limit states are one entry per profile id.';
  for (const [id, seen] of Object.entries(value)) {
    if (!isProfileId(id)) return `${id} is not an engine profile id.`;
    if (typeof seen !== 'object' || seen === null || Array.isArray(seen)) return `The limit state of ${id} is the time it was seen and a list of windows.`;
    const { seenAt, windows } = seen as Record<string, unknown>;
    if (typeof seenAt !== 'number' || !Number.isFinite(seenAt)) return `The limit state of ${id} needs the time it was seen.`;
    if (!Array.isArray(windows)) return `The limit state of ${id} holds a list of usage windows.`;
    for (const window of windows) {
      if (typeof window !== 'object' || window === null || Array.isArray(window)) return `A usage window of ${id} is a name, a share, a reset time and a status.`;
      const { name, used, resetsAt, status } = window as Record<string, unknown>;
      // The name is the engine's own word, and a later version may add a window, so any word is
      // taken. An empty one names nothing and would draw a line with no subject.
      if (typeof name !== 'string' || name.trim() === '') return `A usage window of ${id} needs the name the engine gave it.`;
      if (used !== null && !(typeof used === 'number' && Number.isFinite(used))) return `The share of the ${name} window of ${id} is a number, or nothing when the engine reported none.`;
      if (resetsAt !== null && !(typeof resetsAt === 'number' && Number.isFinite(resetsAt))) return `The reset time of the ${name} window of ${id} is unix seconds, or nothing when the engine reported none.`;
      if (status !== null && typeof status !== 'string') return `The status of the ${name} window of ${id} is the engine's own word, or nothing.`;
    }
  }
  return null;
}

// The same rule the runner holds for a card key. Core imports nothing of the runner, so it is
// written again here: the name becomes a folder inside the card's checkout, and a slash or a
// control character would reach another folder or break the worktree list. .git inside the card
// root is the root checkout's own link to its repository.
// A name that starts with "-" reads as an option to git, and the three Nolzu folders sit beside the
// repositories in the project folder.
export const NOLZU_FOLDERS: readonly string[] = ['worktrees', '.tasks', '.nolzu'];
const isNolzuFolder = (value: string): boolean => NOLZU_FOLDERS.includes(value.toLowerCase());

const QA_APP_REFUSED = 'QA gets the app by a start command in one repository, by your own commands, at an address the person runs, or not at all.';

// An optional command of an `own` answer: text, or nothing for an empty one.
const optionalCommand = (value: unknown): string | null | undefined =>
  value === undefined || value === null ? null : typeof value === 'string' ? value.trim() || null : undefined;

function qaAppOf(value: unknown): QaApp | null {
  const app = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (app.mode === 'code') return { mode: 'code' };
  if (app.mode === 'own') {
    const stop = optionalCommand(app.stop);
    const status = optionalCommand(app.status);
    const start = typeof app.start === 'string' ? app.start.trim() : '';
    return start === '' || stop === undefined || status === undefined ? null : { mode: 'own', start, stop, status };
  }
  if (app.mode === 'running') {
    const address = typeof app.address === 'string' ? appAddress(app.address) : null;
    return address === null ? null : { mode: 'running', address };
  }
  if (app.mode === 'dev' && typeof app.command === 'string' && app.command.trim() !== '' && typeof app.repo === 'string' && (app.repo === '.' || isFolderName(app.repo))) {
    // A hash in any other shape is dropped, which makes the next QA ask again.
    const scripts = typeof app.scripts === 'string' && /^[0-9a-f]{64}$/.test(app.scripts) ? { scripts: app.scripts } : {};
    if (app.folder !== undefined && (typeof app.folder !== 'string' || !isFolderName(app.folder))) return null;
    return { mode: 'dev', command: app.command.trim(), repo: app.repo, ...(app.folder === undefined ? {} : { folder: app.folder }), ...scripts };
  }
  return null;
}

export const isFolderName = (value: string): boolean =>
  value !== '' &&
  !value.startsWith('-') &&
  !isNolzuFolder(value) &&
  value !== '.' &&
  value !== '..' &&
  value.toLowerCase() !== '.git' &&
  ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || character === '/' || character === '\\';
  });

/**
 * The sentence that refuses a repository list, or null when it is fine.
 *
 * "." comes first because its checkout is the card's root folder, and the other checkouts are made
 * inside it. A workspace list may be empty, and never holds ".".
 */
export function validateRepos(value: unknown, workspace = false): string | null {
  if (!Array.isArray(value)) return 'The repositories are a list of folders, or nothing for one repository at the project folder.';
  if (value.length === 0 && !workspace) return 'The repository list is empty. Leave it unset for one repository at the project folder.';
  // Lower case, because the default macOS disk reads api and API as one folder.
  const taken = new Set<string>();
  for (const [index, row] of value.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return 'A repository is a folder and a base branch.';
    const { path, base } = row as Record<string, unknown>;
    if (typeof path !== 'string') return 'A repository needs a folder.';
    const name = JSON.stringify(path);
    if (path === '.' && workspace) return 'A workspace is never a repository a card changes, so "." is not in its list.';
    if (isNolzuFolder(path)) return `The folder ${name} is where Nolzu keeps its own files, so it cannot be a repository.`;
    if (path.startsWith('-')) return `The repository folder ${name} starts with "-", which git would read as an option.`;
    if (path !== '.' && !isFolderName(path)) {
      return `The repository folder ${name} is not "." or one folder name inside the project.`;
    }
    if (taken.has(path.toLowerCase())) return `The repository ${name} is in the list twice.`;
    if (path === '.' && index !== 0) return 'The project folder "." comes first in the repository list.';
    if (base !== null && typeof base !== 'string') return `The base branch of ${name} is not a branch name.`;
    if (typeof base === 'string' && base.trim() === '') {
      return `The base branch of ${name} is empty. Name a branch, or leave it unset to use the project's base branch.`;
    }
    taken.add(path.toLowerCase());
  }
  return null;
}

// Every repository with the base branch it branches from. A project with no list has one repository
// at the project folder, which is what every project had before the list existed. An empty
// workspace has none.
export const projectRepos = (settings: Pick<Settings, 'repos' | 'baseBranch'>): { path: string; base: string }[] =>
  (settings.repos ?? [{ path: '.', base: null }]).map(({ path, base }) => ({ path, base: base ?? settings.baseBranch }));

// What a card on an empty workspace is told. It has nowhere to change anything until a repository
// is added.
export const NO_REPOSITORY = 'This project has no repository yet. Add one in Project settings.';

export type Validation<K extends SettingKey> = { ok: true; value: Settings[K] } | { ok: false; message: string };

const ok = (value: unknown) => ({ ok: true as const, value });
const no = (message: string) => ({ ok: false as const, message });
const isWholeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

// The agent slot range, which the Runs stepper stops at too.
export const AGENT_SLOTS = { min: 1, max: 20 } as const;

// The workspace flag is handed to every validator, because a validator sees one value and the
// repository list follows a rule of its own in a workspace. Only that one reads it.
type Validator = (value: unknown, workspace: boolean) => { ok: true; value: unknown } | { ok: false; message: string };

// One message per setting, naming the rule that refused the value. A screen shows it as it
// is, so it has to read as a sentence and not as a rule name.
const VALIDATORS: Record<SettingKey, Validator> = {
  agentSlots: (value) =>
    isWholeNumber(value) && value >= AGENT_SLOTS.min && value <= AGENT_SLOTS.max
      ? ok(value)
      : no(`Agent slots must be a whole number from ${AGENT_SLOTS.min} to ${AGENT_SLOTS.max}.`),
  runTimeoutMs: (value) =>
    typeof value === 'number' && value >= 60_000 ? ok(value) : no('The run timeout must be at least one minute, in milliseconds.'),
  // Whole minutes, because the card counts in minutes and a quiet time under one would read "Quiet 0m".
  quietAfterMs: (value) =>
    isWholeNumber(value) && value >= 60_000 && value % 60_000 === 0 ? ok(value) : no('The quiet time must be whole minutes, at least one, given in milliseconds.'),
  // An empty list is the way to say no retry: the runner then has no wait to take and gives up on the
  // first API error.
  retryWaitsMs: (value) =>
    Array.isArray(value) && value.every((wait) => typeof wait === 'number' && wait > 0)
      ? ok(value)
      : no('The retry waits are a list of millisecond numbers above zero, or an empty list for no retry.'),
  keepAwake: (value) => (typeof value === 'boolean' ? ok(value) : no('Keep awake is either on or off.')),
  modelPreset: (value) =>
    value === 'light' || value === 'default' || value === 'heavy' ? ok(value) : no('The model preset is light, default or heavy.'),
  models: (value) => {
    // Read back with any engine, so a row another version stored survives; the Models screen writes the one engine.
    const table = renamedActions(value);
    const refused = validateModelTable(table);
    return refused === null ? ok(table) : no(refused);
  },
  savedPresets: (value) => {
    const list = Array.isArray(value) ? value.map((row: unknown) => (typeof row === 'object' && row !== null && !Array.isArray(row) ? { ...row, models: renamedActions((row as { models?: unknown }).models) } : row)) : value;
    const refused = validateSavedPresets(list);
    return refused === null ? ok(list) : no(refused);
  },
  presetEngine: (value) => (value === null || (typeof value === 'string' && isEngineName(value)) ? ok(value) : no('The preset engine is an engine name, or none.')),
  savedPreset: (value) => (value === null || (typeof value === 'string' && value.trim() !== '') ? ok(value) : no('The chosen preset is a saved preset name, or none.')),
  presetChosen: (value) => (typeof value === 'boolean' ? ok(value) : no('Whether a preset was chosen is either on or off.')),
  presetChoices: (value) => {
    if (value === null) return ok(value);
    if (typeof value !== 'object' || Array.isArray(value)) return no('The phases changed per preset are a table by preset and engine.');
    const tables = Object.fromEntries(Object.entries(value).filter(([key]) => !RETIRED_VENDORS.includes(key.split(':')[1] ?? '')).map(([key, table]) => [key, renamedActions(table)]));
    for (const [key, table] of Object.entries(tables)) {
      const [preset, engine] = key.split(':');
      if (!(PRESET_NAMES as readonly string[]).includes(preset ?? '') || !isEngineName(engine ?? '')) return no(`${key} is not a preset and an engine, such as heavy:cursor.`);
      const refused = validateModelTable(table);
      if (refused !== null) return no(refused);
    }
    return ok(tables);
  },
  engineProfiles: (value) => {
    const list = Array.isArray(value) ? value.filter((row: unknown) => !retired(row)) : value;
    const refused = validateProfiles(list);
    return refused === null ? ok(list) : no(refused);
  },
  engineLimits: (value) => {
    const refused = validateLimits(value);
    return refused === null ? ok(value) : no(refused);
  },
  // A row an older version stored as another flow fails here, so it reads back as the default.
  deliveryFlow: (value) => (value === 'pull-request' ? ok(value) : no('The Delivery flow is pull-request.')),
  baseBranch: (value) => (typeof value === 'string' && value.trim() !== '' ? ok(value) : no('The base branch cannot be empty.')),
  repos: (value, workspace) => {
    if (value === null) return ok(value);
    const refused = validateRepos(value, workspace);
    // Only the two known fields are kept, so the stored value is the type it claims to be.
    return refused === null ? ok((value as ProjectRepo[]).map(({ path, base }) => ({ path, base }))) : no(refused);
  },
  workspace: (value) => (value === true || value === null ? ok(value) : no('The workspace setting is true for a workspace, or unset for an ordinary project.')),
  branchTemplate: (value) =>
    typeof value === 'string' && value.includes('{key}')
      ? ok(value)
      : no('The branch template must carry {key}, so the branch name carries the card key.'),
  offBoards: (value) => {
    if (!Array.isArray(value) || !value.every((one) => typeof one === 'string')) return no('The boards that are off are a list of board names.');
    const refused = value.find((one: string, index) => one === 'delivery' || !isBoardKind(one) || value.indexOf(one) !== index);
    // The two Research kinds are one list, so one of them alone is no state: it reads as both on.
    const research = value.filter((one: string) => isResearchKind(one));
    if (refused === undefined) return ok(research.length === 1 ? value.filter((one: string) => !isResearchKind(one)) : value);
    if (refused === 'delivery') return no('The Delivery board cannot be turned off.');
    return isBoardKind(refused) ? no(`The ${BOARD_LABELS[refused]} board is in the list twice.`) : no(`There is no ${refused} board.`);
  },
  chainBoards: (value) => {
    if (!Array.isArray(value) || !value.every((one) => typeof one === 'string')) return no('The boards with a chain turned on are a list of board names.');
    const refused = value.find((one: string, index) => !isBoardKind(one) || value.indexOf(one) !== index);
    if (refused === undefined) return ok(value);
    return isBoardKind(refused) ? no(`The ${BOARD_LABELS[refused]} board is in the list twice.`) : no(`There is no ${refused} board.`);
  },
  chainNotNow: (value) => (isWholeNumber(value) && value >= 0 ? ok(value) : no('The Not now mark is a card move id, zero or more.')),
  ticketSystem: (value) => ((TICKET_SYSTEMS as readonly unknown[]).includes(value) ? ok(value) : no('The ticket system is local or jira.')),
  // Stored as its origin, because every call names a full path of its own. `siteOrigin` is what a
  // Jira Scout source is checked with, so both refuse the same addresses in the same words.
  jiraSite: (value) => {
    if (value === null) return ok(value);
    if (typeof value !== 'string') return no('A Jira site address looks like https://your-site.atlassian.net.');
    try {
      return ok(siteOrigin(value).origin);
    } catch (error) {
      return no((error as Error).message);
    }
  },
  // A Jira Scout source only refuses an empty email. One @ and no space is checked here as well,
  // because a token pasted into the wrong box would otherwise be stored as the email.
  jiraEmail: (value) =>
    value === null || (typeof value === 'string' && /^[^\s@]+@[^\s@]+$/.test(value.trim()))
      ? ok(typeof value === 'string' ? value.trim() : value)
      : no('The Jira account email is the address you sign in to Jira with, such as you@example.com.'),
  jiraKeyClash: (value) => {
    const clash = value as Record<string, unknown> | null;
    if (clash === null) return ok(null);
    return typeof clash === 'object' && typeof clash.prefix === 'string' && typeof clash.site === 'string' && (clash.suggestion === null || typeof clash.suggestion === 'string')
      ? ok({ prefix: clash.prefix, site: clash.site, suggestion: clash.suggestion })
      : no('The Jira key clash is a prefix, a site and a suggestion, or nothing.');
  },
  localKeyPrefix: (value) =>
    typeof value === 'string' && /^[A-Z]{2,6}$/.test(value)
      ? ok(value)
      : no('The local key prefix is two to six uppercase letters, such as APP.'),
  // Absolute, because the engine resolves a relative path against the card's checkout, where this
  // file is not. Whether the file is there and readable is asked when a run is built, because that
  // needs the disk and this file is pure.
  qaMcpConfigPath: (value) =>
    value === null || (typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')))
      ? ok(value)
      : no('The browser config is a full path to a file, such as /home/you/.nolzu/playwright-mcp.json, or nothing.'),
  // Only the fields of each mode are kept, so the stored value is the type it claims to be. A single
  // answer, the shape stored before answers were per repository, belongs to the repository it names,
  // or to every repository when it names none.
  qaApp: (value) => {
    if (value === null) return ok(value);
    if (typeof value !== 'object' || Array.isArray(value)) return no(QA_APP_REFUSED);
    const map = value as Record<string, unknown>;
    if ('mode' in map) {
      const one = qaAppOf(map);
      return one === null ? no(QA_APP_REFUSED) : ok({ [one.mode === 'dev' ? one.repo : EVERY_REPO]: one });
    }
    const apps: Record<string, QaApp> = {};
    for (const [repo, answer] of Object.entries(map)) {
      const one = qaAppOf(answer);
      if (one === null || (repo !== EVERY_REPO && repo !== '.' && !isFolderName(repo)) || (one.mode === 'dev' && one.repo !== repo)) return no(QA_APP_REFUSED);
      apps[repo] = one;
    }
    return ok(Object.keys(apps).length === 0 ? null : apps);
  },
  allowedCommands: (value) => {
    if (value === null) return ok(value);
    if (!Array.isArray(value) || !value.every((command) => typeof command === 'string')) return no('The allowed commands are a list of commands.');
    // An entry a later version refuses is dropped alone. Refusing the whole list would read as no list,
    // which runs with no commands and lets the first task screen write a new proposal over it.
    return ok(value.filter((command: string) => allowedCommandProblem(command) === null));
  },
  wallLists: (value) => {
    const lists = value as Record<string, unknown> | null;
    const isList = (list: unknown) => Array.isArray(list) && list.every((entry) => typeof entry === 'string');
    return typeof lists === 'object' && lists !== null && isList(lists.hidden) && isList(lists.exceptions) && isList(lists.writable)
      ? ok({ hidden: lists.hidden, exceptions: lists.exceptions, writable: lists.writable })
      : no('The wall lists are three lists of paths: hidden, exceptions and writable.');
  },
  // Absolute, like the project path and for the same reason: a relative folder means something
  // else to every process that reads it. Whether the folder is a repository is asked where it is
  // chosen, because it needs git and this file is pure.
  knowledgeDir: (value) =>
    value === null || (typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')))
      ? ok(value)
      : no('The knowledge folder is a full folder path, or nothing.'),
  reviewKnowledge: (value) => (typeof value === 'boolean' ? ok(value) : no('Reviewing knowledge changes is either on or off.')),
  // Absolute, because a relative one means something else to every process that reads it.
  projectPath: (value) =>
    value === null || (typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')))
      ? ok(value)
      : no('The project path is a full folder path, such as /home/you/recipes, or nothing.'),
  knowledgeRepo: (value) => (value === null || (typeof value === 'string' && value.startsWith('/')) ? ok(value) : no('The repository of the knowledge folder is a full folder path, or nothing.')),
  gitLink: (value) => (value === null || (typeof value === 'string' && value.startsWith('/')) ? ok(value) : no("Where the project's .git leads is a full folder path, or nothing.")),
  clientName: (value) =>
    value === null || (typeof value === 'string' && value.trim() !== '') ? ok(value) : no('The client name is a name, or nothing at all.'),
  // A number, because it is multiplied by hours. Text here would draw NaN in every margin line.
  // Zero is allowed and means unpaid work, which is not the same as no rate: nothing stored is null.
  hourlyRate: (value) =>
    value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      ? ok(value)
      : no('The hourly rate is a number, such as 80, or nothing at all.'),
  currency: (value) =>
    typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? ok(value) : no('The currency is a three-letter code, such as USD.'),
  billingAsked: (value) => (typeof value === 'boolean' ? ok(value) : no('Whether Evidence asked about billing is either yes or no.')),
  projectId: (value) =>
    value === null || (typeof value === 'string' && value.trim() !== '') ? ok(value) : no('The project id is the id this machine was registered with, or nothing at all.'),
  teamProjectId: (value) =>
    value === null || (typeof value === 'string' && value.trim() !== '')
      ? ok(value)
      : no('The team project id is the id the team hub minted, or nothing at all.'),
  exportProjectId: (value) =>
    value === null || (typeof value === 'string' && value.trim() !== '')
      ? ok(value)
      : no('The export project id is the id this machine minted at its first export, or nothing at all.'),
  // Zero is the mark of a machine that has finished no job, so it is a value and not a missing one.
  hubJobDone: (value) =>
    isWholeNumber(value) && value >= 0 ? ok(value) : no('The last finished hub job is a whole number, zero or more.'),
  teamHubJobDone: (value) =>
    isWholeNumber(value) && value >= 0 ? ok(value) : no('The last finished team hub job is a whole number, zero or more.'),
  // The protocol's own reader, so a stored list holds to the rules the job was read with.
  accountProjects: (value) => {
    if (value === null) return ok(value);
    try {
      return ok(readProjectList({ projects: value }).projects);
    } catch (error) {
      return no(error instanceof Error ? error.message : String(error));
    }
  },
  syncPaused: (value) => (typeof value === 'boolean' ? ok(value) : no('Sync after a cloud data delete is either paused or not.')),
  onboarding: (value) => {
    const refused = validateProgress(value);
    // Only the flag goes on, so an old wizard row reads back in the shape of today.
    return refused === null ? ok({ done: (value as Progress).done }) : no(refused);
  },
  seenNotes: (value) =>
    Array.isArray(value) && value.every((note) => typeof note === 'string' && /^[a-z][a-z0-9-]*$/.test(note))
      ? ok(value)
      : no('The closed coach notes are a list of note names, such as first-drag.'),
  gettingStarted: (value) =>
    value === null ||
    (Array.isArray(value) && value.every((step) => (GETTING_STARTED_STEPS as readonly unknown[]).includes(step)) && new Set(value).size === value.length)
      ? ok(value as Settings['gettingStarted'])
      : no('The steps of Getting started that are done are a list of summary and push, each once.'),
  currentProject: (value) =>
    value === null || (isWholeNumber(value) && value >= 1) ? ok(value) : no('The current project is the id of a project on this machine, or nothing.'),
  scoutSeen: (value) =>
    value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value))) ? ok(value) : no('The Scout seen marker is the time a finding was first seen.'),
  pullsReadAt: (value) =>
    value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value))) ? ok(value) : no('The pull request read time is a time, or nothing before the first read.'),
  pullsAskOnly: (value) => (typeof value === 'boolean' ? ok(value) : no('The pull request read rule is on or off.')),
  setupSteps: (value) =>
    value === null ||
    (typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(([step, mark]) => (SETUP_STEPS as readonly string[]).includes(step) && (SETUP_MARKS as readonly unknown[]).includes(mark)))
      ? ok(value as SetupMarks | null)
      : no('The setup steps are a step name, such as learn, with done, self or dismissed.'),
  afterLearn: (value) =>
    Array.isArray(value) &&
    value.every(
      (one) =>
        typeof one === 'object' && one !== null && typeof (one as AfterLearn).key === 'string' && typeof (one as AfterLearn).to === 'string' && typeof (one as AfterLearn).at === 'string' && !Number.isNaN(Date.parse((one as AfterLearn).at)),
    )
      ? ok(value as AfterLearn[])
      : no('The moves after Learn are a list of a card key, the column it goes to and the time of the press.'),
  termsAccepted: (value) => {
    if (value === null) return ok(value);
    const terms = value as Partial<TermsAccepted>;
    return typeof value === 'object' && typeof terms.version === 'string' && terms.version !== '' && typeof terms.at === 'string' && !Number.isNaN(Date.parse(terms.at))
      ? ok({ version: terms.version, at: terms.at })
      : no('The accepted terms are a version and the time they were accepted, or nothing.');
  },
};

export function isSettingKey(key: string): key is SettingKey {
  // hasOwn, so a name such as __proto__ or toString cannot pass as a setting.
  return Object.hasOwn(VALIDATORS, key);
}

export function validateSetting<K extends SettingKey>(key: K, value: unknown, workspace = false): Validation<K> {
  return VALIDATORS[key](value, workspace) as Validation<K>;
}

// The read path a stored value takes. A hand edited database must not stop the app from
// starting, so a value that no longer parses falls back and says that it did.
// In a workspace, a missing or unreadable repository list reads as empty. Null there would read as
// one repository at the project folder, and a card would then change the workspace's own repository.
export function readSetting<K extends SettingKey>(key: K, raw: string | undefined, workspace = false): { value: Settings[K]; fellBack: boolean } {
  const fallback = (key === 'repos' && workspace ? [] : DEFAULTS[key]) as Settings[K];
  if (raw === undefined) return { value: fallback, fellBack: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: fallback, fellBack: true };
  }

  const result = validateSetting(key, parsed, workspace);
  if (!result.ok) return { value: fallback, fellBack: true };
  return { value: result.value === null ? fallback : result.value, fellBack: false };
}
