import type { DatabaseSync } from 'node:sqlite';
import { SCOUT_SOURCE_LABELS, type ScoutSchedule, type ScoutSourceKind, scoutEntryName, scoutSecretName } from '@nolzu/protocol';
import { addScoutSource, checkPasteSource, clearScoutCursor, removeScoutSource, resolveDataDir, type ScoutCheck, type ScoutSource, scoutSource, scoutSources, setScoutSource } from '@nolzu/core/node';
import { type Keychain, keychainAccount } from '@nolzu/runner';
import { readScheduleForm, type ScheduleChoice, scheduleChoice } from './scout-schedule.ts';

// One setting of one source. The name is both the input's name in the form and the key it is stored
// under, so a field cannot be posted under one name and read under another.
export interface SourceField {
  name: string;
  label: string;
  placeholder: string;
}

/**
 * The form one kind of source is added and edited with.
 *
 * Every source form names the least its token needs to be allowed to read, and says where
 * that token is kept. Both sentences are per form and not one for all of
 * them, because one of these sources stores no token at all.
 */
export interface SourceForm {
  // What the kind choice posts. The kind, plus the ticket system where one kind has two of them.
  id: string;
  kind: ScoutSourceKind;
  label: string;
  // What the kind needs, in the few words under its name in the Add a source dialog.
  needs: string;
  fields: SourceField[];
  // Which ticket system this form is for, or null for a kind with one form.
  system: string | null;
  // What the credential field is called, or null for a source that needs no credential here.
  secret: string | null;
  scopes: string;
  credential: string;
  // How the keychain entry of the secret is named, or null for a form that keeps none.
  entry: SourceEntry | null;
  /**
   * Whether Nolzu cloud can run this source's check, which is what a schedule needs.
   *
   * True for a source read over HTTPS from a vendor's own public API. False for the other three
   * reasons a check stays on this machine: a person hands the text over, the adapter spawns the `gh`
   * or `glab` binary this machine holds a login for, or the address belongs to the person's own
   * network. A source with false keeps "Check now" and is offered no schedule.
   */
  cloud: boolean;
}

/**
 * The keychain name of a form's secret: the kind word, then the field that says which project it
 * reads, so the entry reads as `sentry-recipes-web-7` and the dialog can show `nolzu/sentry/recipes-web`
 * while the person types. `service` is the one place the secret is sent.
 */
export interface SourceEntry {
  word: string;
  field: string;
  service: string;
}

const KEYCHAIN =
  "The token goes into this machine's OS keychain, under the service name nolzu. It never reaches the database or a log.";

const PASTE: SourceForm = {
  id: 'paste',
  kind: 'paste',
  label: SCOUT_SOURCE_LABELS.paste,
  needs: 'Needs nothing',
  fields: [],
  system: null,
  secret: null,
  entry: null,
  scopes: 'Nothing. You paste the text yourself, so there is no account to read.',
  credential: 'No credential. This source reads what you paste and nothing else.',
  cloud: false,
};

