import { registeredProjects } from '@nolzu/core/node';
import { projectName } from './app-header.ts';
import { chosenProject, database } from './db.ts';
import { loop } from './loop.ts';
import { boardsOn } from './now-snapshot.ts';
import { listedRepos } from './projects.ts';
import { busyOf, type ProjectChoice } from './rail.ts';

/**
 * Every project the selector lists, each counting off its own boards. Every plan holds as many
 * projects as the person makes. A project with no folder yet belongs to New project
 * and not to the selector.
 *
 * Limit: a page load opens every project's loop and reads its boards. Only the current project
 * counts live off the Now stream (`selectorRows`), the others keep these counts until the next load.
 */
// The projects the selector already warned about.
const warned = new Set<number>();

export function projectChoices(env: NodeJS.ProcessEnv = process.env): ProjectChoice[] {
  const current = chosenProject(database()).id;
  return registeredProjects(database()).flatMap(({ id }) => {
    // A project that cannot open, such as one whose database is damaged, is listed by its number with no
    // counts and a warning in the log, so it costs the page nothing. Picking it is refused with the
    // reason. One that opens and whose boards cannot be read keeps its name and has no counts.
    // Once per project for the life of the server: the selector is read on every page load.
    const warn = (error: unknown) => {
      if (warned.has(id)) return;
      warned.add(id);
      console.warn(`Project ${id} could not be read for the project selector: ${(error as Error).message}`);
    };
    let name: string | null;
    let repos: number;
    try {
      const db = database(id);
      name = projectName(db);
      repos = listedRepos(db).length;
    } catch (error) {
      warn(error);
      return [{ id, name: `Project ${id}`, repos: 0, waiting: null, running: null, current: id === current }];
    }
    if (name === null) return [];
    let busy: { waiting: number | null; running: number | null } = { waiting: null, running: null };
    try {
      busy = busyOf(boardsOn(loop(env, id)));
    } catch (error) {
      warn(error);
    }
    return [{ id, name, repos, ...busy, current: id === current }];
  });
}
