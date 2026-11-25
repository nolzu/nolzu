import type { CardView, StageView } from '@nolzu/protocol';
import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { boardFixture, cardFixture, stageFixture } from '../board/fixture.ts';
import DecisionPanel from './DecisionPanel.svelte';
import { fixItOf, sendBackOf } from './decision.ts';

// The panel for each card state, rendered on the server. The text says what a person reads, and the
// markup which button is amber: the go variant is the one class that puts amber on a button.
const board = boardFixture('pull-request');
const stage = (id: string): StageView => board.stages.find((one) => one.id === id)!;
const noop = async () => null;

function draw(card: CardView, props: Record<string, unknown> = {}): string {
  const label = board.stages.find((one) => one.id === card.stage)?.label ?? card.stage;
  const index = board.stages.findIndex((one) => one.id === card.stage);
  return render(DecisionPanel, { props: { card, stage: label, next: board.stages[index + 1] ?? null, onmove: noop, ...props } }).body;
}

const text = (body: string) => body.replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// Each opening tag of a go button.
const goButtons = (body: string) => body.match(/<button[^>]*class="[^"]*\bgo\b[^"]*"[^>]*>/g) ?? [];

describe('the decision panel', () => {
  it('starts Refine from an idle card in Inbox, in amber, with the drop box line', () => {
    const body = draw(cardFixture({ key: 'APP-1' }));

    expect(goButtons(body)).toHaveLength(1);
    expect(text(body)).toContain('Next step Start Refine');
    expect(text(body)).toContain('Claude Code · haiku · low');
    expect(text(body)).not.toContain('Starts: /refine');
    // Minimize sits in the card page's header.
    expect(text(body)).not.toContain('Minimize');
  });

  // A ready card asks about what the phase made. Send back is the plain button under the
  // go button, and the thread is in More actions.
  it('approves a ready card into the next stage, and offers the way back and the thread', () => {
    const body = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { back: { to: 'refine', label: 'Refine' }, threadHref: '/t/APP-1/discussion?thread=plan' });

    expect(goButtons(body)).toHaveLength(1);
    expect(goButtons(body)[0]).toContain('data-move="implement"');
    // The gate's Start button presses this one, so both make one move.
    expect(goButtons(body)[0]).toContain('data-go-button');
    expect(text(body)).toContain('Approve and start Implement');
    expect(text(body)).toContain('Send back to Refine');
    expect(text(body)).toContain('Ask about the plan');
    expect(text(body)).not.toContain('Open the Plan thread');
    expect(body).toContain('href="/t/APP-1/discussion?thread=plan"');
    expect(body).toMatch(/<a role="menuitem" href="\/t\/APP-1\/discussion\?thread=plan"/);
  });

  // Engine, model and effort are three selects drawn in place, with nothing to open first.
  it('draws the picker as three selects and no summary', () => {
    const picker = { action: 'implement', engine: 'claude-code', model: 'sonnet', effort: 'medium', profiles: [{ id: 'claude-code', label: 'Claude Code', models: ['sonnet'] }] };
    const body = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { picker });

    expect(body).not.toContain('<summary');
    expect([...body.matchAll(/<select data-pick="([^"]+)" aria-label="([^"]+)"/g)].map((match) => `${match[1]}: ${match[2]}`)).toEqual(['engine: Implement engine', 'model: Implement model', 'effort: Implement effort']);
  });

  it('opens the combined picker on the row the button starts, set to what it runs on', () => {
    const picker = { action: 'implement', engine: 'claude-code', model: 'sonnet', effort: 'medium', profiles: [{ id: 'claude-code', label: 'Claude Code', models: ['haiku', 'sonnet', 'opus'] }] };
    const body = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { picker });

    expect(body).toContain('<div class="pick');
    // The engine, its model and the effort, the picker the Settings tab draws.
    expect(body).toMatch(/<option value="claude-code" selected/);
    expect(body).toMatch(/<option value="sonnet" selected/);
    expect(body).toMatch(/<option value="medium" selected/);
    // A picker for another phase would change a row this button does not start.
    expect(draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { picker: { ...picker, action: 'plan' } })).not.toContain('class="pick');
  });

  // No figure that nothing measured.
  it('shows the estimate only when runs measured one', () => {
    const measured = { ...stage('implement'), starts: { ...stage('implement').starts!, estimate: { costUsd: 0.4, lowMs: 360_000, highMs: 600_000, from: 'history' as const, runs: 8 } } };
    const ready = cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' });

    expect(text(draw(ready, { next: measured }))).toContain('about $0.40 · 6 to 10 min , from 8 runs in this project');
    expect(text(draw(ready))).not.toContain('about $');
    // Whatever the words, no estimate line is drawn without a measured one.
    expect(draw(ready)).not.toContain('class="figure');
  });

  it('says a running card runs, offers Stop and no start', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'plan', state: 'running', runId: 4, runState: 'running' });
    const body = draw(card, { live: { line: 'Reading src/list.ts', quiet: null, since: '2s ago' } });

    expect(goButtons(body)).toHaveLength(0);
    expect(text(body)).toContain('Plan is running Reading src/list.ts · 2s ago');
    expect(body).toContain('data-run="stop"');
  });

  it('says a quiet run printed nothing, and offers Stop and no start', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'plan', state: 'running', runId: 4, runState: 'running' });
    const body = draw(card, { live: { line: null, quiet: '6m', since: null } });

    expect(goButtons(body)).toHaveLength(0);
    expect(text(body)).toContain('Plan has printed nothing for 6m');
    expect(body).toContain('data-run="stop"');
  });

  it('says why a queued card waits, and offers to take it off the queue and no start', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'qa', state: 'queued', runId: 4, runState: 'waiting_lane', lane: 'stack' });
    const body = draw(card);

    expect(goButtons(body)).toHaveLength(0);
    expect(text(body)).toContain('QA waits to start It waits for the Stack lane.');
    expect(body).toContain('data-run="stop"');
    expect(text(body)).toContain('Remove from queue');
  });

  // A first run's wrap-up waits for what Learn wrote, and the panel says where the person answers it.
  it('says a card waits for a knowledge review, links Knowledge, and offers to take it off the queue', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'wrapup', state: 'queued', runId: 4, runState: 'waiting_review', lane: 'knowledge' });
    const body = draw(card);

    expect(goButtons(body)).toHaveLength(0);
    expect(text(body)).toContain('Waits for Knowledge Wrap-up writes knowledge, so it starts by itself once no change waits on Knowledge and no other knowledge run is going. Apply or return what waits there.');
    expect(body).toContain('href="/knowledge"');
    expect(text(body)).toContain('Remove from queue');
  });

  // A blocked card has no amber Move forward.
  it('sends a card that asks to its question, with no amber Move forward', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars or thumbs?' });
    const body = draw(card, { back: { to: 'refine', label: 'Refine' }, since: '15:02', phone: 'paid', threadHref: '/t/APP-1/discussion?thread=plan' });

    expect(goButtons(body)).toHaveLength(0);
    expect(body).not.toContain('data-move="implement"');
    expect(text(body)).toContain('The agent is waiting for you Plan stopped at 15:02 with one question. Nothing runs until you answer. Answer from your phone too Solo');
    expect(text(body)).not.toContain('Answer the question');
    expect(text(body)).toContain('Send back to Refine More actions Open the plan thread');
  });

  // On Free the phone line is drawn locked, from the display document, and the chip says Coming
  // soon.
  it('locks the phone line on Free, and draws none when the page passes no plan', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars or thumbs?' });

    expect(draw(card, { phone: 'free' })).toContain('data-phone="free"');
    expect(text(draw(card, { phone: 'free' }))).toContain('Answer from your phone too , locked on Free Coming soon');
    expect(draw(card)).not.toContain('data-phone');
    expect(text(draw(card))).not.toContain('Answer from your phone');
  });

  it('retries a failed card in amber, names the reason, and offers Run on as plain buttons', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'plan', state: 'failed', failureReason: 'The usage limit was reached.' });
    const body = draw(card, { retry: stage('plan'), runOn: { profiles: [{ id: 'claude-code#work', label: 'Work login' }], note: null } });

    expect(goButtons(body)).toHaveLength(1);
    expect(goButtons(body)[0]).toContain('data-run="retry"');
    expect(text(body)).toContain('Plan failed The usage limit was reached. Retry Plan');
    expect(text(body)).toContain('Run on Work login');
    expect(text(body)).toContain('A fresh run, because a session belongs to one profile.');
  });

  // Fix it is the one amber button, and it names both runs. Move back and Accept
  // anyway start nothing, so they stay plain. The left column holds the heading, the
  // reason and the QA thread, so the panel opens on Fix it and its foot holds the two moves alone.
  it('reads a QA FAIL as failed, with the amber Fix it naming both runs, Move back and Accept anyway', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' });
    const body = draw(card, { back: { to: 'implement', label: 'Implement' }, fixIt: fixItOf(card, board.stages), session: '3c91e0b4', threadHref: '/t/APP-1/discussion?thread=qa' });

    expect(goButtons(body)).toHaveLength(1);
    expect(goButtons(body)[0]).toContain('data-run="fix"');
    expect(text(body)).toContain('Next step Fix it: run Implement again with this reason, then QA');
    expect(text(body)).not.toContain('QA failed');
    expect(text(body)).not.toContain('The list stays empty.');
    expect(text(body)).not.toContain('Ready');
    // The picker line is the Implement row's, the one the first run starts on.
    expect(text(body)).toContain('Claude Code · sonnet · medium');
    expect(text(body)).not.toContain('this card only');
    expect(text(body)).toContain('Resumes implement session 3c91e0b4 with the reason. QA runs again after it.');
    expect(text(body)).toContain('Move back to Implement More actions Accept anyway, move to Review');
    expect(text(body)).not.toContain('thread');
    expect(text(body)).not.toContain('Minimize');
    expect(body).not.toMatch(/<button[^>]*class="[^"]*\bgo\b[^"]*"[^>]*data-move-back/);
  });

  it('says Implement starts fresh when no implement session is left', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' });

    expect(text(draw(card, { fixIt: fixItOf(card, board.stages) }))).toContain('Starts implement fresh with the reason, since no implement session is left. QA runs again after it.');
  });

  // The sum of both estimates, only where both runs were measured.
  it('shows the sum of both estimates on Fix it only when both were measured', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL' });
    const measure = (id: string, costUsd: number, lowMs: number, highMs: number): StageView => ({ ...stage(id), starts: { ...stage(id).starts!, estimate: { costUsd, lowMs, highMs, from: 'history', runs: 6 } } });
    const both = board.stages.map((one) => (one.id === 'implement' ? measure('implement', 0.3, 180_000, 360_000) : one.id === 'qa' ? measure('qa', 0.1, 60_000, 120_000) : one));
    const half = board.stages.map((one) => (one.id === 'implement' ? measure('implement', 0.3, 180_000, 360_000) : one));

    expect(text(draw(card, { fixIt: fixItOf(card, both) }))).toContain('about $0.40 · 4 to 8 min , Implement and QA together');
    expect(draw(card, { fixIt: fixItOf(card, half) })).not.toContain('class="figure');
  });

  it('takes the amber off Fix it when the QA row is refused', () => {
    const card = cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL', starts: { qa: { ...stage('qa').starts!, model: 'claude-retired-1', modelState: 'gone' } } });
    const body = draw(card, { fixIt: fixItOf(card, board.stages) });

    expect(goButtons(body)).toHaveLength(0);
    expect(body).toContain('data-run="fix"');
    expect(text(body)).toContain('QA uses claude-retired-1 , which Claude Code no longer offers.');
  });

  // Delete card is the last row of More actions, in red, and never the plain button, even when it is
  // the only other action.
  it('puts Delete card last in More actions, in red, never as the plain button', () => {
    const ondelete = () => {};
    const alone = draw(cardFixture({ key: 'APP-1' }), { ondelete });
    expect(alone).toMatch(/<button type="button" role="menuitem" class="danger[^"]*" data-delete-card[^>]*>Delete card<\/button>/);
    expect(text(alone)).toContain('More actions');

    const ready = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { back: { to: 'refine', label: 'Refine' }, threadHref: '/t/APP-1/discussion?thread=plan', ondelete });
    const rows = [...ready.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map((match) => match[1]);
    expect(rows.at(-1)).toBe('Delete card');
    expect(draw(cardFixture({ key: 'APP-1' }))).not.toContain('data-delete-card');
    expect(readFileSync(new URL('./DecisionPanel.svelte', import.meta.url), 'utf8')).toMatch(/\[role='menuitem'\]\.danger\) \{\s+color: var\(--red\);/);
  });

  it('draws nothing for a closed card', () => {
    expect(text(draw(cardFixture({ key: 'APP-1', stage: 'closed' })))).toBe('');
  });

  // The toast and the panel name the same model and the same fix.
  it('names a gone model in the toast words, with the link that fixes it, and takes the amber away', () => {
    const gone = { ...stage('implement'), starts: { ...stage('implement').starts!, model: 'claude-retired-1', modelState: 'gone' as const } };
    const body = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { next: gone, fix: { text: 'Pick another in the card settings.', label: 'Open card settings', href: '/t/APP-1/settings' } });

    expect(goButtons(body)).toHaveLength(0);
    expect(body).toContain('aria-disabled="true"');
    expect(text(body)).toContain('Implement uses claude-retired-1 , which Claude Code no longer offers. Pick another in the card settings. Open card settings');
    expect(body).toMatch(/<code[^>]*>claude-retired-1<\/code>/);
    expect(text(body)).not.toContain('is gone');
    expect(body).toContain('href="/t/APP-1/settings"');
  });

  it('offers a plain move into a stage that starts nothing', () => {
    const body = draw(cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'PASS' }));

    expect(goButtons(body)).toHaveLength(0);
    expect(text(body)).toContain('Move to Review');
  });
});