// Three ticket systems share one kind, because they answer the same question with the same adapter
// shape. They are four forms, because each names its own settings and two of them need no token at
// all: GitHub rides on the gh login and GitLab on the glab one.
const SOURCE_FORM_LIST: readonly SourceForm[] = [
  PASTE,
  {
    id: 'tickets-github',
    kind: 'tickets',
    label: 'GitHub issues and failed CI',
    needs: 'Uses your gh login',
    fields: [
      { name: 'repo', label: 'Repository', placeholder: 'owner/repo' },
      { name: 'query', label: 'Issue search', placeholder: 'is:issue is:open label:bug' },
    ],
    system: 'github',
    secret: null,
    entry: null,
    scopes: 'Read access to the issues and the CI runs of that repository, and nothing more. Your gh login already has it.',
    credential: 'No credential is stored here. Nolzu runs gh, and gh holds your GitHub login.',
    cloud: false,
  },
  {
    id: 'tickets-gitlab',
    kind: 'tickets',
    label: 'GitLab issues',
    needs: 'Uses your glab login',
    fields: [
      { name: 'project', label: 'Project', placeholder: 'namespace/project' },
      { name: 'query', label: 'Issue search', placeholder: 'label:bug slow import' },
    ],
    system: 'gitlab',
    secret: null,
    entry: null,
    scopes: 'Read access to the issues of that project, and nothing more. Your glab login already has it.',
    credential: 'No credential is stored here. Nolzu runs glab, and glab holds your GitLab login.',
    cloud: false,
  },
  {
    id: 'tickets-jira',
    kind: 'tickets',
    label: 'Jira',
    needs: 'API token',
    fields: [
      { name: 'site', label: 'Site address', placeholder: 'https://your-site.atlassian.net' },
      { name: 'email', label: 'Account email', placeholder: 'you@example.com' },
      { name: 'jql', label: 'Query', placeholder: 'project = PROJ AND status = Open' },
    ],
    system: 'jira',
    secret: 'API token',
    entry: { word: 'jira', field: 'site', service: 'Jira' },
    scopes: 'A read-only API token with the Browse Projects permission, and only on the projects your query asks for.',
    credential: KEYCHAIN,
    cloud: true,
  },
  {
    id: 'tickets-linear',
    kind: 'tickets',
    label: 'Linear',
    needs: 'API key',
    // No site address: Linear has one API for everybody. No query either, because Linear has no query
    // language, so the teams are what says which tickets to read.
    fields: [{ name: 'teams', label: 'Team keys', placeholder: 'PROJ, OPS' }],
    system: 'linear',
    secret: 'API key',
    entry: { word: 'linear', field: 'teams', service: 'Linear' },
    // Honest rather than reassuring. Linear scopes an OAuth app and not a personal API key, so the
    // key can do whatever the account can, and this form may not claim otherwise.
    scopes: 'A personal API key. Linear does not narrow one, so it can reach everything your account can. Nolzu only reads, and only the teams you name here.',
    credential: KEYCHAIN,
    cloud: true,
  },
  {
    id: 'sentry',
    kind: 'sentry',
    label: SCOUT_SOURCE_LABELS.sentry,
    needs: 'Auth token',
    fields: [
      { name: 'org', label: 'Organization', placeholder: 'your-org' },
      { name: 'project', label: 'Project', placeholder: 'recipes-api' },
    ],
    system: null,
    secret: 'Auth token',
    entry: { word: 'sentry', field: 'project', service: 'Sentry' },
    scopes: 'An Auth token with project:read and event:read. Nothing that writes.',
    credential: KEYCHAIN,
    cloud: true,
  },
  {
    id: 'search',
    kind: 'search',
    label: SCOUT_SOURCE_LABELS.search,
    needs: 'Elasticsearch or OpenSearch',
    fields: [
      { name: 'endpoint', label: 'Cluster address', placeholder: 'https://logs.example.com:9200' },
      { name: 'index', label: 'Index', placeholder: 'logs-*' },
      { name: 'query', label: 'Query', placeholder: 'level:error' },
    ],
    system: null,
    secret: 'API key',
    entry: { word: 'logs', field: 'endpoint', service: 'the cluster' },
    scopes: 'An API key that may read the index you name. It cannot write, and it needs no cluster rights.',
    // The one form whose credential line says more than where the token goes, because the two
    // products take two headers and the key itself is what tells them apart.
    credential: `${KEYCHAIN} Paste the encoded value the cluster answers with when it makes the key, not the id and the key joined by a colon. A cluster that wants basic auth instead takes the key as user:password.`,
    // The cluster address is the person's own, so the server cannot reach this source.
    cloud: false,
  },
];

// Exported so a mounted test builds its fixture with the real list rather than a copy of it.
export const SOURCE_FORMS = SOURCE_FORM_LIST;

// The form a stored source is edited with. A kind with two systems says which it is in its settings,
// and a system this version does not know reads as the first form of its kind rather than as nothing.
export function formOf(source: Pick<ScoutSource, 'kind' | 'config'>): SourceForm {
  const same = SOURCE_FORM_LIST.filter((one) => one.kind === source.kind);
  return same.find((one) => one.system === source.config.system) ?? same[0] ?? PASTE;
}

/**
 * The keychain name of a source's secret, by its kind, the project it reads and its id, or null for a
 * form that keeps no secret. A source whose project changes gets a new name, so a save moves the
 * secret with it.
 */
