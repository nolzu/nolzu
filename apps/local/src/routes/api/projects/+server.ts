import { json } from '@sveltejs/kit';
import { database } from '$lib/db.ts';
import { projectList } from '$lib/projects.ts';
import type { RequestHandler } from './$types';

// The shape the paid projects panel reads: every project of the account once the hub has listed them.
export const GET: RequestHandler = () => json(projectList(database()));