// Send back with comments resumes the implement session, so it is the one amber button,
// with the estimate only where runs measured one.
describe('Send back with comments', () => {
  const ready = cardFixture({ key: 'APP-1', stage: 'implement', state: 'ready' });

  it('is the amber start, says which session it goes on in, and offers the next step plain', () => {
    const body = draw(ready, { sendBack: sendBackOf(ready, board.stages, 2), session: '5d82f1e9' });

    expect(goButtons(body)).toHaveLength(1);
    expect(goButtons(body)[0]).toContain('data-run="send-back"');
    expect(text(body)).toContain('Send back to Implement with 2 comments');
    expect(text(body)).toContain('Goes on in the Implement session 5d82f1e9 with your 2 comments and their lines.');
    expect(text(body)).toContain('Move to QA instead');
    expect(text(body)).toContain('Starts: Claude Code · sonnet · medium');
    expect(text(body)).not.toContain('Approve and start QA');
  });

  it('says it starts Implement fresh when no session is left', () => {
    expect(text(draw(ready, { sendBack: sendBackOf(ready, board.stages, 1) }))).toContain('Starts Implement fresh with your comment, since no Implement session is left.');
  });

  it('is offered on a card in Review beside Send back, and the plain move there starts nothing', () => {
    const review = cardFixture({ key: 'APP-1', stage: 'review', state: 'idle' });
    const body = draw(review, { sendBack: sendBackOf(review, board.stages, 1), back: { to: 'qa', label: 'QA' } });

    expect(goButtons(body)).toHaveLength(1);
    expect(text(body)).toContain('Send back to Implement with 1 comment');
    expect(text(body)).toContain('Send back to QA');
    expect(text(body)).not.toContain('Starts:');
  });

  it('shows the estimate only when runs measured one', () => {
    const measured = { ...stage('implement'), starts: { ...stage('implement').starts!, estimate: { costUsd: 0.15, lowMs: 120_000, highMs: 240_000, from: 'history' as const, runs: 6 } } };
    const stages = board.stages.map((one) => (one.id === 'implement' ? measured : one));

    expect(text(draw(ready, { sendBack: sendBackOf(ready, stages, 1) }))).toContain('about $0.15 · 2 to 4 min , from 6 runs in this project');
    expect(draw(ready, { sendBack: sendBackOf(ready, board.stages, 1) })).not.toContain('class="figure');
  });
});

