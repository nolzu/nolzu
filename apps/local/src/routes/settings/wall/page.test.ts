import { render } from 'svelte/server';
import { expect, it, vi } from 'vitest';
import { gitWallLine, gitWallReady, wallGroups, wallHere } from '@nolzu/runner';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../test/stubs/app-paths.ts';
import Page from './+page.svelte';
import { load } from './+page.server.ts';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const groups = wallGroups('darwin');
const drawn = () => {
  drawnAt('/settings/wall');
  return render(Page as never, { props: { data: { groups, git: gitWallLine({ ready: false, reason: 'bubblewrap is not installed.' }) } } } as never);
};

it('hands the page the groups the runner builds the wall from, for this system, and the line for git', () => {
  expect((load as unknown as () => { groups: unknown })()).toEqual({ groups: wallGroups(process.platform), git: gitWallLine(gitWallReady(wallHere())) });
});

// Where no wall can start, Nolzu's git runs as before, and the page says so.
it("says whether Nolzu's own git writes inside a wall", () => {
  expect(text(drawn().body)).toContain("Nolzu's own git runs without a wall on this machine, because the wall cannot start here. bubblewrap is not installed.");
  expect(gitWallLine({ ready: true, binary: '/usr/bin/sandbox-exec' })).toContain("Nolzu's own git writes inside a wall too");
});

// One line per group with its paths folded inside, so the long list reads as a few lines.
it('draws each group as one folded line with its paths inside', () => {
  const { body, head } = drawn();

  expect(head).toContain('<title>Wall · Settings · Nolzu</title>');
  expect(body).toContain('id="wall" aria-labelledby="wall-title"');
  for (const group of groups) {
    const one = body.slice(body.indexOf(`data-group="${group.id}"`));
    expect(one).toMatch(new RegExp(`^[^]*?<details[^>]*><summary[^>]*>[^]*?${group.name}[^]*?</summary>`));
    for (const path of group.paths) expect(one.slice(0, one.indexOf('</details>'))).toContain(`>${path}</li>`);
  }
  expect(body).not.toMatch(/<details[^>]*open/);
  expect(text(body)).toContain('Keys and cloud logins');
  expect(text(body)).toContain(`${groups.find((group) => group.id === 'history')?.paths.length} paths`);
  expect(body).toContain('href="../settings/project#walls"');
});

// Moved from What leaves this machine. A turned-off feature has no row: the
// timesheet comes back with Evidence and the sign-in with the cloud, which coming-soon.test.ts and
// cloud-closed.test.ts draw with each switch.
it('lists what leaves this machine another way, in its set order', () => {
  const body = drawn().body;
  const terms = [...body.matchAll(/<dt[^>]*>([^<]+)/g)].map((one) => one[1]?.trim());

  expect(text(body)).toContain('What leaves this machine another way');
  expect(terms).toEqual(['Push, pull request', 'Agent runs']);
  expect(body).toContain('your own git host');
  expect(body).not.toContain('Coming soon');
  expect(body).not.toContain('npx nolzu@latest login');
  expect(body).toContain('the company that makes the tool, under your own login');
});

// The sign-in row comes back with the cloud.
it('names the sign-in only while the cloud is open', async () => {
  vi.resetModules();
  vi.doMock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true }));
  try {
    const [{ default: Open }, { render: draw }, { drawnAt: at }] = await Promise.all([
      import('./+page.svelte'),
      import('svelte/server'),
      import('../../../../../../test/stubs/app-paths.ts'),
    ]);
    at('/settings/wall');
    const body = draw(Open as never, { props: { data: { groups } } } as never).body;
    expect(body).toContain('reach the Nolzu server on any plan');
  } finally {
    vi.doUnmock('@nolzu/protocol');
    vi.resetModules();
  }
});
