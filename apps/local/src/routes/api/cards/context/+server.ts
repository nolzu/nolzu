import { json } from '@sveltejs/kit';
import { contextSources } from '$lib/create-card.ts';
import { database } from '$lib/db.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => json(contextSources(database()));
