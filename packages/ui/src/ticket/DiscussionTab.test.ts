import { readFileSync } from 'node:fs';
import type { Estimate } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import DiscussionTab from './DiscussionTab.svelte';

const text = (body: string) => body.replace(/<!--[^>]*-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const thread = (id: string, label: string, sessionId: string | null, engine: string | null = 'claude-code') => ({
  id,
  kind: id.startsWith('ask') ? 'ask' : 'phase',
  label,
  sessionId,
  engine,
});

interface ToolCall {
  name: string;
  subject: string | null;
  input: string;
  result: { bytes: number; error: boolean } | null;
}

interface Divider {
  phase: string;
  started: string | null;
  durationMs: number | null;
  costUsd: number | null;
  wrote: string[];
}

interface Props {
  threads: (ReturnType<typeof thread> & { count?: number; at?: string | null; when?: string | null; subject?: string | null; opening?: string | null })[];
  current: string;
  messages: { id: number; author: string; body: string; at: string; tools?: ToolCall[] | null; when?: string | null; divider?: Divider; forNext?: string }[];
  models: string[];
  phaseModel: string | null;
  resume: string | null;
  next: string;
  onsend: (thread: string, text: string, model: string) => Promise<string | null>;
  oncopy: (text: string) => Promise<string | null>;
  phaseEffort?: string | null;
  estimates?: Record<string, Estimate>;
  asking?: boolean;
  toolsWaiting?: boolean;
  later?: { id: string; label: string }[];
  order?: string[];
}

const draw = (over: Partial<Props> = {}): string =>
  render(DiscussionTab, {
    props: {
      threads: [thread('plan', 'Plan', 's-2', 'codex#work'), thread('ask', 'Ask', null, null)],
      current: 'plan',
      messages: [{ id: 1, author: 'person', body: 'use the other index', at: '2026-09-24T10:00:00.000Z' }],
      models: ['haiku', 'sonnet'],
      phaseModel: 'opus',
      resume: "cd '/home/dev/recipes/worktrees/APP-1' && claude --resume 's-2'",
      next: 'ask-2',
      onsend: async () => null,
      oncopy: async () => null,
      ...over,
    } as Props,
  }).body;

it('lists every thread and marks the one that is open', () => {
  const html = draw();

  expect(html).toContain('Plan');
  expect(html).toContain('Ask');
  // The current thread is named by aria-current, so it is not a border alone.
  expect(html).toMatch(/aria-current="page"[^>]*><span class="label[^"]*">Plan<\/span>/);
  expect(html).toContain('aria-current="page"');
});

// The one thing this tab promises about a run: a message continues the session the phase kept, on
// the login that holds it. A person has to see both before they send.
it('names the session and the profile a message would continue', () => {
  const html = draw();

  expect(html).toContain('s-2');
  expect(html).toContain('codex#work');
});

// An answer from Before you approve goes to no agent, so it is marked with the phase that reads it, and the
// head promises a reply only for a message written here.
it('marks an answer from Before you approve with the phase that reads it', () => {
  const plain = text(draw());
  expect(plain).toContain('A message written here continues the plan session.');
  expect(plain).not.toContain('For Implement');

  const html = draw({ messages: [{ id: 1, author: 'person', body: 'Q1: Split the job? I take the default: no.', at: '2026-09-24T10:00:00.000Z', forNext: 'Implement' }] });
  expect(html).toMatch(/<span class="for[^"]*"[^>]*>For Implement<\/span>/);
  expect(text(html)).toContain('A message written here continues the plan session. An answer marked For Implement goes to no agent here: Implement reads it when the card moves.');
});

// A message is written once its run ended, so a cost the engine did not report is said, not left blank.
it('says a run behind a message reported no cost', () => {
  const run = { model: 'gpt-5', durationMs: 72_000, tokens: 1200, costUsd: null };
  const html = draw({ messages: [{ id: 1, author: 'agent', body: 'Done.', at: '2026-09-24T10:00:00.000Z', run } as never] });

  expect(text(html)).toContain('1m 12s · 1.2k tokens · no cost reported');
});

// The other side. A thread with no session shows why it cannot send, rather than a box that looks
// ready and then fails.
it('says why a thread with no session takes no message', () => {
  const html = draw({
    threads: [thread('refine', 'Refine', null), thread('ask', 'Ask', null)],
    current: 'refine',
    messages: [],
  });

  expect(html).toMatch(/no session to continue/i);
  // Read only, not disabled. A disabled field cannot be reached by keyboard or read by a screen
  // reader, so the reason below it would never be heard.
  expect(html).toContain('readonly');
  expect(html).toContain('aria-describedby="send-note"');
  expect(html).toContain('id="send-note"');
});

// The ask thread belongs to no phase and starts a read-only session of its own,
// so it takes a message with no session and says what the session does before the first one.
it('lets an ask discussion start a read-only session, with the engine named and the model a picker', () => {
  const html = draw({ threads: [thread('plan', 'Plan', 's-2'), thread('ask', 'Ask', null, 'claude-code')], current: 'ask', messages: [], phaseModel: 'haiku', phaseEffort: 'low' });

  expect(html).not.toContain('readonly');
  expect(html.replace(/<!--[^>]*-->/g, '')).toMatch(/Starts a read-only session\son Claude Code\. It reads the card's code/);
  expect(html).toContain('changes nothing');
  expect(html).toContain('A read-only session about this card');
  expect(html).toContain('message-model');
  expect(html).toContain('haiku (the Ask model)');
  expect(html).not.toMatch(/nothing runs/i);
});

// A later message goes on in the session its first one started, and says so as a phase thread does.
it('names the session a later Ask message goes on in', () => {
  const html = draw({ threads: [thread('ask', 'Ask', 'a-1ffee000', 'claude-code')], current: 'ask', messages: [], resume: null });

  expect(html).toContain('session a-1ffee0');
  expect(html).toMatch(/Resumes the read-only session/);
});

// The answer is not there while the run goes, so Send holds and says why, read off the run row.
it('holds Send while the Ask run goes, and says the answer comes here', () => {
  const html = draw({ threads: [thread('ask', 'Ask', 'a-1', 'claude-code')], current: 'ask', messages: [], asking: true });

  expect(/<button[^>]*data-send-message[^>]*>/.exec(html)?.[0]).toContain('aria-disabled="true"');
  expect(html).toContain('The agent is reading the code. Its answer shows here when the run ends.');
});

// The figure of a new Ask session, only where Ask runs measured one.
it('shows what a new Ask session takes beside Send only when Ask runs measured it', () => {
  const measured: Estimate = { costUsd: 0.01, lowMs: 15_000, highMs: 30_000, from: 'history', runs: 5 };
  const ask = { threads: [thread('ask', 'Ask', null, 'claude-code')], current: 'ask', messages: [], phaseModel: 'haiku', phaseEffort: 'low' };

  const shown = draw({ ...ask, estimates: { haiku: measured } });
  expect(shown).toContain('about $0.01');
  expect(shown).toContain('What a new Ask session takes, from 5 runs in this project.');
  expect(draw({ ...ask, estimates: {} })).not.toContain('about $');
});

it('shows the messages that are in the thread, and who wrote each', () => {
  const html = draw({
    messages: [
      { id: 1, author: 'person', body: 'use the other index', at: '2026-09-24T10:00:00.000Z' },
      { id: 2, author: 'agent', body: 'Done, the plan now names it.', at: '2026-09-24T10:01:00.000Z' },
    ],
  });

  expect(html).toContain('use the other index');
  expect(html).toContain('Done, the plan now names it.');
  // The agent is named by its phase.
  expect(html).toContain('Plan agent');
  expect(html).toContain('You');
});

// The default names the model the message would run on, not a phrase a person has to look up.
it('offers the models of the thread profile, and names the phase model as the default', () => {
  const html = draw();

  expect(html).toMatch(/<button[^>]*data-model=""[^>]*>\s*opus \(the phase's model\)/);
  expect(html).toContain('haiku');
  expect(html).toContain('sonnet');
  expect(html).not.toContain("the phase's own");
});

// The button copies the command, so the page does not print it.
it('offers the command that continues the session as a copy button, not printed', () => {
  const html = draw();

  expect(html).toContain('Copy resume command');
  expect(html).not.toContain('claude --resume');
  expect(draw({ resume: null })).not.toContain('Copy resume command');
});

// An ask discussion that holds something is a thread of its own. The empty one is the Ask row
// at the foot of the list, and it is the one marked while it is open.
it('lists each ask discussion that holds something, and the Ask row for a new one', () => {
  const ask = (id: string, label: string, count: number, sessionId: string | null) => ({ ...thread(id, label, sessionId), count });
  const html = draw({
    threads: [thread('plan', 'Plan', 's-2'), ask('ask-2', 'Ask 2', 0, null), ask('ask', 'Ask', 2, 'a-1')],
    current: 'ask-2',
    messages: [],
  });

  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toMatch(/<a[^>]*href="\?thread=ask-2"[^>]*aria-current="page"[^>]*>Ask<span class="t2[^"]*">A read-only session about this card<\/span><\/a>|<a[^>]*aria-current="page"[^>]*href="\?thread=ask-2"/);
  expect(html).toContain('href="?thread=ask"');
  expect(html).not.toContain('New discussion');
  // An ask discussion with no session yet starts one, so it is not labelled as missing one.
  expect(html).not.toContain('no session');
});

// With every ask discussion holding something, the Ask row opens the next id.
it('links the Ask row to the next id once every ask discussion holds something', () => {
  const html = draw({ threads: [{ ...thread('ask', 'Ask', 'a-1'), count: 3 }], current: 'ask', next: 'ask-3', messages: [] });

  expect(html).toMatch(/<a[^>]*href="\?thread=ask-3"[^>]*>Ask<span class="t2/);
  // The empty first discussion is the Ask row itself, so it is not listed twice.
  expect(draw({ threads: [thread('plan', 'Plan', 's-2'), thread('ask', 'Ask', null, null)] }).match(/A read-only session about this card/g)).toHaveLength(1);
});

// No DOM here paints, so the marks of the open thread are read off the component: a soft filled row
// and a weight, no outline, and aria-current names it so it is not colour alone.
it('marks the open thread as a soft filled row with a weight, not an outline', () => {
  const component = readFileSync(new URL('./DiscussionTab.svelte', import.meta.url), 'utf8');
  const rule = /\.thread\.current \{([^}]*)\}/.exec(component)?.[1] ?? '';

  expect(rule).toContain('background: var(--card-2)');
  expect(rule).toContain('font-weight: 500');
  expect(rule).not.toContain('box-shadow');
  expect(draw()).toContain('aria-current="page"');
});

// No outer frame around the threads and the conversation, only the divider between.
it('draws no border around the tab, only the divider beside the threads', () => {
  const component = readFileSync(new URL('./DiscussionTab.svelte', import.meta.url), 'utf8');

  expect(/\.discussion \{([^}]*)\}/.exec(component)?.[1]).not.toContain('border');
  expect(/\n {2}\.open \{([^}]*)\}/.exec(component)?.[1]).toContain('border-left: 1px solid var(--line)');
  expect(/textarea \{([^}]*)\}/.exec(component)?.[1]).toContain('resize: none');
});

// The list stays in sight while the conversation scrolls, capped to the window and scrolling on its
// own, and on a narrow window it sits above the conversation with a cap of its own.
it('keeps the thread list in sight, capped to the window, and scrolls it on its own', () => {
  const component = readFileSync(new URL('./DiscussionTab.svelte', import.meta.url), 'utf8');
  const wide = /\n {2}\.threads \{([^}]*)\}/.exec(component)?.[1] ?? '';
  const narrow = /@media \(max-width: 720px\) \{[\s\S]*?\.threads \{([^}]*)\}/.exec(component)?.[1] ?? '';

  expect(wide).toMatch(/position: sticky;[\s\S]*top: var\(--thead-height, 0px\);[\s\S]*align-self: start;[\s\S]*max-height: calc\(100dvh - var\(--thead-height, 0px\)\);[\s\S]*overflow-y: auto;/);
  expect(narrow).toMatch(/position: static;[\s\S]*max-height: 40dvh;/);
});

