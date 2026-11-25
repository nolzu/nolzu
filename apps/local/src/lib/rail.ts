import { BOARD_KINDS, type BoardChoice, type BoardKind, type BoardSnapshot, type CardView, choiceLabel, choiceOf, choicesOf, type EngineProfile, LIMIT_SIGNAL, type ProfileLimit } from '@nolzu/protocol';
import { waitingOnMe } from '@nolzu/ui';
import { isBoardRoute, openCount } from './board-page.ts';

export const circle = (x: number, y: number, r: number): string => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const rect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${2 * r - w}a${r} ${r} 0 0 1 ${-r} ${-r}v${2 * r - h}a${r} ${r} 0 0 1 ${r} ${-r}Z`;

// The icons on a 24px grid, for the rail and the command palette. Research has its own icon.
// Its two kinds have none of their own, so Investigations takes Research's and Questions a
// question mark.
export const ICONS: Record<
  BoardChoice | 'now' | 'bell' | 'workspace' | 'knowledge' | 'scout' | 'evidence' | 'settings' | 'add' | 'repos' | 'lock' | 'search' | 'bolt' | 'arrow' | 'chevron' | 'theme',
  readonly string[]
> = {
  now: [circle(12, 12, 8.5), circle(12, 12, 3)],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z', 'M10 20.5a2 2 0 0 0 4 0'],
  delivery: [rect(3, 4, 5, 16, 1.5), rect(10, 4, 5, 11, 1.5), rect(17, 4, 4, 7, 1.5)],
  epics: ['M12 3 3 8l9 5 9-5-9-5Z', 'm3 13 9 5 9-5'],
  research: [circle(11, 11, 7), 'm20 20-3.5-3.5', 'M11 8v3l2 1'],
  investigations: [circle(11, 11, 7), 'm20 20-3.5-3.5', 'M11 8v3l2 1'],
  questions: [circle(12, 12, 8.5), 'M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4', 'M12 16.6v.1'],
  prreview: [circle(6, 6, 2), circle(6, 18, 2), circle(18, 18, 2), 'M6 8v8', 'M18 16V9a3 3 0 0 0-3-3h-4', 'm13 4-2 2 2 2'],
  workspace: ['M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z'],
  knowledge: ['M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15Z', 'M5 19.5A1.5 1.5 0 0 0 6.5 21H19', 'M9 7.5h6'],
  scout: [circle(12, 12, 8.5), 'M12 12l5-5', 'M12 7.5a4.5 4.5 0 1 0 4.5 4.5'],
  evidence: ['M4 20h16', 'M7 16v-5', 'M12 16V6', 'M17 16v-8'],
  settings: ['M4 7h9M17 7h3M4 17h3M11 17h9', circle(15, 7, 2), circle(9, 17, 2)],
  add: ['M12 5v14M5 12h14'],
  repos: [circle(6, 5, 2), circle(6, 19, 2), circle(18, 7, 2), 'M6 7v10', 'M18 9c0 5-6 4-11 8'],
  lock: [rect(5, 11, 14, 10, 2), 'M8 11V8a4 4 0 0 1 8 0v3'],
  search: [circle(11, 11, 7), 'm20 20-3.5-3.5'],
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7l1-8Z'],
  arrow: ['M5 12h14M13 6l6 6-6 6'],
  chevron: ['m9 6 6 6-6 6'],
  theme: [circle(12, 12, 8.5), 'M12 3.5a8.5 8.5 0 0 1 0 17Z'],
};

// Research's own page. It is no `/b/[board]` route, so the rail names it by this address.
export const RESEARCH_ROUTE = '/b/research';

// The boards that are on, in the rail's order, with Research once where its two kinds stood. The
// rail and the command palette both list these.
export const railKinds = (off: readonly BoardKind[]): BoardChoice[] => choicesOf(BOARD_KINDS.filter((kind) => kind === 'delivery' || !off.includes(kind)));

// The boards the rail links: Delivery first, then every board that is on, with one Research item where
// its two kinds stood. The one open is marked: the board of a board page, Research on its list, or on a
// card page the board the card is on. Only one: Delivery used to be
// marked on every board route. A board the project turned off is left out, and its address says it is off.
export function railBoards(
  routeId: string | null,
  board: string | undefined,
  cardBoard: BoardKind | null,
  off: readonly BoardKind[] = [],
): { kind: BoardChoice; label: string; current: boolean }[] {
  const open = cardBoard !== null ? choiceOf(cardBoard) : routeId === RESEARCH_ROUTE ? 'research' : isBoardRoute(routeId) ? board : undefined;
  return railKinds(off).map((kind) => ({ kind, label: choiceLabel(kind), current: open === kind }));
}

// The count after each board in the rail, off the snapshots the Now stream carries and never off a
// click, so it is live on every page. Research is one item for its two kinds, so it counts both. No
// stream answer yet, no number.
export function railCounts(boards: readonly BoardSnapshot[] | null): Partial<Record<BoardChoice, number>> {
  const counts: Partial<Record<BoardChoice, number>> = {};
  for (const board of boards ?? []) {
    const kind = choiceOf(board.kind);
    counts[kind] = (counts[kind] ?? 0) + openCount(board);
  }
  return counts;
}

// The repositories by folder. A project of one repository lists it as `.`, the project folder, which
// a person knows by the project's name.
export const repoNames = (repos: readonly { path: string }[], project: string): string[] => repos.map((repo) => (repo.path === '.' ? project : repo.path));

export const repoLine = (count: number): string => (count === 0 ? 'No repository yet' : `${count} ${count === 1 ? 'repository' : 'repositories'}`);

// One project in the selector. The counts come off the project's own boards. They are null for a
// project whose boards could not be read.
export interface ProjectChoice {
  id: number;
  name: string;
  repos: number;
  waiting: number | null;
  running: number | null;
  current: boolean;
}

// How busy a project is, off its board snapshots and never off a click: the cards waiting on the person,
// counted as Now counts them, and the cards an agent runs.
export function busyOf(boards: readonly { cards: readonly Pick<CardView, 'state' | 'finished'>[] }[]): { waiting: number; running: number } {
  const cards = boards.flatMap((board) => board.cards);
  return { waiting: cards.filter(waitingOnMe).length, running: cards.filter((card) => card.state === 'running').length };
}

// The selector's rows, the busiest first: the most cards waiting, then the most running, then the order
// the projects were made. The current project counts off the live Now stream, so its number is the Now
// count beside it. Every other project keeps what the page load read, and one whose loop could not
// open keeps no count.
export function selectorRows(choices: readonly ProjectChoice[] = [], live: Parameters<typeof busyOf>[0] | null = null): ProjectChoice[] {
  const rows = choices.map((one) => (one.current && one.waiting !== null && live !== null ? { ...one, ...busyOf(live) } : one));
  return rows.sort((a, b) => (b.waiting ?? 0) - (a.waiting ?? 0) || (b.running ?? 0) - (a.running ?? 0) || a.id - b.id);
}

// "2 repositories · 2 running" under a project's name.
export const projectLine = (one: Pick<ProjectChoice, 'repos' | 'running'>): string =>
  one.running !== null && one.running > 0 ? `${repoLine(one.repos)} · ${one.running} running` : repoLine(one.repos);

// The project's folder as the selector shows it, with the home folder as ~.
export { homePath } from './home-path.ts';

// What the rail foot shows of the engine's usage window. Strings, because the server formats them in
// the machine's own time zone, which is the browser's too.
export interface RailUsage {
  label: string;
  // Percent of the five-hour window used. Above 100 when the account is over it.
  share: number;
  resets: string | null;
  seen: string;
}

const when = (ms: number, timeZone?: string) => new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

// The five-hour window of the first profile, as its engine last reported it. The first profile is the
// one a step with no profile of its own runs on, so the caller hands in `projectProfiles`. Null when
// nothing was seen, so the foot shows no number it does not have. The seen time goes with the number,
// because it is the last one seen and not a live one.
//
// Limit: one profile. Show a row per profile when people run work on two logins at once.
export function railUsage(profiles: readonly EngineProfile[], limits: Readonly<Record<string, ProfileLimit>>, timeZone?: string): RailUsage | null {
  const profile = profiles[0];
  if (profile === undefined || LIMIT_SIGNAL[profile.vendor].knownSilent) return null;
  const seen = limits[profile.id];
  const window = seen?.windows.find((one) => one.name === 'five_hour');
  if (seen === undefined || window === undefined || window.used === null) return null;
  return {
    label: profile.label,
    share: Math.round(window.used * 100),
    resets: window.resetsAt === null ? null : when(window.resetsAt * 1000, timeZone),
    seen: when(seen.seenAt, timeZone),
  };
}