export function sourceEntry(source: Pick<ScoutSource, 'id' | 'kind' | 'config'>): string | null {
  const entry = formOf(source).entry;
  return entry === null ? null : scoutEntryName(entry.word, source.config[entry.field] ?? '', source.id);
}

/**
 * A source's secret, read from its own entry.
 *
 * An older source still has its secret under `scout-<id>`. The first read moves it: the new entry is
 * written first, so a failed move leaves the old one where it was, and the old one is removed after,
 * so no copy stays behind.
 */
export async function sourceSecret(keychain: Keychain, source: Pick<ScoutSource, 'id' | 'kind' | 'config'>): Promise<string | null> {
  const name = sourceEntry(source);
  if (name === null) return null;
  const held = await keychain.read(name);
  if (held !== null) return held;
  const old = scoutSecretName(source.id);
  const moved = await keychain.read(old);
  if (moved === null) return null;
  await keychain.write(name, moved);
  await keychain.remove(old);
  return moved;
}

export interface ScoutSourceRow {
  id: number;
  label: string;
  form: SourceForm;
  // The stored settings, so an edit form opens on what is there.
  values: Readonly<Record<string, string>>;
  enabled: boolean;
  createCards: boolean;
  autoAssess: boolean;
  // The stored schedule as the control draws it. Shaped here rather than in the component, because
  // the component may import no module that reaches the database.
  schedule: ScheduleChoice;
  // The keychain entry that holds this source's token, or null for a form that stores none. Named
  // and never read: a keychain read can ask the person for their keychain password, and opening the
  // Scout page may not do that. So the row says where the token belongs, not whether it is there.
  secretName: string | null;
  checked: string;
  // The last check in the few characters the sources strip has, such as "13:02". Null before the first.
  checkedAt: string | null;
  error: string | null;
}

export interface ScoutSection {
  rows: ScoutSourceRow[];
  forms: SourceForm[];
}

/**
 * A sqlite stamp as a person reads it.
 *
 * Written out and not relative, the way `engine-limits.ts` writes a time: "2 hours ago" needs the
 * clock, and a server render would bake the clock of the render into the page. No time zone is
 * passed, because Nolzu runs on the person's own machine and the server is in their zone.
 */
export const when = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

/** The calendar day of a time in the person's zone, as 2026-10-12, so two days compare as text. */
export const dayKey = (at: Date, timeZone?: string): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/** "9 Oct", the day without its year. */
export const dayMonth = (at: Date, timeZone?: string): string => new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(at);

/**
 * A stamp in the few characters a row has room for: the clock today, the weekday in the six days
 * before, the date before that, with its year when that is not this one.
 *
 * Worked out in the load with the clock of that load, like `when`, so a page that stays open says the
 * time it was drawn and never a "5m ago" that grows wrong. The zone is for tests only.
 */
export function shortWhen(iso: string, now: Date, timeZone?: string): string {
  const at = new Date(iso);
  const days = (Date.parse(dayKey(now, timeZone)) - Date.parse(dayKey(at, timeZone))) / 86_400_000;
  if (days === 0) return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  if (days > 0 && days < 7) return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(at);
  const year = (date: Date) => dayKey(date, timeZone).slice(0, 4);
  return year(at) === year(now) ? dayMonth(at, timeZone) : new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(at);
}

/**
 * The keychain entry a source's token sits under, as a person finds it in their keychain app.
 *
 * Only for sentences. A read or a write takes the plain name from `sourceEntry`, and the keychain adds
 * this data folder's tag itself, so the two always agree.
 */
export const scoutEntry = (name: string, env: Record<string, string | undefined> = process.env): string => keychainAccount(name, resolveDataDir(env));

export function scoutFor(db: DatabaseSync, now: Date = new Date()): ScoutSection {
  const rows = scoutSources(db).map((source) => {
    const form = formOf(source);
    const name = sourceEntry(source);
    return {
      id: source.id,
      label: source.label,
      form,
      values: source.config,
      enabled: source.enabled,
      createCards: source.createCards,
      autoAssess: source.autoAssess,
      schedule: scheduleChoice(source.scheduleMinutes, source.notify),
      secretName: name === null ? null : scoutEntry(name),
      checked: source.lastChecked === null ? 'Not checked yet.' : `Last checked ${when(source.lastChecked)}.`,
      checkedAt: source.lastChecked === null ? null : shortWhen(source.lastChecked, now),
      error: source.lastError,
    };
  });
  return { rows, forms: [...SOURCE_FORM_LIST] };
}

