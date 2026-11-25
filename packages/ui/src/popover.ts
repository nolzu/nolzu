// Where a popover goes next to the button that opened it. A popover sits in the top layer, so no
// parent box clips it, but the screen still does: it opens upward when the room below is too short.
const GAP = 4;
const EDGE = 8;

export function placePopover(
  button: { top: number; bottom: number; left: number },
  box: { width: number; height: number },
  view: { width: number; height: number },
): { top: number; left: number; up: boolean } {
  const below = button.bottom + GAP + box.height <= view.height - EDGE;
  const up = !below && button.top - GAP - box.height >= EDGE;
  const left = Math.max(EDGE, Math.min(button.left, view.width - box.width - EDGE));
  return { top: up ? button.top - GAP - box.height : button.bottom + GAP, left, up };
}
