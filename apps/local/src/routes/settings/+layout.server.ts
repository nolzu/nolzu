import { enginesOnPath, loginShellPath } from '@nolzu/runner';
import type { LayoutServerLoad } from './$types';

// The menu's "2 found" after Engines. A file check on the PATH the engines run with, and no tool runs,
// so every settings page can afford it.
export const load: LayoutServerLoad = () => ({ enginesFound: enginesOnPath(loginShellPath(process.env)).length });