export interface ScoutAnswer {
  ok: boolean;
  // Which of the three the person asked for, so the screen prints the line that belongs to it.
  did: string;
  message: string | null;
  // The new source of an add, which "Add and check now" checks next.
  id?: number;
}

const no = (did: string, message: string): ScoutAnswer => ({ ok: false, did, message });
const yes = (did: string): ScoutAnswer => ({ ok: true, did, message: null });

export const asked = (form: FormData, name: string): string => (form.get(name)?.toString() ?? '').trim();

// The settings a form asks for, or the sentence the first empty one is refused with. The token is
// never one of them: it is read on its own and goes to the keychain, so a forgotten field cannot put
// it into the database.
export function sourceSettings(chosen: SourceForm, form: FormData): { config: Record<string, string> } | { message: string } {
  const config: Record<string, string> = {};
  for (const field of chosen.fields) {
    const value = asked(form, field.name);
    if (value === '') return { message: `A ${chosen.label} source needs the ${field.label.toLowerCase()}.` };
    config[field.name] = value;
  }
  if (chosen.system !== null) config.system = chosen.system;
  return { config };
}

/**
 * The keychain's own words about a write that failed, or null when it took the secret.
 *
 * Every failure of that module is a thrown error, and none of its messages repeats the secret, so
 * the sentence goes to the screen as it is. The one thing this may not do is build a message of its
 * own around what the tool printed, because on macOS a refused command echoes the secret.
 */
async function keep(keychain: Keychain, name: string, secret: string): Promise<string | null> {
  try {
    await keychain.write(name, secret);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'The keychain refused the token.';
  }
}

/**
 * Add, edit or remove one source.
 *
 * The form is read and refused before anything is stored, because storing the row is what makes the
 * keychain entry's name, and a keychain call can put a dialog in front of the person. An add that
 * gets its row in and then cannot store the token takes the row away again: a source with settings
 * and no token would be checked and fail every time, with nothing on the screen saying why.
 *
 * `hub` is here for the two branches that change what a scheduled check on the hub does: a save that
 * turns the checks or one of the two opt-ins off, and a remove, which has to take the schedule with
 * it. The hub is the one place the client cannot delete a row from by hand.
 */
