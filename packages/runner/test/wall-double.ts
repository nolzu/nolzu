import type { WallPort } from '../src/spawn.ts';
import type { WallSpec } from '../src/wall.ts';

// Stand-ins for the wall, for tests on a machine with no wall to start, such as CI with no
// bubblewrap. `recordingWall` keeps every spec it was handed and starts the engine as it came.
export interface RecordingWall {
  wall: WallPort;
  specs: WallSpec[];
}

export function recordingWall(): RecordingWall {
  const specs: WallSpec[] = [];
  return { specs, wall: (spec, command, args) => (specs.push(spec), { command, args: [...args] }) };
}

export const refusingWall =
  (reason: string): WallPort =>
  () => ({ refused: reason });