// The panel beside the Review tab of a pull request card a push sent back to Incoming: the next round
// starts an agent, so Agent pre-review is the amber button, under the line that says
// why another round makes sense.
describe('the next review round on the Review tab', () => {
  const pr = (estimate?: { costUsd: number; lowMs: number; highMs: number; from: 'history'; runs: number }): StageView =>
    stageFixture({ id: 'pre-review', label: 'Agent pre-review', role: 'agent', starts: { phase: 'pr-review', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'ok', refusal: null, ...(estimate === undefined ? {} : { estimate }) } });
  const waiting = cardFixture({ key: 'recipes#42', stage: 'incoming', state: 'idle', pull: { author: 'dana', decision: 'CHANGES_REQUESTED', headCommittedAt: null, draft: false, round: 2, newCommits: 1 } });
  const panel = (props: Record<string, unknown> = {}) =>
    render(DecisionPanel, { props: { card: waiting, stage: 'Incoming', next: pr(), onmove: noop, ...props } }).body;
  const findings = { text: 'issue: src/recipes/import.ts:88\nOne bad file stops the whole import.', round: 2 };

  it('says why another round makes sense over the amber Agent pre-review button, naming the new commits', () => {
    const body = panel({ why: 'dana pushed 1 commit after round 2. 3 findings from round 2 are still open.' });

    expect(goButtons(body)).toHaveLength(1);
    expect(goButtons(body)[0]).toContain('data-move="pre-review"');
    expect(text(body)).toContain('Next step dana pushed 1 commit after round 2. 3 findings from round 2 are still open. Start Agent pre-review');
  });

  it('draws no reason line when the page hands over none', () => {
    expect(panel()).not.toContain('data-why');
  });

  // No figure that nothing measured.
  it('shows what the next round costs only when runs measured it', () => {
    expect(text(panel({ next: pr({ costUsd: 0.18, lowMs: 120_000, highMs: 240_000, from: 'history', runs: 4 }) }))).toContain('about $0.18 · 2 to 4 min , from 4 runs in this project');
    expect(text(panel())).not.toContain('about $');
    expect(panel()).not.toContain('class="figure');
  });

  it('offers Copy all findings in the foot, plain, for the shown round as conventional comments', () => {
    const body = panel({ findings });

    expect(text(body)).toContain('Copy all findings round 2, as conventional comments');
    expect(body).toMatch(/<button[^>]*data-copy-all/);
    expect(body.match(/<button[^>]*data-copy-all[^>]*>/)?.[0]).not.toMatch(/\bgo\b/);
    expect(panel()).not.toContain('data-copy-all');
  });
});