export async function saveScoutSource(db: DatabaseSync, keychain: Keychain, form: FormData, hub: HubDeps): Promise<ScoutAnswer> {
  const did = asked(form, 'do');

  if (did === 'add') {
    const chosen = SOURCE_FORM_LIST.find((one) => one.id === asked(form, 'form'));
    if (chosen === undefined) return no(did, `There is no source ${asked(form, 'form')}. Pick one of the kinds on the list.`);
    const label = asked(form, 'label');
    if (label === '') return no(did, 'The source needs a label, so you can tell it apart from the others.');
    const read = sourceSettings(chosen, form);
    if ('message' in read) return no(did, read.message);
    const secret = asked(form, 'secret');
    if (chosen.secret !== null && secret === '') return no(did, `A ${chosen.label} source needs its ${chosen.secret}.`);

    const id = addScoutSource(db, { kind: chosen.kind, label, config: read.config });
    // The two "without asking" switches are on the Add a source dialog as well. Nothing acts on them yet.
    const createCards = asked(form, 'createCards') === 'on';
    const autoAssess = asked(form, 'autoAssess') === 'on';
    if (createCards || autoAssess) setScoutSource(db, id, { createCards, autoAssess });
    const added: ScoutAnswer = { ok: true, did, message: null, id };
    const name = sourceEntry({ id, kind: chosen.kind, config: read.config });
    if (name === null) return added;
    const refused = await keep(keychain, name, secret);
    if (refused === null) return added;
    // The entry may be there even though the write was refused, and nothing would name it once the
    // row is gone. A failed remove may not turn the refusal below into a 500.
    await keychain.remove(name).catch(() => undefined);
    removeScoutSource(db, id);
    return no(did, `The source was not added. ${refused}`);
  }

  const source = scoutSource(db, Number(asked(form, 'id')));
  if (source === null) return no(did, `There is no source ${asked(form, 'id')} on this machine.`);
  const chosen = formOf(source);

  if (did === 'save') {
    const label = asked(form, 'label');
    if (label === '') return no(did, 'The source needs a label, so you can tell it apart from the others.');
    const read = sourceSettings(chosen, form);
    if ('message' in read) return no(did, read.message);
    const enabled = asked(form, 'enabled') === 'on';
    const createCards = asked(form, 'createCards') === 'on';
    const autoAssess = asked(form, 'autoAssess') === 'on';
    setScoutSource(db, source.id, { label, config: read.config, enabled, createCards, autoAssess });
    // The three settings a scheduled check reads are on this form, and that check runs on the hub, so
    // the hub hears about them here and not at the next connect. Turning one off is what pays for the
    // frame: the hub would go on making cards for a source whose box the person has just unticked, and
    // this app holds one socket open for days, so nothing bounds that window. Only a real change sends,
    // so a label edit moves no due time up there. A frame that could not go is not resent from here.
    // The link is down in that case, and `registerProject` sends the row again on the next connect.
    if (enabled !== source.enabled || createCards !== source.createCards || autoAssess !== source.autoAssess) {
      sendScoutSchedule({ ...source, enabled, createCards, autoAssess }, hub);
    }
    // The marker belongs to the settings it was read with. Another index or another query names other
    // rows, and a marker left from the old ones can leave the source answering nothing for good. The
    // price of clearing it is that the rows it already read are read once more and counted again.
    if (JSON.stringify(read.config) !== JSON.stringify(source.config)) clearScoutCursor(db, source.id);
    // The entry is named by the project, so it is worked out from the settings before and after.
    const before = sourceEntry(source);
    const after = sourceEntry({ ...source, config: read.config });
    if (after === null) return yes(did);
    const secret = asked(form, 'secret');
    if (secret !== '') {
      const refused = await keep(keychain, after, secret);
      if (refused !== null) return no(did, `The settings are saved. The token is not. ${refused}`);
      // The older entries go once the new one is in, so no copy of the old token stays behind. A
      // removal that fails leaves a stray copy and not a broken source, so the save still worked.
      for (const old of [before, scoutSecretName(source.id)]) {
        if (old !== null && old !== after) await keychain.remove(old).catch(() => undefined);
      }
      return yes(did);
    }
    // An empty token field leaves the stored one alone, so a change of one setting does not ask the
    // person to paste their token again. A new project renames the entry, so the token moves with it.
    if (before === after) return yes(did);
    let held: string | null;
    try {
      held = await sourceSecret(keychain, source);
    } catch (error) {
      return no(did, `The settings are saved. The token did not move to its new name, so paste it again. ${error instanceof Error ? error.message : ''}`.trim());
    }
    if (held === null) return yes(did);
    const refused = await keep(keychain, after, held);
    if (refused !== null) return no(did, `The settings are saved. The token did not move to its new name, so paste it again. ${refused}`);
    if (before !== null) await keychain.remove(before).catch(() => undefined);
    return yes(did);
  }

  if (did === 'remove') {
    // The entry goes first. A row removed before it would leave a secret behind with nothing on any
    // screen naming it. The old `scout-<id>` name goes as well, for a source whose token was never
    // read since it got its new name, and before the new one, so a refusal there removed nothing.
    const name = sourceEntry(source);
    if (name !== null) {
      try {
        await keychain.remove(scoutSecretName(source.id));
        await keychain.remove(name);
      } catch (error) {
        return no(did, `Nothing was removed. ${error instanceof Error ? error.message : 'The keychain refused.'}`);
      }
    }
    // The hub keeps one schedule row per source id, and `scout_sources.id` is an INTEGER PRIMARY KEY
    // with no AUTOINCREMENT, so sqlite hands a freed id to the next source added. A schedule left
    // behind would then run against a source the person never scheduled, and no screen could turn it
    // off. So the 0 goes out before the row does, and the word says it when it could not.
    // A removed source is one whose checks are off for good, so its stop is the frame a source with
    // its checks off sends.
    const cancelled = sendScoutSchedule({ ...source, enabled: false }, hub);
    removeScoutSource(db, source.id);
    return cancelled ? yes(did) : yes('remove-here');
  }

  return no(did, `There is nothing called ${did} to do to a source. This screen can add a source, save its settings or remove it.`);
}

