import type { ScoutSource } from '@nolzu/core/node';
import { type ScoutSourceKind, scoutSecretName } from '@nolzu/protocol';
import type { Keychain } from '@nolzu/runner';
import { logsReadable } from './scout-search.ts';
import { sentryReadable } from './scout-sentry.ts';
import { asked, SOURCE_FORMS, type SourceForm, sourceEntry, sourceSettings } from './scout-sources.ts';
import { ticketsReadable } from './scout-tickets.ts';

/** One kind's read for the test, answering what it could read, such as "12 issues". */
export type Probe = (source: ScoutSource, keychain: Keychain) => Promise<string>;

/** The read of each kind a test can make. A pasted text source has nothing to connect to. */
export type Probes = Readonly<Record<Exclude<ScoutSourceKind, 'paste'>, Probe>>;

const PROBES: Probes = {
  tickets: (source, keychain) => ticketsReadable(source, keychain),
  sentry: (source, keychain) => sentryReadable(source, keychain),
  search: (source, keychain) => logsReadable(source, keychain),
};

export interface ConnectionAnswer {
  ok: boolean;
  // "12 issues readable", what the read found.
  readable: string | null;
  // Where it read, such as recipes-app/recipes-web.
  where: string | null;
  // How long the read took, such as 0.8s.
  took: string | null;
  message: string | null;
}

const refused = (message: string): ConnectionAnswer => ({ ok: false, readable: null, where: null, took: null, message });

// What the result line names the place by: Sentry by its organization and project, every other kind
// by its first setting, which is the repository, the project, the site, the teams or the address.
const whereOf = (form: SourceForm, config: Readonly<Record<string, string>>): string =>
  form.kind === 'sentry' ? `${config.org ?? ''}/${config.project ?? ''}` : (config[form.fields[0]?.name ?? ''] ?? '');

/**
 * Test the connection: one read with the form as the dialog holds it, before anything is stored.
 *
 * No database is handed in, so the read cannot use a saved row: the settings come from the form, and so
 * does the token when one was typed. With the token field left empty, as on a source that is open, the
 * one entry the form names is read, or the old `scout-<id>` one of an older source. The keychain handed
 * to the read answers for that entry alone and refuses every write, so the test moves nothing and
 * stores nothing. The cursor is empty, so the read is the newest page a first check would read.
 */
export async function testConnection(keychain: Keychain, form: FormData, probes: Probes = PROBES, clock: () => number = () => performance.now()): Promise<ConnectionAnswer> {
  const chosen = SOURCE_FORMS.find((one) => one.id === asked(form, 'form'));
  if (chosen === undefined) return refused(`There is no source ${asked(form, 'form')}. Pick one of the kinds on the list.`);
  if (chosen.kind === 'paste') return refused('A pasted text source has nothing to connect to. Paste a log into it and press Check now.');
  const read = sourceSettings(chosen, form);
  if ('message' in read) return refused(read.message);

  const id = Number(asked(form, 'id'));
  const source: ScoutSource = {
    id: Number.isInteger(id) && id > 0 ? id : 0,
    kind: chosen.kind,
    label: asked(form, 'label') || chosen.label,
    config: read.config,
    enabled: true,
    createCards: false,
    autoAssess: false,
    scheduleMinutes: 0,
    notify: false,
    cursor: null,
    lastChecked: null,
    lastError: null,
  };
  const typed = asked(form, 'secret');
  if (chosen.secret !== null && typed === '' && source.id === 0) return refused(`Paste the ${chosen.secret} first, so the test has something to connect with.`);

  const name = sourceEntry(source);
  const nothing = (): Promise<never> => Promise.reject(new Error('A test of the connection stores nothing.'));
  const held: Keychain = {
    read: async (asking) => {
      if (asking !== name) return null;
      if (typed !== '') return typed;
      return (await keychain.read(asking)) ?? (await keychain.read(scoutSecretName(source.id)));
    },
    write: nothing,
    remove: nothing,
  };

  const start = clock();
  try {
    const said = await probes[chosen.kind](source, held);
    return { ok: true, readable: `${said} readable`, where: whereOf(chosen, read.config), took: `${((clock() - start) / 1000).toFixed(1)}s`, message: null };
  } catch (error) {
    return refused(error instanceof Error ? error.message : 'The read failed and gave no reason.');
  }
}
