import { readFileSync } from 'node:fs';
import { SYNCED_DATA } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { TEAM_CARD_STATE } from './data-leaves.ts';
import DataSync from './DataSync.svelte';

// Scout and Evidence are off as shipped. These tests pin how they work once the switch is on again, and
// coming-soon.test.ts pins the off state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), SCOUT_AND_EVIDENCE: true }));

// The line a machine with no cloud board gets. Written out here, so a reworded line has to be
// rewritten in both places and nobody changes what this screen says by accident.
const FREE = 'No hub: nothing is sent.';

// The messages by hand, by the hub each goes to. Reading them off `RUNNER_MESSAGES` would pass whatever
// that list held, and a message that started travelling with no line on the screen is what this is for.
const TO_HUB = ['card.state', 'evidence.blocks', 'report.weekly', 'finding.results', 'scout.schedule', 'project.sync'];
const TO_TEAM = ['card.state', 'run.cost', 'knowledge.proposals'];
// Everything the client puts on a socket: the eight runner messages, the job ack and the heartbeat.
const EVERY_FRAME = ['card.state', 'evidence.blocks', 'finding.results', 'knowledge.proposals', 'project.sync', 'scout.schedule', 'report.weekly', 'run.cost', 'job.ack', 'ping', 'pong'];

const NEVER = [
  'Code',
  'Diffs of your code',
  'Transcripts',
  'Engine logins',
  'Engine limit state and the usage window',
  'Scout source tokens · in your keychain',
  'The lines a Scout source read',
  'Run logs',
  'Plan steps',
  'Paths on this machine',
  'Tool activity',
  'Discussion messages',
];

// The render markers are dropped and the white space folded, so a row with a marker and no sentence in
// it cannot pass for a row that says something, and a wrapped paragraph reads as a browser shows it.
const drawn = (props: { canSync?: boolean; team?: boolean } = {}) =>
  render(DataSync, { props }).body.replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ');

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Scoped styles put a class on every element, so each tag may carry attributes.
const row = (marker: string, type: string, says: string) =>
  new RegExp(`<div[^>]*${marker}="${type}"[^>]*><code[^>]*>${literal(type)}</code><span[^>]*>${literal(says)}</span></div>`);
const code = (type: string) => new RegExp(`<code[^>]*>${literal(type)}</code>`);

describe('a machine whose plan has the cloud board', () => {
  it('puts every SYNCED_DATA entry in a column, with the sentence the protocol holds', () => {
    const html = drawn({ canSync: true, team: true });

    for (const type of TO_HUB) expect(html).toMatch(row('data-sends', type, SYNCED_DATA[type as keyof typeof SYNCED_DATA]));
    for (const type of TO_TEAM.filter((one) => one !== 'card.state')) expect(html).toMatch(row('data-team', type, SYNCED_DATA[type as keyof typeof SYNCED_DATA]));
    // Each hub's rows and no more, so a line for a message nothing sends any longer cannot come back by hand.
    expect(html.match(/data-sends="/g)).toHaveLength(TO_HUB.length);
    expect(html.match(/data-team="/g)).toHaveLength(TO_TEAM.length);
    for (const type of Object.keys(SYNCED_DATA)) expect(html).toMatch(code(type));
  });

  // The page promises every message, and the ones that carry nothing are messages too.
  it('names every message type the client sends', () => {
    const html = drawn({ canSync: true });

    for (const type of EVERY_FRAME) expect(html).toMatch(code(type));
    expect(html).toContain('carry no data');
  });

  // Knowledge proposals, Scout source schedules and the board flow.
  it('lists the knowledge proposals, the Scout source schedules and the board flow', () => {
    const html = drawn({ canSync: true });

    expect(html).toContain('data-team="knowledge.proposals"');
    expect(html).toContain('data-sends="scout.schedule"');
    expect(html).toMatch(/data-sends="project.sync"[^>]*><code[^>]*>project.sync<\/code><span[^>]*>[^<]*its delivery flow/);
  });

  // The team socket sends the cards without their runs, so the team column says so and does not repeat
  // the line that names a run's question.
  it('draws the team line for the cards, not the one with the runs', () => {
    const html = drawn({ canSync: true, team: true });

    expect(html).toMatch(row('data-team', 'card.state', TEAM_CARD_STATE));
    expect(html).toMatch(row('data-sends', 'card.state', SYNCED_DATA['card.state']));
  });

  it('says nothing goes to a team hub from a project that is not a team project', () => {
    expect(drawn({ canSync: true, team: false })).toContain('Nothing today. This project is not a team project.');
    expect(drawn({ canSync: true, team: true })).not.toContain('data-no-team');
  });

  it('draws no free line', () => {
    expect(drawn({ canSync: true })).not.toContain(FREE);
  });
});

describe('a machine without the cloud board', () => {
  // One line, not a column per hub that each says the same.
  it('says nothing is sent in one line, and lists no message', () => {
    const html = drawn({ canSync: false });

    expect(html.split(FREE)).toHaveLength(2);
    expect(html).not.toContain('Sent to your hub');
    expect(html).not.toContain('data-sends');
    expect(html).not.toContain('data-team');
    expect(html).not.toContain('data-frames');
  });

  // The default, with no prop at all. A page that forgot to pass the plan must draw the closed branch,
  // because the open one lists what a hub this machine may not have would carry.
  it('draws the closed branch when nobody says what the plan is', () => {
    const html = drawn();

    expect(html).toContain(FREE);
    expect(html).not.toContain('data-sends');
  });
});

// Both branches. The list is what the screen promises, and a person on the free plan is the one most
// likely to be reading the screen to decide whether to connect at all.
describe.each([true, false])('on every plan (canSync %s)', (canSync) => {
  it('draws the never list whole, folded under a heading that names the hub', () => {
    const html = drawn({ canSync });

    // Folded: inside a details that is not open, so the box stays short.
    expect(html).toMatch(/<details(?![^>]*open)[^>]*>\s*<summary/);
    for (const thing of NEVER) expect(html).toMatch(new RegExp(`<li[^>]*data-never="${thing}"[^>]*>${thing}<`));
    expect(html.match(/data-never="/g)).toHaveLength(NEVER.length);
    expect(html).toContain('Never sent');
    expect(html).toContain('To any hub, on every plan.');
  });

  // What leaves another way is on Settings, Wall, so this page does not say it twice.
  it('leaves the other roads out of this page', () => {
    expect(drawn({ canSync })).not.toContain('Leaves another way');
  });
});

// The wire. A component nothing draws is a feature that only works in its own test, and the props the
// page passes are what decide which branch a real person reads, so they are read off the page itself.
it('draws the box on Settings, Cloud, from the display document the layout fetched', () => {
  const page = readFileSync(new URL('../routes/settings/[section]/+page.svelte', import.meta.url), 'utf8');

  expect(page).toContain('<DataSync {canSync} team={data.team ?? false} />');
  // Inside the Cloud section, on every plan.
  expect(page.slice(page.indexOf('<section id="cloud"'), page.indexOf('<DataSync'))).not.toContain('</section>');
  expect(page).toContain("const canSync = $derived(shows(data.display, 'cloud-board'));");
});
