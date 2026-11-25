import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StageView } from '@nolzu/protocol';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../test/mounted.svelte.ts';
import { stageFixture } from './board/fixture.ts';
import StartConfirm from './StartConfirm.svelte';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

let page: Mounted<Record<string, unknown>> | null = null;
let opener: HTMLButtonElement | null = null;
afterEach(() => {
  page?.remove();
  page = null;
  opener?.remove();
  opener = null;
});

const stage = (modelState: 'ok' | 'gone'): StageView =>
  stageFixture({ id: 'implement', label: 'Implement', role: 'agent', starts: { phase: 'implement', model: 'sonnet', effort: 'high', engine: 'claude-code', modelState, refusal: null } });

function draw(state: 'ok' | 'gone' = 'ok') {
  opener = document.body.appendChild(document.createElement('button'));
  opener.focus();
  const onconfirm = vi.fn();
  const onclose = vi.fn();
  page = mounted(StartConfirm as never, { title: 'Retry APP-3 in Implement', stage: stage(state), onconfirm, onclose });
  const dialog = page.target.querySelector('dialog')!;
  const confirm = dialog.querySelector<HTMLButtonElement>('[data-confirm]')!;
  return { dialog, confirm, onconfirm, onclose };
}

describe('StartConfirm', () => {
  it('shows the Starts line a drop shows, with focus on Confirm so Enter presses it', () => {
    const ui = draw();

    expect(ui.dialog.textContent).toContain('Starts: Claude Code · sonnet · high');
    expect(ui.dialog.textContent).toContain('Runs on this machine, in your checkout.');
    expect(document.activeElement).toBe(ui.confirm);
    expect(ui.confirm.type).toBe('submit');
    expect(ui.confirm.getAttribute('aria-disabled')).toBeNull();
    expect(ui.dialog.getAttribute('aria-describedby')).toBe(ui.dialog.querySelector('.starts')!.id);
  });

  // The confirm has room to say where the figure came from, and a screen reader hears it.
  it('shows the estimate and where it came from under the Starts line', () => {
    opener = document.body.appendChild(document.createElement('button'));
    const measured = stage('ok');
    measured.starts!.estimate = { costUsd: 0.4, lowMs: 6 * 60_000, highMs: 10 * 60_000, from: 'history', runs: 8 };
    page = mounted(StartConfirm as never, { title: 'Retry APP-3 in Implement', stage: measured, onconfirm: vi.fn(), onclose: vi.fn() });
    const dialog = page.target.querySelector('dialog')!;
    const line = dialog.querySelector('.estimate')!;

    expect(line.textContent).toBe('about $0.40 · 6 to 10 min, from 8 runs in this project');
    expect(dialog.getAttribute('aria-describedby')).toBe(`${dialog.querySelector('.starts')!.id} ${line.id}`);
  });

  // R on a QA FAIL is Fix it: one Confirm starts Implement and, once it ends ready, QA. One
  // press is the consent for both. Both runs are named, the figure is their sum, and either refusal turns Confirm off.
  it('names both runs of Fix it, sums both estimates, and refuses when either run is refused', () => {
    opener = document.body.appendChild(document.createElement('button'));
    const implement = stage('ok');
    implement.starts!.estimate = { costUsd: 0.3, lowMs: 3 * 60_000, highMs: 6 * 60_000, from: 'history', runs: 8 };
    const qa = stageFixture({ id: 'qa', label: 'QA', role: 'agent', starts: { phase: 'qa', model: 'sonnet', effort: 'medium', engine: 'claude-code', modelState: 'ok', refusal: null, estimate: { costUsd: 0.1, lowMs: 60_000, highMs: 2 * 60_000, from: 'history', runs: 5 } } });
    page = mounted(StartConfirm as never, { title: 'Fix APP-3: Implement, then QA', stage: implement, then: qa, onconfirm: vi.fn(), onclose: vi.fn() });
    const dialog = page.target.querySelector('dialog')!;

    expect(dialog.querySelector('.starts')!.textContent).toBe('Starts: Claude Code · sonnet · high, then Claude Code · sonnet · medium');
    expect(dialog.querySelector('.estimate')!.textContent).toBe('about $0.40 · 4 to 8 min, Implement and QA together');

    page.set({ then: { ...qa, starts: { ...qa.starts!, model: 'claude-retired-1', modelState: 'gone' } } });
    expect(dialog.querySelector('[data-confirm]')!.getAttribute('aria-disabled')).toBe('true');
    expect(dialog.textContent).toContain('claude-retired-1 is gone.');
  });

  // The usage window the drop box shows, for the profile the run starts on, read out with the rest.
  it('shows the usage window of the engine the run starts on, as the drop box does', () => {
    opener = document.body.appendChild(document.createElement('button'));
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const limits = { 'claude-code': { seenAt: Date.now() - 60_000, windows: [{ name: 'five_hour', used: 0.62, resetsAt, status: 'allowed' }] } };
    page = mounted(StartConfirm as never, { title: 'Move APP-3 to Implement', stage: stage('ok'), limits, onconfirm: vi.fn(), onclose: vi.fn() });
    const dialog = page.target.querySelector('dialog')!;
    const line = dialog.querySelector('.usage')!;
    const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(resetsAt * 1000);

    expect(line.textContent).toBe(`5h window 62% · resets ${time}`);
    expect(dialog.getAttribute('aria-describedby')).toBe(`${dialog.querySelector('.starts')!.id} ${line.id}`);
  });

  // Read by the clock, as the drop box reads it, so a window that reset since shows no figure.
  it('shows no usage window once that window has reset', () => {
    opener = document.body.appendChild(document.createElement('button'));
    const limits = { 'claude-code': { seenAt: Date.now() - 2 * 3_600_000, windows: [{ name: 'five_hour', used: 0.62, resetsAt: Math.floor(Date.now() / 1000) - 60, status: 'allowed' }] } };
    page = mounted(StartConfirm as never, { title: 'Move APP-3 to Implement', stage: stage('ok'), limits, onconfirm: vi.fn(), onclose: vi.fn() });
    const dialog = page.target.querySelector('dialog')!;

    expect(dialog.querySelector('.usage')).toBeNull();
    expect(dialog.getAttribute('aria-describedby')).toBe(dialog.querySelector('.starts')!.id);
  });

  // Amber is for the go button alone. The figure is text, so it takes an ink tokens.test.ts measures.
  // No render test sees a colour, so this reads the classes of the line out of the source.
  it('writes the estimate line in text inks, never in amber', () => {
    const source = readFileSync(join(import.meta.dirname, 'StartConfirm.svelte'), 'utf8');
    const line = /<p class="estimate"[\s\S]*?<\/p>/.exec(source)![0];
    const style = source.slice(source.indexOf('<style>')).replaceAll(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const colour = (name: string) =>
      rules
        .filter((rule) => rule[1]!.split(',').some((selector) => selector.trim() === `.${name}`))
        .map((rule) => /(?:^|[\s;])color:\s*var\(--([a-z0-9-]+)\)/.exec(rule[2]!)?.[1])
        .filter((found) => found !== undefined)
        .pop();
    const used = [...line.matchAll(/class="([a-z][a-z0-9- ]*)"/g)].flatMap((tag) => tag[1]!.split(' ')).map(colour);

    expect(used).toEqual(['muted', 'ink-2']);
  });

  it('starts the run once on Confirm, and closes', () => {
    const ui = draw();

    ui.confirm.click();

    expect(ui.onconfirm).toHaveBeenCalledOnce();
    expect(ui.dialog.open).toBe(false);
    expect(ui.onclose).toHaveBeenCalledOnce();
    // Before the close, so the caller still knows which card the confirm was for.
    expect(ui.onconfirm.mock.invocationCallOrder[0]).toBeLessThan(ui.onclose.mock.invocationCallOrder[0]!);
  });

  // After a click on the dialog's text, focus is on the box, where Enter would otherwise press nothing.
  it('confirms on Enter with focus on the dialog box', () => {
    const ui = draw();

    ui.dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(ui.onconfirm).toHaveBeenCalledOnce();
  });

  // Enter on a focused button is that button's own key, so Enter on Cancel never starts the run.
  it('leaves Enter on Cancel to Cancel, and starts nothing', () => {
    const ui = draw();
    const cancel = ui.dialog.querySelector<HTMLButtonElement>('button:not([data-confirm])')!;
    cancel.focus();

    cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(ui.onconfirm).not.toHaveBeenCalled();
  });

  it('cancels on Cancel, starts nothing, and gives focus back', () => {
    const ui = draw();

    ui.dialog.querySelector<HTMLButtonElement>('button:not([data-confirm])')!.click();

    expect(ui.onconfirm).not.toHaveBeenCalled();
    expect(ui.onclose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
  });

  it('shows the refusal and starts nothing when the model is gone', () => {
    const ui = draw('gone');

    expect(ui.dialog.textContent).toContain('sonnet is gone. Pick another model in the card settings, or in Settings, Models.');
    expect(ui.dialog.textContent).not.toContain('Starts:');
    expect(ui.confirm.getAttribute('aria-disabled')).toBe('true');
    ui.confirm.click();
    expect(ui.onconfirm).not.toHaveBeenCalled();
    expect(ui.dialog.open).toBe(true);
  });

  it('turns Confirm off when a snapshot says the model went while it was open', () => {
    const ui = draw();

    page!.set({ stage: stage('gone') });

    expect(ui.confirm.getAttribute('aria-disabled')).toBe('true');
    ui.confirm.click();
    expect(ui.onconfirm).not.toHaveBeenCalled();
  });
});
