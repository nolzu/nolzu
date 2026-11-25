/**
 * What Delete card says before it deletes, pure: the refusal, what goes, and the warnings the person
 * reads first. `delete-card.ts` reads the facts from the database and git, and both the confirm and
 * the delete itself take their sentences from here, so the two never disagree.
 */

// The card's own branch in one repository: the name Nolzu gave the card, never whatever the checkout
// happens to be on, and never the base. `ahead` is its commits not in the base, `unpushed` those of
// them on no remote branch as this clone last fetched. Null when git could not count them.
export interface DeleteBranch {
  name: string;
  ahead: number | null;
  unpushed: number | null;
}

// One repository of the card: its checkout, when there is one, and the card's branch there.
export interface DeleteRepo {
  // "." for the project folder, or the folder name of a repository inside it.
  repo: string;
  // The base branch, which is never deleted.
  base: string;
  checkout: boolean;
  // Files git shows as changed or new in the checkout.
  changed: number;
  // Files git ignores in the checkout that a removal deletes too, such as .env, leaving out the
  // dependency and build folders tools make again. Null when git could not list them.
  ignored: string[] | null;
  // The first such folder left out, such as dist/, which the clean line names. Null when none was.
  remade?: string | null;
  // Commits of what the checkout has out that are on no remote and not in the base.
  unpushed: number | null;
  branch: DeleteBranch | null;
  // Why the checkout cannot be removed even with force, such as commits no branch holds. Then nothing
  // is deleted.
  stuck: string | null;
}

export interface DeleteFacts {
  key: string;
  // A run of the card is queued or going, and which.
  running: 'queued' | 'running' | null;
  // This process holds the card's app, or is starting or stopping it now.
  appHeld: boolean;
  // The card's app state says it may run (up, starting, stopping or failed partway) while nothing is
  // held. The state outlives a restart and often nothing can reset it, so it warns and does not refuse.
  appState: boolean;
  // Where a ticket card came from (github, github-pr, jira, ...), null for a local card.
  source: string | null;
  // The Delivery tasks of an epic, and the epic of a task.
  tasks: string[];
  epic: string | null;
  repos: DeleteRepo[];
}

// One line of the confirm. `loses` marks a line about something that cannot come back, which the
// confirm draws on the red tint.
export interface DeleteWarning {
  text: string;
  loses: boolean;
}

