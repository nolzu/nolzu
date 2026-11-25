import { fail } from '@sveltejs/kit';
import { getSetting, resolveDataDir } from '@nolzu/core/node';
import { createKeychain, runKeychain } from '@nolzu/runner';
import { database } from '$lib/db.ts';
import { ghLogin } from '$lib/new-project.ts';
import { checkKeyClash, connectJira, disconnectJira } from '$lib/ticket-system.ts';
import type { Actions, PageServerLoad } from './$types';

const keychain = () => createKeychain(process.platform, runKeychain, resolveDataDir(process.env));

// The machine's logins to outside services. The gh look is not awaited, because it runs a command and
// the page draws without it. The Jira token never comes here: the page only says the keychain has one.
export const load: PageServerLoad = () => ({
  gh: ghLogin(),
  jira: { site: getSetting(database(), 'jiraSite'), email: getSetting(database(), 'jiraEmail') },
});

export const actions: Actions = {
  // Connect and Edit post the same three fields. A refusal sends back the site and the email for the
  // boxes and never the token. The open project is asked about its key prefix once Jira is connected.
  jira: async ({ request }) => {
    const form = await request.formData();
    const value = (name: string) => form.get(name)?.toString() ?? '';
    const asked = { site: value('site'), email: value('email'), token: value('token') };
    const message = await connectJira(database(), keychain(), asked);
    if (message !== null) return fail(400, { field: 'jira', message, site: asked.site, email: asked.email });
    await checkKeyClash(database(), keychain());
    return { field: 'jira', saved: true };
  },
  disconnect: async () => {
    const message = await disconnectJira(database(), keychain());
    return message === null ? { field: 'disconnect', saved: true } : fail(400, { field: 'disconnect', message });
  },
};
