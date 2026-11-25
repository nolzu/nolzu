import { type Component, createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../test/mounted.svelte.ts';
import ConfirmTyped from './ConfirmTyped.svelte';
import Dialog from './Dialog.svelte';

// jsdom has the dialog element but none of its modal half. This gives it the two calls the parts use,
// and no more: showModal only opens, so a test proves the part moves focus itself, and close fires the
// close event as the browser does.
function fakeModal(): void {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

// Esc as a browser handles it: the keydown first, then a cancel, and a close when neither was
// prevented. Answers whether the dialog closed.
function pressEsc(dialog: HTMLDialogElement): boolean {
  const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  dialog.dispatchEvent(key);
  if (key.defaultPrevented) return false;
  const cancel = new Event('cancel', { cancelable: true });
  dialog.dispatchEvent(cancel);
  if (cancel.defaultPrevented) return false;
  dialog.close();
  return true;
}

beforeAll(fakeModal);

let page: Mounted<Record<string, unknown>> | null = null;
let opener: HTMLButtonElement | null = null;
afterEach(() => {
  page?.remove();
  page = null;
  opener?.remove();
  opener = null;
});

// The button that opened the dialog, which has focus when it opens.
function pressOpener(): HTMLButtonElement {
  opener = document.body.appendChild(document.createElement('button'));
  opener.focus();
  return opener;
}

const html = (markup: string) => createRawSnippet(() => ({ render: () => markup }));

describe('Dialog', () => {
  function draw(props: Record<string, unknown> = {}, body = '<div><button type="button" data-first>First</button><input data-field autofocus></div>') {
    const onclose = vi.fn();
    page = mounted(Dialog as never, { title: 'Keys on the board', onclose, children: html(body), ...props });
    const dialog = page.target.querySelector('dialog')!;
    return { dialog, onclose };
  }

  it('opens as a modal with the title as its name and focus on the field marked autofocus', () => {
    pressOpener();
    const { dialog } = draw();

    expect(dialog.open).toBe(true);
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Keys on the board');
    expect(document.activeElement).toBe(dialog.querySelector('[data-field]'));
  });

  it('moves focus to the first control when nothing is marked autofocus', () => {
    pressOpener();
    const { dialog } = draw({}, '<p>Move between cards <button type="button" data-first>First</button></p>');

    expect(document.activeElement).toBe(dialog.querySelector('[data-first]'));
  });

  it('closes on Esc and gives focus back to what opened it', () => {
    const button = pressOpener();
    const { dialog, onclose } = draw();

    expect(pressEsc(dialog)).toBe(true);

    expect(dialog.open).toBe(false);
    expect(onclose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button);
  });

  it('stays open on Esc while the caller holds it, and closes once it lets go', () => {
    pressOpener();
    const { dialog, onclose } = draw({ held: true });

    expect(pressEsc(dialog)).toBe(false);
    // The keydown itself is held, because a browser closes on a second Esc through a cancel it does
    // not let a page prevent.
    const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    dialog.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    // A cancel the browser sends without the keydown is held too.
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(true);
    expect(onclose).not.toHaveBeenCalled();

    page!.set({ held: false });
    expect(pressEsc(dialog)).toBe(true);
    expect(onclose).toHaveBeenCalledOnce();
  });

  // Focus can fall to the body while a dialog is open, such as when the pressed button turns off. The
  // keydown then starts on the body, and is held all the same.
  it('holds an Esc that starts outside the dialog while the caller holds it', () => {
    pressOpener();
    const { dialog, onclose } = draw({ held: true });
    (document.activeElement as HTMLElement).blur();

    const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(key);

    expect(key.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(true);
    expect(onclose).not.toHaveBeenCalled();
  });

  // Only Esc waits. Tab and typing still work while a card is on its way.
  it('lets every other key through while the caller holds it', () => {
    pressOpener();
    const { dialog } = draw({ held: true });

    for (const name of ['Tab', 'a', 'Enter']) {
      const key = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
      dialog.querySelector('[data-field]')!.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(false);
    }
  });

  it('draws the footer buttons the caller hands it, under the body', () => {
    pressOpener();
    const { dialog } = draw({ footer: html('<button type="button" data-close>Close</button>') });

    const footer = dialog.querySelector('[data-close]')!;
    expect(dialog.querySelector('[data-field]')!.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // The keyboard help has no footer, so its close button sits at the right of the title.
  it('draws a named close button beside the title when asked, which closes like Esc', () => {
    const button = pressOpener();
    const { dialog, onclose } = draw({ closer: 'Close keyboard help' }, '<p>Keys</p>');
    const close = dialog.querySelector<HTMLButtonElement>('.head [data-closer]')!;

    expect(close.getAttribute('aria-label')).toBe('Close keyboard help');
    expect(dialog.querySelector('.head kbd')?.getAttribute('aria-hidden')).toBe('true');
    // The first control, so focus starts on it when the body has none.
    expect(document.activeElement).toBe(close);
    close.click();
    expect(dialog.open).toBe(false);
    expect(onclose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button);
  });

  // A held dialog keeps its answer coming, so its close button waits with Esc.
  it('turns its close button off while held, and draws Add card at its own width', () => {
    pressOpener();
    const { dialog, onclose } = draw({ closer: 'Close without adding', held: true, medium: true });
    const close = dialog.querySelector<HTMLButtonElement>('[data-closer]')!;

    expect(close.disabled).toBe(true);
    close.click();
    expect(onclose).not.toHaveBeenCalled();
    expect(dialog.classList.contains('medium')).toBe(true);
    page!.set({ held: false });
    flushSync();
    expect(close.disabled).toBe(false);
  });

  // jsdom lays nothing out, so the box is given a place: 100 to 300 across and down. A press on the
  // backdrop lands on the dialog element itself, outside that box.
  function press(dialog: HTMLDialogElement, down: { at: [number, number]; on?: Element }, up: { at: [number, number]; on?: Element } = down): void {
    dialog.getBoundingClientRect = () => ({ left: 100, top: 100, right: 300, bottom: 300, width: 200, height: 200, x: 100, y: 100, toJSON: () => ({}) });
    (down.on ?? dialog).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: down.at[0], clientY: down.at[1] }));
    (up.on ?? dialog).dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: up.at[0], clientY: up.at[1] }));
  }

  it('closes on a click on the backdrop and gives focus back', () => {
    const button = pressOpener();
    const { dialog, onclose } = draw();

    press(dialog, { at: [20, 20] });

    expect(dialog.open).toBe(false);
    expect(onclose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button);
  });

  it('stays open on a click inside the box, even on its own edge', () => {
    pressOpener();
    const { dialog, onclose } = draw();

    press(dialog, { at: [150, 150], on: dialog.querySelector('[data-field]')! });
    press(dialog, { at: [100, 200] });

    expect(dialog.open).toBe(true);
    expect(onclose).not.toHaveBeenCalled();
  });

  // Selecting text with the mouse often ends past the box. The click then lands on the dialog element
  // outside it, and must not throw the text away.
  it('stays open after a drag that starts inside the box and ends on the backdrop', () => {
    pressOpener();
    const { dialog, onclose } = draw();

    press(dialog, { at: [150, 150], on: dialog.querySelector('[data-field]')! }, { at: [20, 20] });

    expect(dialog.open).toBe(true);
    expect(onclose).not.toHaveBeenCalled();
  });

  it('stays open on a backdrop click while the caller holds it', () => {
    pressOpener();
    const { dialog, onclose } = draw({ held: true });

    press(dialog, { at: [20, 20] });

    expect(dialog.open).toBe(true);
    expect(onclose).not.toHaveBeenCalled();
    page!.set({ held: false });
    press(dialog, { at: [20, 20] });
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('draws no close button of its own unless asked', () => {
    pressOpener();
    const { dialog } = draw();

    expect(dialog.querySelector('[data-closer]')).toBeNull();
    expect(dialog.classList.contains('wide')).toBe(false);
    page!.remove();
    page = null;
    expect(draw({ wide: true }).dialog.classList.contains('wide')).toBe(true);
  });
});

describe('ConfirmTyped', () => {
  const LOST = ['Deletes the folder web and every file in it.', 'Its knowledge file stays.'];

  function draw(props: Record<string, unknown> = {}) {
    const onconfirm = vi.fn();
    const onclose = vi.fn();
    page = mounted(ConfirmTyped as never, {
      title: 'Remove repository web',
      sub: 'From the project recipes. This cannot be undone.',
      name: 'web',
      lost: LOST,
      action: 'Remove web',
      onconfirm,
      onclose,
      ...props,
    });
    const target = page.target;
    const dialog = target.querySelector('dialog')!;
    const field = dialog.querySelector('input')!;
    const confirm = dialog.querySelector<HTMLButtonElement>('[data-confirm]')!;
    const type = (value: string) => {
      field.value = value;
      field.dispatchEvent(new Event('input'));
      flushSync();
    };
    return { dialog, field, confirm, type, onconfirm, onclose };
  }

  it('lists what is lost before the field, and reads it out as the alert dialog description', () => {
    pressOpener();
    const ui = draw();
    const lost = ui.dialog.querySelector('.lost')!;

    expect(ui.dialog.getAttribute('role')).toBe('alertdialog');
    expect(ui.dialog.getAttribute('aria-describedby')).toBe(lost.id);
    expect([...lost.querySelectorAll('li')].map((line) => line.textContent)).toEqual(LOST);
    expect(lost.compareDocumentPosition(ui.field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ui.dialog.querySelector(`label[for="${ui.field.id}"]`)?.textContent).toBe('Type web to confirm');
  });

  // In order: what it deletes, then the red box for work that exists nowhere else, then what stays.
  it('puts work that cannot come back in the red box after the list, reads both out, and says what stays', () => {
    pressOpener();
    const ui = draw({ gone: ['APP-1 has 2 commits that are not pushed. They are lost.'], kept: 'GitHub keeps the repository. You can add it again later.' });
    const lost = ui.dialog.querySelector('.lost')!;
    const gone = ui.dialog.querySelector('.gone')!;
    const kept = ui.dialog.querySelector('.kept')!;

    expect(ui.dialog.getAttribute('aria-describedby')).toBe(`${lost.id} ${gone.id}`);
    expect(gone.textContent).toBe('APP-1 has 2 commits that are not pushed. They are lost.');
    expect(kept.textContent).toBe('GitHub keeps the repository. You can add it again later.');
    const order = [lost, gone, kept, ui.field];
    for (let index = 1; index < order.length; index += 1) expect(order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws no red box and no kept line when there is nothing for them', () => {
    pressOpener();
    const ui = draw();

    expect(ui.dialog.querySelector('.gone')).toBeNull();
    expect(ui.dialog.querySelector('.kept')).toBeNull();
  });

  // The check pass of Remove ticks what holds, before the field.
  it('ticks each check that holds, before the name field', () => {
    pressOpener();
    const ui = draw({ checked: ['No card has a checkout of it', 'Nothing uncommitted, no stash'] });
    const checked = ui.dialog.querySelector('.checked')!;

    expect([...checked.querySelectorAll('li')].map((line) => line.textContent)).toEqual(['No card has a checkout of it', 'Nothing uncommitted, no stash']);
    expect(checked.compareDocumentPosition(ui.field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // A check failed: the confirm asks for no name, the button stays off, and a submit a script sends does
  // nothing, so the work in the red box is never lost.
  it('asks for no name and keeps the button off while a check failed', () => {
    pressOpener();
    const ui = draw({ gone: ['APP-1 has a checkout of web, so web stays.'], blocked: true });

    expect(ui.dialog.querySelector('input')).toBeNull();
    expect(ui.confirm.disabled).toBe(true);
    ui.dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    flushSync();
    expect(ui.onconfirm).not.toHaveBeenCalled();
    // Focus lands on Cancel, the one control that can act.
    expect(document.activeElement?.textContent?.trim().startsWith('Cancel')).toBe(true);
  });

  // A check that answers after the name was typed turns the confirm off, and a submit does nothing.
  it('turns the button off and ignores a submit when a check fails after the name was typed', () => {
    pressOpener();
    const ui = draw();
    ui.type('web');
    expect(ui.confirm.disabled).toBe(false);

    page!.set({ gone: ['APP-1 has a checkout of web, so web stays.'], blocked: true });
    expect(ui.confirm.disabled).toBe(true);
    ui.dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    flushSync();
    expect(ui.onconfirm).not.toHaveBeenCalled();
  });

  it('puts focus in the name field when it opens', () => {
    pressOpener();
    const ui = draw();

    expect(document.activeElement).toBe(ui.field);
  });

  it('keeps the button off for a wrong name and turns it on for the exact name', () => {
    pressOpener();
    const ui = draw();
    expect(ui.confirm.disabled).toBe(true);

    ui.type('we');
    expect(ui.confirm.disabled).toBe(true);
    ui.type('web ');
    expect(ui.confirm.disabled).toBe(true);
    ui.type('web');
    expect(ui.confirm.disabled).toBe(false);
    expect(ui.confirm.textContent?.trim()).toBe('Remove web');
  });

  it('confirms once the exact name is typed, and never before', () => {
    pressOpener();
    const ui = draw();
    const submit = () => ui.dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

    ui.type('Web');
    submit();
    expect(ui.onconfirm).not.toHaveBeenCalled();

    ui.type('web');
    ui.confirm.click();
    expect(ui.onconfirm).toHaveBeenCalledOnce();
    // The caller gets what was typed, so the server can check the name again.
    expect(ui.onconfirm).toHaveBeenCalledWith('web');
  });

  // Nothing starts a run, so the button is red and never amber or the cream primary.
  it('draws the confirm as the danger button', () => {
    pressOpener();
    const ui = draw();

    expect(ui.confirm.classList.contains('danger')).toBe(true);
    expect(['go', 'primary'].filter((name) => ui.confirm.classList.contains(name))).toEqual([]);
  });

  it('closes on Cancel and on Esc, gives focus back, and confirms nothing', () => {
    const button = pressOpener();
    const ui = draw();
    ui.type('web');

    ui.dialog.querySelector<HTMLButtonElement>('button.ghost')!.click();
    flushSync();
    expect(ui.onclose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button);
    page?.remove();

    pressOpener();
    const again = draw();
    expect(pressEsc(again.dialog)).toBe(true);
    expect(again.onclose).toHaveBeenCalledOnce();
    expect(ui.onconfirm).not.toHaveBeenCalled();
    expect(again.onconfirm).not.toHaveBeenCalled();
  });

  // As a caller does it: the name is typed, the button is pressed, and the caller holds the dialog.
  it('holds Esc, Cancel and the button while the action runs', () => {
    pressOpener();
    const ui = draw();
    ui.type('web');
    ui.confirm.focus();
    page!.set({ held: true });

    expect(pressEsc(ui.dialog)).toBe(false);
    // The pressed button stays focusable, so the focus stays in the dialog and only the words say held.
    expect(ui.confirm.disabled).toBe(false);
    expect(ui.confirm.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(ui.confirm);
    expect(ui.confirm.getAttribute('aria-busy')).toBe('true');
    // A second press, Enter or a submit a script sends all confirm nothing while the action runs.
    ui.confirm.click();
    ui.dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(ui.onconfirm).not.toHaveBeenCalled();
    expect(ui.dialog.querySelector<HTMLButtonElement>('button.ghost')!.disabled).toBe(true);
    expect(ui.onclose).not.toHaveBeenCalled();
  });

  // Once the action worked, the caller closes it through close(), so focus goes back as it does on Cancel.
  it('closes through close() after a confirm, and gives focus back to what opened it', () => {
    const button = pressOpener();
    const onconfirm = vi.fn();
    const onclose = vi.fn();
    const target = document.body.appendChild(document.createElement('div'));
    const shown = mount(ConfirmTyped as unknown as Component<Record<string, unknown>, { close: () => void }>, { target, props: { title: 'Remove repository web', name: 'web', lost: LOST, action: 'Remove web', onconfirm, onclose } });
    flushSync();
    const field = target.querySelector('input')!;
    field.value = 'web';
    field.dispatchEvent(new Event('input'));
    flushSync();
    target.querySelector<HTMLButtonElement>('[data-confirm]')!.click();

    shown.close();
    flushSync();

    expect(onconfirm).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
    expect(target.querySelector('dialog')!.open).toBe(false);
    expect(document.activeElement).toBe(button);
    void unmount(shown);
    target.remove();
  });
});
