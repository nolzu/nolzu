import { chosenProject, database } from '../../../lib/db.ts';
import { loop } from '../../../lib/loop.ts';
import { nowSnapshot } from '../../../lib/now-snapshot.ts';
import { events } from '../board/stream.ts';
import type { RequestHandler } from './$types';

// Now as an event stream: the board stream's events, with every board that is on in each one. The root
// layout opens it once for the rail's count, and the Now page reads the same state. Each snapshot names
// the project it serves, and says `switched` once another project became current since it opened.
// Not async, for the board stream's reason: the first event goes out while the stream is built.
export const GET: RequestHandler = ({ request }) => {
  const current = chosenProject(database()).id;
  const live = loop(process.env, current);
  const switched = () => chosenProject(database()).id !== current;
  return events(live, request, () => ({ ...nowSnapshot(live), project: current, ...(switched() ? { switched: true } : {}) }));
};
