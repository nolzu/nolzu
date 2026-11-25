import { sep } from 'node:path';
import { inject, vi } from 'vitest';

// Every test file gets this wrapper, so a test that resolves the live data directory fails
// before it can open the database there.
vi.mock(import('./packages/core/src/node/data-dir.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    resolveDataDir(env: Record<string, string | undefined>) {
      const dir = original.resolveDataDir(env);
      const live = inject('liveDataDir');
      if (dir === live || dir.startsWith(live + sep)) {
        throw new Error(`A test resolved the live data directory ${dir}. Point NOLZU_DATA_DIR at a temp directory.`);
      }
      return dir;
    },
  };
});

// The time trackers an export posts to. A test that forgets its fetch stub fails here by name,
// instead of sending a test token to a real tracker. A test that stubs fetch replaces this.
const TRACKERS = ['api.track.toggl.com', 'api.harvestapp.com', 'api.clockify.me'];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const host = URL.canParse(url) ? new URL(url).hostname : '';
  if (TRACKERS.includes(host) || host.endsWith('.atlassian.net')) {
    return Promise.reject(new Error(`A test called ${host}. Stub fetch, or hand the code a fetch of its own.`));
  }
  return realFetch(input, init);
};
