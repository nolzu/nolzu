import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import DeleteCardDialog from './DeleteCardDialog.svelte';

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
afterEach(() => {
  page?.remove();
  page = null;
});

const CHECK = {
  refused: null,
  goes: 'This deletes APP-3, its runs, its discussion and its history on the board. The time and cost of its runs stay in the timesheet.',
  warnings: [
    { text: 'The checkout of the project folder is removed. It has 3 changed files and 2 commits not pushed. The changed files are lost.', loses: true },
    { text: 'The branch feature/app-3 stays, so its commits are not lost.', loses: false },
  ],
  folder: '.tasks/APP-3',
  keepsBranch: true,
};

function draw(props: Record<string, unknown> = {}) {
  const onconfirm = vi.fn();
  const onclose = vi.fn();
  const onrecheck = vi.fn(async () => {});
  page = mounted(DeleteCardDialog as never, { cardKey: 'APP-3', check: CHECK, onconfirm, onclose, onrecheck, ...props });
  const dialog = page.target.querySelector('dialog')!;
  return { dialog, confirm: dialog.querySelector<HTMLButtonElement>('[data-confirm]')!, box: dialog.querySelector<HTMLInputElement>('[data-delete-folder]'), onconfirm, onclose, onrecheck };
}

describe('DeleteCardDialog', () => {
  it('says what goes and shows each warning, with the folder box off', () => {
    const ui = draw();

    expect(ui.dialog.textContent).toContain('Delete APP-3');
    expect(ui.dialog.textContent).toContain('This cannot be undone.');
    expect(ui.dialog.textContent).toContain(CHECK.goes);
    const lines = [...ui.dialog.querySelectorAll('[data-delete-warnings] li')];
    expect(lines.map((li) => li.textContent)).toEqual(CHECK.warnings.map((one) => one.text));
    // Only the line that loses something sits on the red tint.
    expect(lines.map((li) => li.classList.contains('loses'))).toEqual([true, false]);
    expect(ui.box?.checked).toBe(false);
    expect(ui.dialog.textContent).toContain('Also delete the card folder .tasks/APP-3');
    expect(ui.dialog.textContent).toContain('A card added later on this key, such as this ticket added again, picks up this folder and its branch.');
    expect(ui.confirm.classList.contains('danger')).toBe(true);
    expect(ui.confirm.disabled).toBe(false);
  });

  it('sends the box as it is: off by default, on once ticked', () => {
    const ui = draw();
    ui.confirm.click();
    expect(ui.onconfirm).toHaveBeenLastCalledWith(false);

    ui.box!.click();
    ui.confirm.click();
    expect(ui.onconfirm).toHaveBeenLastCalledWith(true);
  });

  it('names the branch in the folder note only when a branch stays', () => {
    expect(draw({ check: { ...CHECK, keepsBranch: false } }).dialog.textContent).toContain('such as this ticket added again, picks up this folder.');
  });

  it('draws no box for a card with no folder', () => {
    expect(draw({ check: { ...CHECK, folder: null } }).box).toBeNull();
  });

  it('says why while the card runs, and offers Check again in place of Delete card', () => {
    const ui = draw({ check: { ...CHECK, refused: 'APP-3 has a run going. Stop the run first, then delete the card.' } });

    expect(ui.dialog.querySelector('[data-confirm]')).toBeNull();
    expect(ui.dialog.querySelector('[role="alert"]')?.textContent).toBe('APP-3 has a run going. Stop the run first, then delete the card.');
    ui.dialog.querySelector<HTMLButtonElement>('[data-recheck]')!.click();
    expect(ui.onrecheck).toHaveBeenCalledOnce();
    expect(ui.onconfirm).not.toHaveBeenCalled();
  });

  it('waits for the check before the button turns on', () => {
    const ui = draw({ check: null });
    expect(ui.dialog.textContent).toContain('Reading the card and its checkout.');
    expect(ui.confirm.disabled).toBe(true);
  });
});
