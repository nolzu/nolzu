import { json } from '@sveltejs/kit';
import { enginesOnPath, loginShellPath } from '@nolzu/runner';
import type { RequestHandler } from './$types';

// The start page asks this every two seconds while no agent tool is there. It looks on the PATH the
// engines run with, so a tool found here is one a run can start.
export const GET: RequestHandler = () => json(enginesOnPath(loginShellPath(process.env)));