export interface DeletePlan {
  refused: string | null;
  goes: string;
  // What the person loses or keeps, in the order the confirm draws them.
  warnings: DeleteWarning[];
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const where = (repo: string): string => (repo === '.' ? 'the project folder' : repo);
const names = (keys: readonly string[]): string => (keys.length < 2 ? (keys[0] ?? '') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1) ?? ''}`);

// The ticket system by the card's source, as a person names it.
const SYSTEMS: Readonly<Record<string, string>> = { github: 'GitHub', 'github-pr': 'GitHub', jira: 'Jira', gitlab: 'GitLab', linear: 'Linear' };

// How many ignored paths the confirm names before it counts the rest.
const IGNORED_NAMED = 3;

// The card's branch goes only when every commit on it is in the base. A commit on a remote branch is
// not enough: the clone's remote branches are what it last fetched, and that branch may be gone.
export const branchGoes = (repo: DeleteRepo): boolean => repo.branch !== null && repo.branch.name !== repo.base && repo.stuck === null && repo.branch.ahead === 0;

// The line under the toast when the card folder or a branch stays: a card added later on the same key,
// such as the ticket added again by hand, reads that folder and starts on that branch.
export function pickedUp(folder: boolean, branch: boolean): string | null {
  if (!folder && !branch) return null;
  return `A card added later on this key picks up ${folder && branch ? 'this folder and its branch' : folder ? 'this folder' : 'its branch'}.`;
}

function ignoredLine(ignored: readonly string[] | null): string {
  if (ignored === null) return ' git could not list the files it ignores, and any such file goes with it.';
  if (ignored.length === 0) return '';
  const shown = ignored.slice(0, IGNORED_NAMED).join(', ');
  const more = ignored.length > IGNORED_NAMED ? `, and ${count(ignored.length - IGNORED_NAMED, 'more', 'more')}` : '';
  return ` Files git ignores go with it: ${shown}${more}.`;
}

export function deletePlan(facts: DeleteFacts): DeletePlan {
  const { key } = facts;
  const stuck = facts.repos.find((repo) => repo.stuck !== null)?.stuck ?? null;
  const refused =
    facts.running !== null
      ? `${key} has a run ${facts.running === 'queued' ? 'in the queue' : 'going'}. Stop the run first, then delete the card.`
      : facts.appHeld
        ? `${key} has its app started. Stop the app first, then delete the card.`
        : stuck;
  const warnings: DeleteWarning[] = [];
  if (facts.appState && !facts.appHeld) warnings.push({ text: 'Its app may still be running from an earlier start. Nolzu holds no process for it, so stop it yourself if it is.', loses: true });
  for (const repo of facts.repos) {
    if (repo.checkout && repo.stuck === null) {
      const removed = `The checkout of ${where(repo.repo)} is removed.`;
      const parts = [repo.changed > 0 ? count(repo.changed, 'changed file', 'changed files') : '', (repo.unpushed ?? 0) > 0 ? count(repo.unpushed ?? 0, 'commit not pushed', 'commits not pushed') : ''].filter((part) => part !== '');
      const has = parts.length === 0 ? '' : ` It has ${parts.join(' and ')}.`;
      // Commits stay reachable only while a branch holds them, which the branch line says. Changed
      // files and ignored files go with the folder.
      const lost = `${repo.changed > 0 ? ' The changed files are lost.' : ''}${ignoredLine(repo.ignored)}`;
      const leftOut = repo.remade == null ? '' : `, leaving out build folders such as ${repo.remade}`;
      warnings.push(lost === '' ? { text: `${removed}${has} git shows nothing in it that is not committed${leftOut}.`, loses: false } : { text: `${removed}${has}${lost}`, loses: true });
    }
    const branch = repo.branch;
    if (branch === null || branch.name === repo.base) continue;
    if (branchGoes(repo)) warnings.push({ text: `The branch ${branch.name} is deleted, since it is merged into ${repo.base}.`, loses: false });
    else if (branch.ahead !== null && branch.unpushed === 0) warnings.push({ text: `The branch ${branch.name} stays. Its commits are on the remote as this clone last fetched it, but not in ${repo.base}.`, loses: false });
    else warnings.push({ text: `The branch ${branch.name} stays, so its commits are not lost.`, loses: false });
  }
  if (facts.source !== null) {
    const system = SYSTEMS[facts.source] ?? 'the ticket system';
    warnings.push({ text: `${key} is deleted in Nolzu only, never in ${system}. The next read of ${system} does not bring it back.`, loses: false });
  }
  if (facts.tasks.length > 0) {
    const one = facts.tasks.length === 1;
    warnings.push({
      text: `${one ? 'Its task' : 'Its tasks'} ${names(facts.tasks)} ${one ? 'stays' : 'stay'} on the Delivery board as ${one ? 'an ordinary card' : 'ordinary cards'}, with no epic, and ${one ? 'stops' : 'stop'} reading the epic's documents.`,
      loses: false,
    });
  }
  if (facts.epic !== null) warnings.push({ text: `It leaves the epic ${facts.epic}.`, loses: false });
  return { refused, goes: `This deletes ${key}, its runs, its discussion and its history on the board. The time and cost of its runs stay in the timesheet.`, warnings };
}

// What the confirm showed for one checkout, sent back with the delete.
export interface SeenCheckout {
  repo: string;
  changed: number;
  unpushed: number;
  ignored: number;
}

export const seenOf = (repos: readonly DeleteRepo[]): SeenCheckout[] =>
  repos.filter((repo) => repo.checkout).map((repo) => ({ repo: repo.repo, changed: repo.changed, unpushed: repo.unpushed ?? 0, ignored: repo.ignored?.length ?? 0 }));

/**
 * Whether the checkouts hold more to lose than the confirm showed: more changed files, commits not
 * pushed or ignored files, or a checkout the confirm did not show at all. A delete is then refused, so
 * work made after the confirm opened is never removed unseen.
 */
export function changedSince(repos: readonly DeleteRepo[], seen: readonly SeenCheckout[]): boolean {
  return repos.some((repo) => {
    if (!repo.checkout) return false;
    const shown = seen.find((one) => one.repo === repo.repo);
    if (shown === undefined) return true;
    return repo.changed > shown.changed || (repo.unpushed ?? 0) > shown.unpushed || (repo.ignored?.length ?? 0) > shown.ignored;
  });
}

// In the runner now, because removing a closed card's checkout and a repository ask the same question.
export { ignoredPaths } from '@nolzu/runner';
