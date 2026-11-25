// The parts of a pointer event and of the dialog element this reads, so the package keeps no DOM types.
interface Press {
  target: unknown;
  clientX: number;
  clientY: number;
}
interface Backdrop {
  getBoundingClientRect(): { left: number; right: number; top: number; bottom: number };
  addEventListener(type: 'pointerdown' | 'click', listener: (event: Press) => void): void;
  removeEventListener(type: 'pointerdown' | 'click', listener: (event: Press) => void): void;
}

// A click on the backdrop of a modal dialog closes it, as Esc does. Every `Dialog` has it, and the
// command palette, which draws its own dialog, uses it too. `held` keeps it open, as it keeps Esc.
export function closeOnBackdrop(close: () => void, held: () => boolean = () => false): (dialog: Backdrop) => () => void {
  return (dialog) => {
    // A press on the backdrop lands on the dialog element itself, outside its box. The box is measured
    // rather than trusting the target alone, because the box has no padding of its own to tell apart.
    const outside = (event: Press): boolean => {
      if (event.target !== dialog) return false;
      const box = dialog.getBoundingClientRect();
      return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    };
    // Both ends of the click are on the backdrop. Selecting text often ends past the box, and that click
    // lands on the dialog too, so a press that began inside never closes it. It closes on the click, not
    // the press, so the release cannot reach a button behind, such as the bell, and open it again.
    let pressedOutside = false;
    const down = (event: Press): void => {
      pressedOutside = outside(event);
    };
    const click = (event: Press): void => {
      if (pressedOutside && outside(event) && !held()) close();
    };
    dialog.addEventListener('pointerdown', down);
    dialog.addEventListener('click', click);
    return () => {
      dialog.removeEventListener('pointerdown', down);
      dialog.removeEventListener('click', click);
    };
  };
}
