import { json } from '@sveltejs/kit';
import { ghLogin } from '$lib/new-project.ts';
import type { RequestHandler } from './$types';

// New project reads this every two seconds while gh is missing or signed out (`waitForGh`).
export const GET: RequestHandler = async () => json(await ghLogin());
