import { loop } from '../../../lib/loop.ts';
import { stream } from './stream.ts';
import type { RequestHandler } from './$types';

// Not async on purpose. The first event goes into the stream as it is built, and an await here would
// be one more turn before the browser sees the board.
export const GET: RequestHandler = ({ request }) => stream(loop(), request);
