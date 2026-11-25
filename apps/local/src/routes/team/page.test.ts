import { readFileSync } from 'node:fs';
import type { DisplayEntitlement } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import CloudLinks from '$lib/CloudLinks.svelte';
import { FREE, webTeamHref } from '$lib/display.ts';
import Page from './+page.svelte';
import { load } from './+page.ts';

// The Team page answers for an account, which needs the cloud open (`packages/protocol/src/soon.ts`).
// cloud-closed.test.ts pins what a closed cloud says.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true }));

const BASE = 'https://cloud.example/';

const solo: DisplayEntitlement = { id: 'u1', plan: 'solo', features: ['cloud-board', 'evidence-history', 'exporters'], seats: 1, expiresAt: 0 };
// Team is everything Solo has plus the four Team names, the way the cloud signs it.
const team: DisplayEntitlement = { ...solo, plan: 'team', features: [...solo.features, 'claims', 'decision-records', 'knowledge-review', 'team-costs'], seats: 5 };

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// The links under Settings, Cloud, the way the settings page draws them: Team only where
// the web app has a team to open. The rail draws no Team entry.
const header = (document: DisplayEntitlement) => render(CloudLinks, { props: { account: null, team: webTeamHref(document, BASE) === null ? null : '/team' } }).body;

const opened = (document: DisplayEntitlement) =>
  (load as unknown as (event: { parent: () => Promise<unknown> }) => Promise<{ webTeam: string }>)({
    parent: async () => ({ display: document, cloud: BASE }),
  });

describe('the Team page', () => {
  it.each([
    ['Free', FREE],
    ['Solo', solo],
  ])('is not linked from Settings for a %s account', (_, document) => {
    expect(text(header(document))).not.toContain('Team');
    expect(header(document)).not.toContain('href="/team"');
  });

  it('is linked from Settings, Cloud for a Team account', () => {
    expect(text(header(team))).toContain('Team');
    expect(header(team)).toContain('href="/team"');
  });

  // The gate is the feature and not the plan word, so a document naming the plan with no feature shows nothing.
  it('reads the feature and not the plan word', () => {
    expect(webTeamHref(team, BASE)).not.toBeNull();
    expect(webTeamHref({ ...team, features: solo.features }, BASE)).toBeNull();
  });

  // Nothing renders the whole settings page for this, so this reads the lines that hand the links their
  // Team address, inside the Cloud section.
  it('is handed to the Cloud section by the settings page', () => {
    const source = readFileSync(new URL('../settings/[section]/+page.svelte', import.meta.url), 'utf8');
    const section = /<section id="cloud"[\s\S]*?<\/section>/.exec(source)?.[0] ?? '';

    expect(section).toContain('<CloudLinks {account} {team} />');
    expect(source).toContain("webTeamHref(data.display, data.cloud) === null ? null : resolve('/team')");
  });

  it.each([
    ['Free', FREE],
    ['Solo', solo],
  ])('answers 404 to a %s account that types the address', async (_, document) => {
    await expect(opened(document)).rejects.toMatchObject({ status: 404, body: { message: 'Team is part of a Team account. Your account has no team to show.' } });
  });

  it('points a Team account at the team page on the web app', async () => {
    expect(await opened(team)).toEqual({ webTeam: 'https://cloud.example/team' });
  });

  // A plain member gets 403 on Members, so the projects come first. The page names the rest, and none of them is "coming".
  it('links every member to the team projects and names the screens linked from there', () => {
    const body = render(Page, { props: { data: { webTeam: 'https://cloud.example/team' } as never } }).body;

    expect([...body.matchAll(/href="([^"]*)"/g)].map((match) => match[1])).toEqual([
      'https://cloud.example/team/projects',
      'https://cloud.example/team/costs',
      'https://cloud.example/team',
    ]);
    for (const screen of ['for every member', 'Members, roles, invites and seats', 'top of each team screen', 'claims', 'knowledge proposals', 'decision records', 'Team cost report', 'audit log', 'by member, project, card and model']) {
      expect(text(body)).toContain(screen);
    }
    // Who may open each linked screen, read from the paragraph that holds its link.
    const said = (href: string) => text(body.split('</p>').find((paragraph) => paragraph.includes(`href="${href}"`)) ?? '');
    expect(said('https://cloud.example/team/projects')).toContain('for every member');
    expect(said('https://cloud.example/team/costs')).toContain('for the team owner and admins');
    expect(said('https://cloud.example/team')).toContain('for the team owner and admins');
    expect(text(body)).not.toContain('coming');
    expect(text(body)).not.toContain('Jira sync');
  });
});