// The busy state reads the run row, so it is on for a phase thread after a reload too: Send held and
// busy, and a line in the conversation that the answer is coming.
it('shows Send busy and an answering line while the thread run goes', () => {
  const html = draw({ asking: true });
  const button = /<button[^>]*data-send-message[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';

  expect(button).toContain('aria-busy="true"');
  expect(button).toContain('aria-disabled="true"');
  expect(button).toContain('class="dots ');
  expect(html).toMatch(/data-answering[\s\S]*role="status"[\s\S]*Plan agent<\/b> <span class="quiet[^"]*">is answering<\/span>/);
  expect(html).toContain('The plan run is going. Its answer shows here when the run ends.');

  const idle = draw();
  expect(idle).not.toContain('data-answering');
  expect(/<button[^>]*data-send-message[^>]*>/.exec(idle)?.[0]).not.toContain('aria-busy');
});

// A generic person, not a letter, and the name line still says You.
it('draws the person as a head and shoulders, named You in the text', () => {
  const html = draw();

  expect(html).toMatch(/<span class="avatar[^"]*" aria-hidden="true">[\s\S]*?<svg class="person /);
  expect(html).not.toMatch(/aria-hidden="true">\s*(<!--[^>]*-->)?\s*Y\s*<\/span>/);
  expect(html).toMatch(/<b[^>]*>You<\/b>/);
});

