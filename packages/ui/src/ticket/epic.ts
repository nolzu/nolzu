import { type BoardSnapshot, localKey, matchPlan } from '@nolzu/protocol';
import { cardPill, type Pill } from '../board/quiet.ts';

// One row of an epic's task table: a task on Delivery with its live state, or a task of the plan not
// added yet, whose key the person can still change.
export type TaskRow = { key: string; title: string; added: true; pill: Pill } | { key: string; title: string; added: false };

export interface TaskInput {
  // The steps of the epic's plan, in order. Each one is a task.
  planned: readonly string[];
  // The Delivery cards linked to the epic, as the server read them, oldest first, each with the plan
  // step it was made from when the link kept one.
  linked: readonly { key: string; title: string; done: boolean; step?: string }[];
  // The live Delivery board, or null before its first snapshot.
  delivery: Pick<BoardSnapshot, 'stages' | 'cards'> | null;
  // The key the next local card gets, which the first task not added yet proposes.
  nextKey: string | null;
  now?: Date;
}

const DONE: Pill = { state: 'ready', word: 'Done', detail: null };
// What a task does in its stage, after the stage name. The pill's colour says the same, and a word goes
// with it so the state never rests on a colour.
const DOING: Partial<Record<Pill['state'], string>> = { queued: 'queued', blocked: 'asks you', failed: 'failed', ready: 'ready' };

// A task's state, read off the Delivery snapshot as the board card reads it.
function livePill(task: TaskInput['linked'][number], delivery: TaskInput['delivery'], now: Date | undefined): Pill {
  const card = delivery?.cards.find((one) => one.key === task.key);
  if (delivery === null || card === undefined) return task.done ? DONE : { state: 'idle', word: 'Open', detail: null };
  const stage = delivery.stages.find((one) => one.id === card.stage);
  if (stage?.role === 'archive') return DONE;
  const pill = cardPill(card, null, now);
  return { state: pill.state, word: stage?.label ?? card.stage, detail: pill.state === 'running' ? pill.detail : (DOING[pill.state] ?? null) };
}

/**
 * The live-state join of an epic's task table: each task of the plan in plan order, matched by its title
 * to the Delivery card it became, then every linked task the plan does not name. A task with no card yet
 * proposes a key, counted up from the next local key past every key Delivery holds.
 *
 * A task is matched by the step its link kept, and by its title when the link kept none. A plan row
 * not added yet sits at its step's place in `planned`, so the page reads the step's body by that index.
 */
export function epicTaskRows({ planned, linked, delivery, nextKey, now }: TaskInput): TaskRow[] {
  const used = new Set<string>();
  const taken = new Set([...linked.map((one) => one.key), ...(delivery?.cards.map((one) => one.key) ?? [])]);
  const counter = nextKey === null ? null : /^(.+)-(\d+)$/.exec(nextKey);
  let n = Number(counter?.[2] ?? 0);
  const propose = (): string => {
    if (counter === null) return '';
    while (taken.has(localKey(counter[1] ?? '', n))) n += 1;
    const key = localKey(counter[1] ?? '', n);
    taken.add(key);
    return key;
  };
  const added = (task: TaskInput['linked'][number]): TaskRow => {
    used.add(task.key);
    return { key: task.key, title: task.title, added: true, pill: livePill(task, delivery, now) };
  };
  const rows = matchPlan(planned, linked).map((task, at): TaskRow => (task === null ? { key: propose(), title: planned[at] ?? '', added: false } : added(task)));
  return [...rows, ...linked.filter((one) => !used.has(one.key)).map(added)];
}

export type ProgressTone = 'done' | 'running' | 'waiting' | 'new';

export interface EpicProgress {
  done: number;
  total: number;
  // The legend under the bar, a word with every colour, and one bar part per task in the same order.
  legend: { tone: ProgressTone; text: string }[];
  bar: ProgressTone[];
  foot: string;
}

const TONES: readonly ProgressTone[] = ['done', 'running', 'waiting', 'new'];
const isDone = (row: TaskRow): boolean => row.added && row.pill.state === 'ready' && row.pill.word === DONE.word && row.pill.detail === null;

/**
 * The Progress panel of an epic's overview, read off the task rows, so it never says other than
 * the table: done, running with each key and stage, waiting by stage, and not added yet.
 */
export function epicProgress(rows: readonly TaskRow[]): EpicProgress {
  const tone = (row: TaskRow): ProgressTone => (!row.added ? 'new' : isDone(row) ? 'done' : row.pill.state === 'running' ? 'running' : 'waiting');
  const of = (want: ProgressTone) => rows.filter((row) => tone(row) === want);
  const done = of('done').length;
  const running = of('running');
  const waiting = new Map<string, number>();
  const stage = (row: TaskRow): string => (row.added ? (row.pill.word ?? row.pill.state) : '');
  for (const row of of('waiting')) waiting.set(stage(row), (waiting.get(stage(row)) ?? 0) + 1);
  const legend = [
    ...(done === 0 ? [] : [{ tone: 'done' as const, text: `${done} done` }]),
    ...(running.length === 0 ? [] : [{ tone: 'running' as const, text: `${running.length} running, ${running.map((row) => `${row.key} in ${stage(row)}`).join(', ')}` }]),
    ...[...waiting].map(([stage, n]) => ({ tone: 'waiting' as const, text: `${n} in ${stage}` })),
    ...(of('new').length === 0 ? [] : [{ tone: 'new' as const, text: `${of('new').length} not added yet` }]),
  ];
  return {
    done,
    total: rows.length,
    legend,
    bar: TONES.flatMap((one) => of(one).map(() => one)),
    // The epic does not move on by itself, because Wrap-up starts an agent.
    foot: done === rows.length ? 'Every task is done. Move the epic to Wrap-up.' : `Wrap-up opens when all ${rows.length} are done.`,
  };
}

/**
 * The line beside Add N tasks to Delivery: where the tasks land, counted by kind, local or a ticket of
 * the project's system named by its keys, and that nothing starts. A linked task is only read, so the
 * line says nothing is written to that system.
 */
export function landLine(linked: readonly (string | null)[], system: string | null): string {
  const keys = linked.filter((key): key is string => key !== null);
  const local = linked.length - keys.length;
  const asLocal = (count: number) => (count === 1 ? 'a local ticket' : 'local tickets');
  const asLinked = (count: number) => (count === 1 ? `a ${system} ${ticketWord(system)}` : `${system} ${ticketWord(system)}s`);
  if (keys.length === 0) return `${local === 1 ? 'It lands' : 'They land'} in Inbox as ${asLocal(local)}. Nothing starts.`;
  const tail = `Nothing starts, and nothing is written to ${system}.`;
  if (local === 0) return `${keys.length === 1 ? 'It lands' : 'They land'} in Inbox as ${asLinked(keys.length)}. ${tail}`;
  return `${local} ${local === 1 ? 'lands' : 'land'} in Inbox as ${asLocal(local)}, ${keys.length} as ${asLinked(keys.length)} (${keys.join(', ')}). ${tail}`;
}

// What one item of a ticket system is called: an issue on GitHub, a ticket elsewhere.
export const ticketWord = (system: string | null): string => (system === 'GitHub' ? 'issue' : 'ticket');

