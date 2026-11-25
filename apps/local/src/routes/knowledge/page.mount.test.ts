import type { BoardSnapshot } from '@nolzu/protocol';
import { boardFixture } from '@nolzu/ui/fixture';
import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { NowSnapshot } from '$lib/now.ts';
import { nowLive } from '$lib/now-live.svelte.ts';
// eslint-disable-next-line no-restricted-imports -- the ui package's mount helper, which is not exported
import { mounted } from '../../../../../packages/ui/test/mounted.svelte.ts';
import KnowledgeRoute from './+page.svelte';

const invalidated = vi.hoisted(() => ({ count: 0 }));
vi.mock('$app/navigation', () => ({ invalidateAll: async () => void (invalidated.count += 1) }));
vi.mock('$app/forms', () => ({ applyAction: async () => {}, deserialize: () => ({ type: 'success', status: 200 }) }));

afterEach(() => {
  invalidated.count = 0;
  nowLive.state = { snapshot: null, reconnecting: false, activity: {}, limits: {} };
});

// The rail's stream, with the knowledge lane held by `holder` or free.
const live = (holder: string | null): void => {
  const board: BoardSnapshot = { ...boardFixture('pull-request'), lanes: [{ name: 'knowledge', heldBy: holder }] };
  nowLive.state = { ...nowLive.state, snapshot: { boards: [board], running: [] } as unknown as NowSnapshot };
  flushSync();
};

// The lock line goes once the last Learn run ends, so the page cannot read the lane only once, at
// load. It reads again when the lane changes hands, and not on the first snapshot it hears.
it('reads the page again when the knowledge lane changes hands, and only then', () => {
  const page = mounted(KnowledgeRoute as never, { data: { knowledge: new Promise(() => {}), review: true, learn: null, repos: null }, form: null });
  try {
    live('kb-learn-api');
    expect(invalidated.count).toBe(0);
    live('kb-learn-api');
    expect(invalidated.count).toBe(0);
    live(null);
    expect(invalidated.count).toBe(1);
    live('kb-learn-web');
    expect(invalidated.count).toBe(2);
  } finally {
    page.remove();
  }
});