// The Markdown component renders nothing on the server, because DOMPurify needs a DOM and hands
// its input back uncleaned without one. The server shows the text, and the mount test covers the
// rendering and the sanitizing.
it('shows a message as text before the browser renders it', () => {
  const html = draw({ messages: [{ id: 1, author: 'agent', body: '**bold**', at: '2026-09-24T10:00:00.000Z' }] });

  expect(html).toContain('**bold**');
  expect(html).not.toContain('<script');
});

it('says so when a thread has nothing in it yet', () => {
  const html = draw({ messages: [] });

  expect(html).toMatch(/nothing said yet/i);
});

// Held is said by the attribute, not by colour, which is the rule for every button in this
// package. An empty draft cannot send.
it('holds the send button until something is typed', () => {
  expect(draw()).toContain('aria-disabled="true"');
});

// A message on a phase thread resumes its session and one in an ask discussion starts or resumes its
// read-only session, so Send is the amber go button on both. A phase with no
// session starts nothing, so there it is primary.
it('draws Send as go on a phase thread and an ask discussion, and as primary on a phase with no session', () => {
  const send = (html: string) => /<button[^>]*data-send-message[^>]*>/.exec(html)?.[0] ?? '';
  const classes = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? [];
  const noSession = classes(send(draw({ threads: [thread('plan', 'Plan', null)], resume: null })));

  expect(classes(send(draw()))).toContain('go');
  expect(classes(send(draw({ current: 'ask', messages: [] })))).toContain('go');
  expect(noSession).toContain('primary');
  expect(noSession).not.toContain('go');
});

