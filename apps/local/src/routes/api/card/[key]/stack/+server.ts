import { database } from '$lib/db.ts';
import { loop } from '$lib/loop.ts';
import { isStackAction, pressStack } from '$lib/stack-action.ts';
import type { RequestHandler } from './$types';

// The app line's three buttons, Start, Stop and Force: { action: "load" | "unload" | "force" }. The answer carries the
// command's own sentence, which the panel shows whether it worked or not.
export const POST: RequestHandler = async ({ params, request }) => {
  const asked = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (!isStackAction(asked.action)) {
    return new Response(JSON.stringify({ ok: false, said: 'An app action is load, unload or force.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const answer = await pressStack(database(), loop().snapshot(), params.key, asked.action);
  return new Response(JSON.stringify(answer), { status: answer.ok ? 200 : 409, headers: { 'content-type': 'application/json' } });
};
