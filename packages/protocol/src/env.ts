// One reading of the flag for core and runner, so fake runs never reach live data.
export function isFakeMode(env: Record<string, string | undefined>): boolean {
  return env.NOLZU_FAKE_AGENT === '1';
}
