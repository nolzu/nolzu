import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { projectRepos } from '@nolzu/core';
import { cardRepos, type CardReposBy, getSetting, reposOfCard, setCardRepos } from '@nolzu/core/node';
import { checkoutPath } from '@nolzu/runner';

export interface CardRepoChoice {
  // Every repository of the project, in the project's order. `fixed` is the project folder when it
  // is a repository: every card works there, because its checkout is the card's root.
  repos: { path: string; picked: boolean; fixed: boolean }[];
  // Who set the list, or null while nobody has.
  by: CardReposBy | null;
}

const hasCard = (db: DatabaseSync, key: string) => db.prepare('SELECT 1 FROM cards WHERE key = ?').get(key) !== undefined;

// Null on a project of one repository, so its Settings tab shows nothing new.
export function cardReposFor(db: DatabaseSync, key: string): CardRepoChoice | null {
  if (!hasCard(db, key)) return null;
  const project = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') }).map((repo) => repo.path);
  if (project.length < 2) return null;
  const stored = cardRepos(db, key);
  return {
    repos: project.map((path) => ({ path, picked: path === '.' || (stored?.repos.includes(path) ?? false), fixed: path === '.' })),
    by: stored?.by ?? null,
  };
}

const answer = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The person's own list of the card's repositories, which refine and plan never replace.
 *
 * An empty list clears it, so the next refine or plan picks one again. A repository whose checkout
 * is on disk stays, because the card's work there would be left out of its changes. One added to a
 * started card gets its checkout from the next run that needs one.
 */
export async function saveCardRepos(db: DatabaseSync, key: string, request: Request): Promise<Response> {
  let asked: unknown;
  try {
    asked = ((await request.json()) as { repos?: unknown } | null)?.repos;
  } catch {
    asked = undefined;
  }
  if (!Array.isArray(asked) || !asked.every((repo) => typeof repo === 'string')) return answer(400, { message: 'Send the repositories as a list of folder names.' });
  if (!hasCard(db, key)) return answer(404, { message: `There is no card ${key}, so it has no repositories to set.` });

  const project = getSetting(db, 'projectPath');
  const kept =
    project === null
      ? undefined
      : (reposOfCard(db, key) ?? []).find((repo) => repo !== '.' && !asked.includes(repo) && existsSync(join(checkoutPath(project, key, repo), '.git')));
  if (kept !== undefined) return answer(400, { message: `${key} has a checkout of ${kept} already, so ${kept} stays in its list.` });

  try {
    setCardRepos(db, key, asked, 'person');
  } catch (error) {
    // A name the project does not list, in the card store's own words.
    return answer(400, { message: (error as Error).message });
  }
  return answer(200, { ok: true });
}
