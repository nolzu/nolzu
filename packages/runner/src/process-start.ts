import { execFileSync } from 'node:child_process';

// When a process started, read from ps, or null where ps is missing or does not know the process.
// The writer lock asks it, so a process number a crash left to another program is not taken for Nolzu.
export function processStart(pid: number): number | null {
  try {
    const said = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const at = Date.parse(said);
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
}
