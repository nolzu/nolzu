import type { DatabaseSync } from 'node:sqlite';
import { setCardStack } from '@nolzu/core/node';
import type { BoardSnapshot } from '@nolzu/protocol';
import { type AppServer, runStackHook, startApp, STACK_TIMEOUT_MS, STACK_UNLOAD_TIMEOUT_MS, stackCommand, stackStatusAfter } from '@nolzu/runner';
import type { StackAction } from '@nolzu/ui/qa';
import { cardOwn, cardStackEnv, type CardOwn, ownProblem, stackLane } from './qa-panel.ts';

/**
 * The Start, Stop and Force buttons of the app line on the card page. They act on the card's own
 * commands under Start the app, each repository in order.
 *
 * These are not runs in the phase sense. They start no agent, take no slot and finish while the
 * request is open, so they answer with the command's own words rather than leaving the person to
 * follow a board snapshot. The one thing they do read from the snapshot is the stack lane: a QA run
 * owns the app while it checks a card, and stopping that app under it would make its verdict
 * meaningless.
 *
 * Force is Stop with the state check dropped. It is what a person presses for an app an earlier run
 * left behind, one running another card's code, or one whose command never came back.
 *
 * The three words are the panel's own type, so the button a person presses and the button this
 * refuses can never drift apart. They keep the names load, unload and force on the wire.
 */
export const isStackAction = (value: unknown): value is StackAction => value === 'load' || value === 'unload' || value === 'force';

export interface StackAnswer {
  ok: boolean;
  said: string;
}

// A Start pressed by hand whose command keeps running, by card and repository, until Stop, Force, the
// start or the end of the card's next QA run, or Nolzu's shutdown (`releaseAll`). It runs in its own
// process group, so it would outlive Nolzu without that. Held in this server process only.
// Limit: a map in memory. A crash of Nolzu that skips the shutdown leaves the process running.
const held = new Map<string, AppServer>();
// The cards with a press going, so a second press of the same card, Force included, cannot race it.
// Limit: in memory, so a press that never came back before a restart leaves nothing here, and Force
// then still runs on a card stuck in starting or stopping.
const pressing = new Set<string>();
const heldId = (key: string, repo: string | null): string => `${key}\n${repo ?? ''}`;

// The cards whose Start this process ran and whose start command exited 0, such as
// `docker compose up -d`: no process is held, and what it started still runs until a Stop or Force
// that ends with the app down clears the card.
// Limit: in memory, so a restart forgets it, and Delete card then only warns from the stored state.
const started = new Set<string>();

// Whether this process holds the card's app, started it this session, or is starting or stopping it
// now. Delete card asks, so it never cuts a checkout away under a running app whose Stop would then
// have no card to act on.
export const appHeld = (key: string): boolean => pressing.has(key) || started.has(key) || [...held.keys()].some((id) => id.startsWith(`${key}\n`));

async function stopHeld(key: string, repo: string | null): Promise<void> {
  const app = held.get(heldId(key, repo));
  held.delete(heldId(key, repo));
  await app?.stop();
}

// Every process a hand Start of this card left running. QA calls it before its own start and at its end.
export async function releaseHeld(key: string): Promise<void> {
  for (const id of [...held.keys()].filter((one) => one.startsWith(`${key}\n`))) {
    const app = held.get(id);
    held.delete(id);
    await app?.stop();
  }
}

// Each own start in order. One that fails stops the rest; the ones before it stay up for Stop to take down.
async function startAll(db: DatabaseSync, key: string, owns: readonly CardOwn[], env: Record<string, string | undefined>): Promise<string | null> {
  for (const own of owns) {
    const command = stackCommand(own.answer.start, key);
    // A second Start replaces what an earlier one left running.
    await stopHeld(key, own.repo);
    try {
      // As QA runs own commands: outside the wall, and a start that exits 0 is up.
      const app = await startApp(command, { cwd: own.at ?? '', env: cardStackEnv(db, key, env), mayExit: true, timeoutMs: STACK_TIMEOUT_MS });
      if (!app.exited) held.set(heldId(key, own.repo), app);
      else started.add(key);
    } catch (error) {
      return `${command} did not start the app. ${(error as Error).message}`;
    }
  }
  return null;
}

// Every process a hand Start left running, on any card. Nolzu's shutdown awaits it.
export async function releaseAll(): Promise<void> {
  const apps = [...held.values()];
  held.clear();
  await Promise.all(apps.map((app) => app.stop()));
}

