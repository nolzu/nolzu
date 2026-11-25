import { homedir } from 'node:os';
import { join } from 'node:path';
import { fail } from '@sveltejs/kit';
import { getSetting } from '@nolzu/core/node';
import { crossSiteRead } from '$lib/bin.ts';
import { database } from '$lib/db.ts';
import { loop } from '$lib/loop.ts';
import { findImports, importServers } from '$lib/mcp-import.ts';
import { deleteServer, mcpPage, saveSecret, saveServer, setPhase, testServer } from '$lib/mcp-page.ts';
import { appKeychain, commitMcpList, commitMcpListSoon, migrateQaBrowser } from '$lib/mcp-store.ts';
import { PLAYWRIGHT_FILE } from '$lib/qa-setup.ts';
import type { Actions, PageServerLoad } from './$types';

// Read off the disk on every load, because the list is the project's file and a pull can change it.
export const load: PageServerLoad = async ({ request }) => {
  const live = loop();
  // The QA browser of the old setting moves into the list here too, so a refusal shows on the page.
  // Not for another site's request, which would write the list and commit it unseen.
  const migration = crossSiteRead(request.headers.get('sec-fetch-site')) ? null : await migrateQaBrowser(live.db, live.project, appKeychain(), join(live.dataDir, PLAYWRIGHT_FILE)).catch((error: Error) => error.message);
  return mcpPage(live.db, appKeychain(), live.project, migration);
};

// Each write goes on the Now stream, because the QA browser row and the first-run setup read the list,
// and into a commit of the workspace, so teammates get it (`commitMcpList`). A refused commit keeps
// the write and says why.
const done = async (field: string, message: string | null) => {
  if (message !== null) return fail(400, { field, message });
  loop().changed();
  const unsaved = await commitMcpList(getSetting(database(), 'projectPath'));
  return unsaved === null ? { field, saved: true } : fail(400, { field, message: unsaved });
};

export const actions: Actions = {
  save: async ({ request }) => {
    const form = await request.formData();
    const message = await saveServer(database(), appKeychain(), form, loop().project);
    // The secrets typed are never sent back.
    return message === null ? await done('server', null) : fail(400, { field: 'server', message, original: form.get('original')?.toString() ?? '' });
  },
  delete: async ({ request }) => done('server', await deleteServer(database(), appKeychain(), (await request.formData()).get('name')?.toString() ?? '', loop().project)),
  phase: async ({ request }) => {
    const form = await request.formData();
    const message = setPhase(database(), form.get('name')?.toString() ?? '', form.get('phase')?.toString() ?? '', form.get('on') === 'true');
    if (message !== null) return fail(400, { field: 'grid', message });
    loop().changed();
    // One commit for a burst of clicks.
    commitMcpListSoon(getSetting(database(), 'projectPath'));
    return { field: 'grid', saved: true };
  },
  // What the person's own engine configs hold, by name and kind only: no value, argument or address
  // reaches the page.
  find: () => {
    const found = findImports(homedir(), getSetting(database(), 'projectPath'));
    return {
      field: 'import',
      found: found.map((one) => ({ key: one.key, source: one.source, name: one.entry.name, kind: one.entry.kind, env: one.entry.env.map((value) => ({ name: value.name, secret: value.secret })), headers: one.entry.headers.map((value) => value.name) })),
    };
  },
  import: async ({ request }) => {
    const form = await request.formData();
    return done('import', await importServers(database(), appKeychain(), homedir(), form.getAll('pick').map(String), form.getAll('plain').map(String), loop().project));
  },
  // Starts the server for a moment and asks for its tools. It saves nothing and commits nothing, and its
  // answer is never a refusal: a server that does not start is what the person asked to learn.
  test: async ({ request }) => ({ field: 'test', test: await testServer(database(), appKeychain(), await request.formData(), loop().project) }),
  secret: async ({ request }) => {
    const form = await request.formData();
    const name = form.get('name')?.toString() ?? '';
    const message = await saveSecret(database(), appKeychain(), name, form.get('where')?.toString() ?? '', form.get('key')?.toString() ?? '', form.get('value')?.toString() ?? '', loop().project);
    // A secret changes no file, so nothing is committed.
    if (message !== null) return fail(400, { field: `secret:${name}`, message });
    loop().changed();
    return { field: `secret:${name}`, saved: true };
  },
};
