import { json } from '@sveltejs/kit';
import { isBoardKind } from '@nolzu/protocol';
import { nextCardKey } from '$lib/create-card.ts';
import { database } from '$lib/db.ts';
import type { RequestHandler } from './$types';

// The key the next local card gets, asked for each time Add card opens and each time its board changes,
// so it never shows a stale one. A Research kind counts under its own prefix.
export const GET: RequestHandler = ({ url }) => {
  const board = url.searchParams.get('board') ?? '';
  return json({ key: nextCardKey(database(), isBoardKind(board) ? board : 'delivery') });
};