/** What one check did, as the screen prints it. One of the two is a sentence and the other is null. */
export interface ScoutCheckAnswer {
  ok: boolean;
  checked: string | null;
  message: string | null;
}

export const count = (many: number, one: string, more: string): string => `${many} ${many === 1 ? one : more}`;

// The zero-width characters come out before the box is called empty, the way the paste adapter takes
// them out of every line. A paste of nothing but invisible characters reads as empty there, so the
// check would find nothing, stamp the source and answer that Scout has read that text before.
const blank = (text: string): boolean => text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '') === '';
const EMPTY_BOX: ScoutCheckAnswer = { ok: false, checked: null, message: 'Paste the log or the errors into the box first. It is empty.' };

// The label of the source the first visit's paste box makes.
const FIRST_PASTE_LABEL = 'Pasted logs';

/**
 * The first visit's paste box: the text checked with the project's pasted text source, which is made
 * here when there is none.
 *
 * The empty box is refused before anything is made, so a press on it leaves no source behind and the
 * page stays on the first visit.
 */
export function checkFirstPaste(db: DatabaseSync, form: FormData): ScoutCheckAnswer {
  const text = asked(form, 'text');
  if (blank(text)) return EMPTY_BOX;
  const id = scoutSources(db).find((one) => one.kind === 'paste')?.id ?? addScoutSource(db, { kind: 'paste', label: FIRST_PASTE_LABEL });
  const post = new FormData();
  post.set('id', String(id));
  post.set('text', text);
  return checkScoutSource(db, post);
}

/**
 * Check one pasted source with the text that came with the post.
 *
 * The paste as a whole is stored nowhere: `checkPasteSource` writes the lines it found and a digest of
 * the text, so a line that became a finding is kept and the paste around it is not. This path builds
 * no keychain either, because a pasted source holds no credential and a keychain call can put an OS
 * password dialog on the screen.
 *
 * The empty box is refused here and not below. `checkPasteSource` reads an empty text happily, finds
 * nothing and still stamps the check, so the source would claim it was checked when nothing was read.
 */
export function checkScoutSource(db: DatabaseSync, form: FormData): ScoutCheckAnswer {
  const text = asked(form, 'text');
  if (blank(text)) return EMPTY_BOX;

  const answer = checkPasteSource(db, Number(asked(form, 'id')), text);
  if (answer.error !== null) return { ok: false, checked: null, message: answer.error };
  // Nothing new and nothing met again means this exact text was read before, which is what the cursor
  // is for. "0 new" there reads as a failure, so it gets its own sentence.
  if (answer.added === 0 && answer.met === 0 && answer.muted === 0)
    return { ok: true, checked: 'Scout has read that text before, so no finding changed.', message: null };

  return { ok: true, checked: checkedSentence(answer), message: null };
}

/**
 * The numbers one check changed, as one sentence.
 *
 * Shared by every adapter's check, because "met" on one screen and "seen again" on the other have
 * drifted apart once already. A second builder would let the two drift apart again. What a check with
 * no numbers at all says is the caller's own, because a paste that carried nothing was read before and
 * a query that answered nothing is a different thing.
 */
export function checkedSentence(answer: ScoutCheck): string {
  const parts: string[] = [];
  if (answer.added > 0) parts.push(count(answer.added, 'new finding', 'new findings'));
  if (answer.met > 0) parts.push(`${count(answer.met, 'finding', 'findings')} seen again`);
  // Its own clause, because a muted finding was met and nothing on the list moved. Without it a
  // paste of muted lines only would answer that Scout had read that text before, which is not true.
  if (answer.muted > 0) parts.push(`${count(answer.muted, 'finding', 'findings')} left muted`);
  // A check that only met muted findings changed no row on the list, so sending the person to the list
  // would send them to a screen that looks exactly as they left it. The Muted fold is where the change is.
  const where = answer.added === 0 && answer.met === 0 ? ' Nothing on the list changed. The muted ones are under Muted.' : '';
  return `Checked. ${parts.join(', and ')}.${where}`;
}

export interface HubDeps {
  // The project this machine is registered as on Nolzu cloud, or null while it is registered nowhere.
  // A schedule frame names a project, so null is what keeps it on this machine.
  projectId: string | null;
  // How the frame goes out, so a test drives this with no socket.
  send: (schedule: ScoutSchedule) => boolean;
}