// One plain button under the go button, every other action in More actions, a menu button with
// its menu of rows. The rows stay in the page, hidden, while the menu is shut.
it('draws one plain action under the go button and the rest in More actions', () => {
  const card = cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' });
  const body = draw(card, {
    back: { to: 'implement', label: 'Implement' },
    fixIt: fixItOf(card, board.stages),
    findings: { text: 'praise:\nFine.', round: 1 },
  });
  const menu = /<div class="menu[^"]*" id="([^"]+)" role="menu"[^>]*hidden[^>]*>([\s\S]*?)<\/div>/.exec(body);
  const button = /<button[^>]*data-more[^>]*>/.exec(body)?.[0] ?? '';

  expect(body).toMatch(/<button[^>]*data-move-back="implement"/);
  expect(menu?.[2]).not.toContain('data-move-back');
  expect([...(menu?.[2] ?? '').matchAll(/role="menuitem"[^>]*data-(accept|run-on|copy-all)/g)].map((one) => one[1])).toEqual(['accept', 'copy-all']);
  expect(button).toContain('aria-haspopup="menu"');
  expect(button).toContain('aria-expanded="false"');
  expect(button).toContain(`aria-controls="${menu?.[1]}"`);
  expect(goButtons(body)).toHaveLength(1);
  // Run on a failed card is a row too, after the plain Send back.
  const failed = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'failed', failureReason: 'The usage limit was reached.' }), {
    retry: stage('plan'),
    back: { to: 'refine', label: 'Refine' },
    runOn: { profiles: [{ id: 'claude-code#work', label: 'Work login' }], note: null },
  });
  expect(failed).toMatch(/role="menuitem"[^>]*data-run-on="claude-code#work"[^>]*>Run on Work login/);
  // One action needs no menu.
  expect(draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { back: { to: 'refine', label: 'Refine' } })).not.toContain('data-more');
});