// Each own app in order: what a Start left running, then its Stop command. The sentences of the ones still up.
async function stopAll(db: DatabaseSync, key: string, owns: readonly CardOwn[], env: Record<string, string | undefined>): Promise<string[]> {
  const left: string[] = [];
  for (const own of owns) {
    const running = held.has(heldId(key, own.repo));
    await stopHeld(key, own.repo);
    if (own.answer.stop === null) {
      // Nothing held and no Stop: what the start began may still run, as QA says in the same case.
      if (!running) left.push(`No Stop command is set, so what ${stackCommand(own.answer.start, key)} started is still up.`);
      continue;
    }
    const status = await runStackHook({ load: null, unload: own.answer.stop, status: null }, 'unload', key, {
      cwd: own.at ?? '',
      env: cardStackEnv(db, key, env),
      timeoutMs: STACK_UNLOAD_TIMEOUT_MS,
    })
      .then((result) => stackStatusAfter('unload', result))
      .catch((error: Error) => ({ state: 'up' as const, reason: `The Stop command could not run: ${error.message}. The app is still up.` }));
    if (status.state === 'up') left.push(status.reason ?? '');
  }
  return left;
}

export async function pressStack(
  db: DatabaseSync,
  snapshot: Pick<BoardSnapshot, 'lanes'>,
  key: string,
  button: StackAction,
  env: Record<string, string | undefined> = process.env,
): Promise<StackAnswer> {
  const card = db.prepare('SELECT key, stack_state FROM cards WHERE key = ?').get(key) as { key: string; stack_state: string | null } | undefined;
  if (card === undefined) return { ok: false, said: `There is no card ${key} here, so there is no app to work on.` };

  const lane = stackLane(snapshot);
  if (lane !== null) {
    const whose = lane === key ? 'This card is' : `${lane} is`;
    return { ok: false, said: `${whose} running QA, which owns the app until it ends. Stop that run first.` };
  }
  // The panel draws this rule too, but it is drawn on a page load: a second tab, or a tab opened
  // before the press, still offers live buttons. Two starts over one app would fight.
  // Force is left out, the same way the panel leaves it out, because a card whose command never
  // came back is stuck in one of these two states and Force is the way out.
  if (button !== 'force' && (card.stack_state === 'loading' || card.stack_state === 'unloading')) {
    return { ok: false, said: "A start or stop of this card's app is already running. Wait for it, or press Force." };
  }

  const owns = cardOwn(db, key);
  if (owns.length === 0) {
    return { ok: false, said: 'No repository of this card has its own start commands. Add them in the QA question, or under Start the app in Settings, Project.' };
  }
  // Stop takes down what Nolzu brought up, also after a Start that failed partway and left the earlier
  // repositories up. Force is the button for everything else, so a person who wants the Stop commands
  // run anyway has one press that says so.
  if (button === 'unload' && card.stack_state !== 'up' && card.stack_state !== 'failed') {
    return { ok: false, said: 'Nolzu has started no app for this card. Press Force to run the Stop commands anyway.' };
  }
  const problem = ownProblem(owns, 'the command');
  if (problem !== null) return { ok: false, said: problem };
  if (pressing.has(key)) return { ok: false, said: "A start or stop of this card's app is already running. Wait for it." };
  pressing.add(key);
  try {
    return await press(db, key, button, owns, env);
  } finally {
    pressing.delete(key);
  }
}

async function press(db: DatabaseSync, key: string, button: StackAction, owns: readonly CardOwn[], env: Record<string, string | undefined>): Promise<StackAnswer> {

  // Said before the commands run, so a second tab on this card reads the line and not a stale one.
  if (button === 'load') {
    setCardStack(db, key, { state: 'loading', reason: null });
    // A throw here, such as a key the command will not take, would leave the card loading for good.
    const failed = await startAll(db, key, owns, env).catch((error: Error) => error.message);
    setCardStack(db, key, failed === null ? { state: 'up', reason: null } : { state: 'failed', reason: failed });
    return { ok: failed === null, said: failed ?? 'The app is up.' };
  }
  setCardStack(db, key, { state: 'unloading', reason: null });
  const left = await stopAll(db, key, owns, env).catch((error: Error) => [error.message]);
  if (left.length === 0) started.delete(key);
  setCardStack(db, key, left.length === 0 ? { state: 'off', reason: null } : { state: 'up', reason: left.join(' ') });
  return { ok: left.length === 0, said: left.length === 0 ? 'The app was stopped.' : left.join(' ') };
}
