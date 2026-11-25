import { json } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { loop } from '$lib/loop.ts';
import { systemLoginItem, turnOffAtLogin, turnOnAtLogin } from '$lib/start-at-login.ts';
import type { RequestHandler } from './$types';

// Turn on under "Start Nolzu when you log in?" in the rail posts `{}`, and the switch in Settings
// posts `{ on }`. A press is the consent, so this is the only place the login item is made or removed.
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { on?: unknown } | null;
  if (body?.on === false) {
    const refused = await turnOffAtLogin();
    return refused === null ? json({ ok: true }) : json({ message: refused }, { status: 500 });
  }
  const refused = await turnOnAtLogin(database(), systemLoginItem());
  if (refused !== null) return json({ message: refused }, { status: 422 });
  // The rail reads the offer off the Now stream, so it goes in every open tab.
  loop().changed();
  return json({ ok: true });
};
