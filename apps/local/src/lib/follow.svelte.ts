// The card a key or the palette moved last, and the column it went to. The stream redraws a moved card in
// its new column, and the focus falls to the page with the old element, so the page that shows the card
// selects it again once it lands. Peek follows the selection, so it stays on the moved card too.
class Follow {
  state = $state.raw<{ key: string; to: string } | null>(null);
}

export const follow = new Follow();