// The agent's tool calls, as the page read them from the run's log: one folded row each, the tool
// and what it acted on, opening to the input and what came back.
it('draws each tool call as a folded row that opens to its input and result', () => {
  const html = draw({
    messages: [
      {
        id: 2,
        author: 'agent',
        body: 'The search runs in the api.',
        at: '2026-10-15T15:34:00.000Z',
        tools: [
          { name: 'Read', subject: 'api/src/recipes.ts', input: '{\n  "file_path": "api/src/recipes.ts"\n}', result: { bytes: 2970, error: false } },
          { name: 'Bash', subject: 'pnpm test', input: '{}', result: { bytes: 120, error: true } },
          { name: 'Glob', subject: null, input: '{}', result: null },
        ],
      },
    ],
  });

  expect(html.match(/<details class="tool[^"]*"/g)).toHaveLength(3);
  expect(html).toMatch(/<summary[^>]*>[\s\S]*Read[\s\S]*api\/src\/recipes\.ts[\s\S]*2\.9 KB[\s\S]*<\/summary>/);
  expect(html).toContain('"file_path": "api/src/recipes.ts"');
  expect(html).toContain('Result, 2.9 KB');
  // An error is a word, not a colour alone.
  expect(html).toContain('Error result, 120 B');
  expect(html).toMatch(/no result for this call/i);
});

it('says so when the log of the run is gone, rather than showing no calls', () => {
  const html = draw({ messages: [{ id: 2, author: 'agent', body: 'Done.', at: '2026-10-15T15:34:00.000Z', tools: null }] });

  expect(html).toMatch(/log of this run is gone/i);
  expect(html).not.toContain('<details class="tool');
});

// The tool calls come from each run's log, which the page reads after it drew.
it('draws a grey line under an agent message while its tool calls are on their way', () => {
  const messages = [
    { id: 1, author: 'person', body: 'Why?', at: '2026-10-15T15:33:00.000Z' },
    { id: 2, author: 'agent', body: 'Done.', at: '2026-10-15T15:34:00.000Z' },
  ];
  const waiting = draw({ messages, toolsWaiting: true });
  expect(waiting.match(/data-skeleton/g)).toHaveLength(1);
  expect(waiting).toContain('Reading the tool calls from the run log.');

  expect(draw({ messages })).not.toContain('data-skeleton');
});

// Send resumes a run. The figure shows only where runs measured it, and with
// none there is no figure at all, not a guess.
it('shows the estimate beside Send only when runs measured it', () => {
  const measured: Estimate = { costUsd: 0.4, lowMs: 6 * 60_000, highMs: 10 * 60_000, from: 'history', runs: 8 };

  const shown = draw({ estimates: { opus: measured } });
  expect(shown).toContain('about $0.40 · 6 to 10 min');
  expect(shown).toContain('from 8 runs in this project');

  expect(draw({ estimates: {} })).not.toContain('about $');
  expect(draw()).not.toContain('about $');
  // Measured for another model than the one the message runs on.
  expect(draw({ estimates: { haiku: measured } })).not.toContain('about $');
  // A phase thread with no session starts nothing, so Send names no figure for a run it will not start.
  expect(draw({ threads: [thread('plan', 'Plan', null)], estimates: { opus: measured } })).not.toContain('about $');
});

// A resume cannot move to another engine, so the engine is plain text and only the model is a picker,
// with the models of the engine the run used and no other.
it('offers only the models of the run engine, and names the engine and effort as plain text', () => {
  const html = draw({ phaseEffort: 'high' });

  // A chip that opens the choices, not the native select.
  expect(html).not.toContain('<select');
  expect(html).toMatch(/<summary[^>]*aria-label="Model for this message only: opus"[^>]*>opus</);
  const options = [...html.matchAll(/data-model="([^"]*)"/g)].map((match) => match[1]);
  expect(options).toEqual(['', 'haiku', 'sonnet']);
  expect(html).toMatch(/>Codex</);
  expect(html).toMatch(/>high</);
  expect(html).toContain('model for this message only');
});

// A phase that has not run has no thread yet, so it is listed greyed with when it opens, and it is not
// a link that would open a box that cannot send.
it('lists a phase that has not run as greyed text, not as a link', () => {
  const html = draw({ later: [{ id: 'implement', label: 'Implement' }] });

  expect(html).toMatch(/<span class="thread off[^"]*">Implement<span class="t2[^"]*">Opens when Implement runs<\/span><\/span>/);
  expect(html).not.toContain('href="?thread=implement"');
  expect(draw()).not.toContain('Opens when');
});

// The board's phases in the order they run, the ones that have not run greyed in their place, and
// the Ask row last. Not newest first.
it('lists the threads in phase order, with the greyed phases in place and Ask last', () => {
  const html = draw({
    threads: [thread('implement', 'Implement', 's-3'), thread('plan', 'Plan', 's-2'), thread('refine', 'Refine', 's-1'), thread('ask', 'Ask', null, null)],
    later: [{ id: 'qa', label: 'QA' }],
    order: ['refine', 'plan', 'implement', 'qa', 'wrapup'],
  });
  const names = [...html.matchAll(/class="thread[^"]*"[^>]*>(?:<span class="label[^"]*">)?([A-Za-z-]+)/g)].map((match) => match[1]);

  expect(names).toEqual(['Refine', 'Plan', 'Implement', 'QA', 'Ask']);
});