export interface ScheduleDeps extends HubDeps {
  // Whether this account's plan runs scheduled checks. Read from the signed display document, and
  // asked again here because a screen that draws the control disabled is not what stops a post.
  allowed: boolean;
}

/**
 * What one schedule save did, with the word the screen prints under the section.
 *
 * The word is chosen here and not in the route, so one test pins all three. There are three because
 * a frame that did not go means the opposite thing for a schedule and for a stop: the hub runs
 * neither the new schedule nor, after a stop it never heard, nothing at all.
 */
export interface ScheduleAnswer {
  ok: boolean;
  did: string;
  message: string | null;
}

/**
 * Tell the hub what a scheduled check of this source may do now, and answer whether the frame went.
 *
 * The frame is a copy of the row, the way `registerProject` in `hub-link.ts` builds it: a source whose
 * checks the person turned off sends a 0, and that 0 is what deletes the hub's row and its due entry.
 * So a stop is this same frame with the checks off, and there is one builder and not two.
 *
 * True when there was nothing to tell: a source with no stored schedule, and a machine registered
 * nowhere. Neither of the two has a row on the hub for any of these settings to act on.
 */
function sendScoutSchedule(source: ScoutSource, hub: HubDeps): boolean {
  if (source.scheduleMinutes === 0 || hub.projectId === null) return true;
  const on = source.enabled;
  return hub.send({
    projectId: hub.projectId,
    sourceId: source.id,
    intervalMinutes: on ? source.scheduleMinutes : 0,
    notify: on && source.notify,
    createCards: source.createCards,
    autoAssess: source.autoAssess,
  });
}

/**
 * Store one source's schedule, and tell the hub.
 *
 * The row is the truth on this machine, so it is written first and the frame is a copy of it. A frame
 * that could not go is not held for a retry here, and the answer says so, so the person is never told
 * that a schedule runs when nothing can run it. The next connect sends the stored schedule again, from
 * `registerProject` in `hub-link.ts`, so a save made while the link was down still reaches the hub.
 */
export function saveScoutSchedule(db: DatabaseSync, form: FormData, deps: ScheduleDeps): ScheduleAnswer {
  const refused = (message: string): ScheduleAnswer => ({ ok: false, did: 'schedule', message });

  const source = scoutSource(db, Number(asked(form, 'id')));
  if (source === null) return refused(`There is no source ${asked(form, 'id')} on this machine.`);
  // Before the row is read for its schedule, so a Free client stores nothing and sends nothing.
  if (!deps.allowed) return refused('This machine is on the free plan, so no schedule was saved. Check now works on every plan.');
  const chosen = formOf(source);
  if (!chosen.cloud) return refused(`Nolzu cloud does not check a ${chosen.label} source, so this one takes no schedule. Check it from this machine with Check now.`);

  const read = readScheduleForm(form);
  if ('message' in read) return refused(read.message);

  setScoutSource(db, source.id, { scheduleMinutes: read.intervalMinutes, notify: read.notify });
  // A machine registered nowhere has sent the hub no schedule at all, so a stop of its own leaves
  // nothing running there and reads like any other save that stayed here.
  if (deps.projectId === null) return { ok: true, did: 'schedule-here', message: null };
  // The interval travels as it was read, so turning a schedule off sends the 0 the hub deletes its row
  // and its due entry on.
  // The two opt-ins travel from the row and not from this form, which never asks for them. The source
  // form is where they are set, and its own save sends them, so this frame only has to keep them as
  // they are rather than send a stale pair of them up.
  const sent = deps.send({
    projectId: deps.projectId,
    sourceId: source.id,
    intervalMinutes: read.intervalMinutes,
    notify: read.notify,
    createCards: source.createCards,
    autoAssess: source.autoAssess,
  });
  if (sent) return { ok: true, did: 'schedule', message: null };
  // A stop the hub never heard is not the same as a schedule the hub never heard. The hub keeps the
  // interval it already has, and it is the one place that would check on it, so the person may not
  // read that nothing is left there.
  return { ok: true, did: read.intervalMinutes === 0 ? 'schedule-off-here' : 'schedule-here', message: null };
}
