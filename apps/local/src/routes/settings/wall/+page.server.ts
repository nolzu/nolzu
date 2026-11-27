import { gitWallLine, gitWallReady, wallGroups, wallHere } from '@nolzu/runner';
import type { PageServerLoad } from './$types';

// The wall's fixed rules in groups, built by the runner from the rows the wall itself is built from,
// for the system this server runs on, and whether Nolzu's own git writes inside a wall here.
export const load: PageServerLoad = () => ({ groups: wallGroups(process.platform), git: gitWallLine(gitWallReady(wallHere())) });