// The scope of a pick is said on hover and with the model select, not as a line under the picker.
it('says the picker applies to this card only in its title and description', () => {
  const picker = { action: 'implement', engine: 'claude-code', model: 'sonnet', effort: 'medium', profiles: [{ id: 'claude-code', label: 'Claude Code', models: ['sonnet'] }] };
  const body = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { picker });
  const id = /<select data-pick="model"[^>]*aria-describedby="([^"]+)"/.exec(body)?.[1];

  expect(body).toContain('title="Applies to this card only"');
  expect(body).toMatch(new RegExp(`id="${id}">Applies to this card only<`));
  expect(text(body)).not.toContain('this card only Applies');
});

// The quiet actions under Next step are one column of full-width rows, text on the left.
it('lays the quiet actions out as one column of full-width rows', () => {
  const source = readFileSync(new URL('./DecisionPanel.svelte', import.meta.url), 'utf8');
  const foot = /\n {2}\.foot \{([^}]*)\}/.exec(source)?.[1] ?? '';

  expect(foot).toContain('flex-direction: column;');
  expect(foot).toContain('align-items: stretch;');
  expect(source).toMatch(/\.foot > :global\(button\) \{\s*justify-content: flex-start;/);
  // The order stays: send back, instead, accept, Run on, the copy, then the thread.
  const body = draw(cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' }), { back: { to: 'refine', label: 'Refine' }, threadHref: '/t/APP-1/discussion?thread=plan' });
  expect(text(body)).toMatch(/Send back to Refine More actions Ask about the plan/);
});
