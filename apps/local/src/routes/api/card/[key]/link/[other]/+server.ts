import { database } from '$lib/db.ts';
import { unlink } from '$lib/overview.ts';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = ({ params }) => unlink(database(), params.key, params.other);
