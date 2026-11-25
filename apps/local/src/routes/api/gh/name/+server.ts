import { json } from '@sveltejs/kit';
import { ghRunner, repoNameProblem } from '@nolzu/runner';
import type { RequestHandler } from './$types';

// The idea page asks this while a repository name is typed, so "Available" shows before the press.
// `repoNameProblem` checks both values before gh sees them, and only reads.
export const GET: RequestHandler = async ({ url }) => {
  try {
    return json({ problem: await repoNameProblem(url.searchParams.get('owner') ?? '', url.searchParams.get('name') ?? '', ghRunner()) });
  } catch (error) {
    // A gh that is missing, signed out or too slow throws its own sentence.
    return json({ problem: (error as Error).message });
  }
};