// The server says the time in the trail's words: the time today, a short day before it otherwise.
it('shows the time the server said for a message and a thread, not the stored stamp', () => {
  const html = draw({
    threads: [{ ...thread('plan', 'Plan', 's-2'), at: '2026-10-17T15:34:00.000Z', when: 'Sat 15:34' }],
    messages: [{ id: 1, author: 'person', body: 'why the api?', at: '2026-10-17T15:33:00.000Z', when: '15:33' }],
  });

  expect(html.replace(/<!--[^>]*-->/g, '')).toContain('session s-2 · Sat 15:34');
  expect(html).toMatch(/<time datetime="2026-10-17T15:33:00.000Z"[^>]*>15:33<\/time>/);
  expect(html).not.toContain('2026-10-17 15:3');
});

// A line above the first message of each run: the phase, when it started, how long it took, the cost
// where reported, and the files its folder holds.
it('draws a run divider above the first message of a run, each figure only where known', () => {
  const divider = { phase: 'Plan', started: '15:31', durationMs: 72_000, costUsd: 0.11, wrote: ['plan/plan.md'] };
  const html = draw({
    messages: [
      { id: 1, author: 'person', body: 'why the api?', at: '2026-10-17T15:33:00.000Z', divider },
      { id: 2, author: 'agent', body: 'Two reasons.', at: '2026-10-17T15:34:00.000Z', divider: { phase: 'Plan', started: '15:33', durationMs: null, costUsd: null, wrote: [] } },
    ],
  });
  const lines = [...html.matchAll(/<li class="runline[^"]*">([^<]*)<\/li>/g)].map((match) => match[1]);

  expect(lines).toEqual(['Plan run 15:31 · 1m 12s · $0.11 · wrote plan/plan.md', 'Plan run 15:33']);
  expect(html.indexOf('runline')).toBeLessThan(html.indexOf('why the api?'));
});

it('names three files a phase wrote, then how many more', () => {
  const divider = { phase: 'Mockups', started: null, durationMs: null, costUsd: null, wrote: ['mockups/a.html', 'mockups/b.html', 'mockups/c.html', 'mockups/d.html', 'mockups/mockups.md'] };
  const html = draw({ messages: [{ id: 1, author: 'agent', body: 'Done.', at: '2026-10-17T15:33:00.000Z', divider }] });

  expect(html).toContain('Mockups run · wrote mockups/a.html, mockups/b.html, mockups/c.html and 2 more');
});

// An ask discussion is listed by its subject, else by the start of its first message, else its label.
// Only an ask discussion that holds something gets the three dot menu.
it('names an ask discussion by its subject or its opening, with a menu on ask rows only', () => {
  const listed = (over: object) => ({ ...thread('ask-2', 'Ask 2', 'a-2'), count: 2, ...over });
  const html = draw({
    threads: [thread('plan', 'Plan', 's-2'), listed({ subject: 'Where the list comes from' }), { ...thread('ask', 'Ask', 'a-1'), count: 2, opening: 'Why the api?' }],
    current: 'ask-2',
  });

  expect(html).toMatch(/<span class="label[^"]*">Where the list comes from<\/span>/);
  expect(html).toMatch(/<span class="label[^"]*">Why the api\?<\/span>/);
  expect(html).toMatch(/<h2[^>]*>Where the list comes from<\/h2>/);
  const menus = [...html.matchAll(/<button[^>]*aria-haspopup="menu"[^>]*>/g)].map((one) => one[0]);
  expect(menus).toHaveLength(2);
  expect(menus[0]).toContain('aria-label="More for Where the list comes from"');
  expect(menus[0]).toContain('aria-expanded="false"');
  // The menu exists only while open, so a closed button points at nothing.
  expect(menus[0]).not.toContain('aria-controls');
  // Before any message, the label.
  expect(draw({ threads: [{ ...thread('ask', 'Ask', 'a-1'), count: 1 }], current: 'ask' })).toMatch(/<span class="label[^"]*">Ask<\/span>/);
});
