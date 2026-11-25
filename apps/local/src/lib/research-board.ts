import { type BoardSnapshot, type CardView, cardStarts, isResearchKind, RESEARCH_KIND_LABELS, type ResearchKind } from '@nolzu/protocol';

// The Research board as pure rules, safe in the browser. Questions and investigations stay two boards
// in the data, each with its own phase, model row and key prefix, and share their column ids. The page
// draws one board out of the two snapshots the Now stream carries, so every card of either kind sits in
// the same five columns.

const researchOf = (boards: readonly BoardSnapshot[], kind: ResearchKind) => boards.find((board) => board.kind === kind) ?? null;

/**
 * One snapshot holding the cards of both kinds, drawn in the question board's columns, or null before
 * either board is on the stream. A column counts the cards of both.
 *
 * The Research column starts `research` for a question and `investigate` for an investigation. The
 * board reads what a dragged card starts as `cardStarts(stage, card)`, which looks the stage's phase up
 * in the card's own `starts`. So an investigation carries its own start under the question's phase
 * name, and the column says `/investigate` while that card is dragged over it.
 */
export function researchBoard(boards: readonly BoardSnapshot[]): BoardSnapshot | null {
  const questions = researchOf(boards, 'questions');
  const investigations = researchOf(boards, 'investigations');
  const base = questions ?? investigations;
  if (base === null) return null;
  if (questions === null || investigations === null) return base;
  const asQuestion = (card: CardView): CardView => {
    const starts = { ...card.starts };
    for (const stage of questions.stages) {
      const own = investigations.stages.find((one) => one.id === stage.id);
      if (stage.starts === null || own === undefined) continue;
      const start = cardStarts(own, card);
      if (start !== null) starts[stage.starts.phase] = start;
    }
    return { ...card, starts };
  };
  return {
    ...questions,
    stages: questions.stages.map((stage) => ({ ...stage, count: stage.count + (investigations.stages.find((one) => one.id === stage.id)?.count ?? 0) })),
    cards: [...questions.cards, ...investigations.cards.map(asQuestion)],
  };
}

// The snapshot of the board a card is on, which every write and every confirm reads, so a refusal and
// a Starts line name that card's own phase and model row. Null for a card no board on the stream holds.
export function boardOfCard(boards: readonly BoardSnapshot[], key: string): BoardSnapshot | null {
  return boards.find((board) => board.cards.some((card) => card.key === key)) ?? null;
}

// The small tag each Research card shows, "Question" or "Investigation", by the board that holds it.
export function researchTags(boards: readonly BoardSnapshot[]): Readonly<Record<string, string>> {
  return Object.fromEntries(boards.flatMap((board) => (isResearchKind(board.kind) ? board.cards.map((card) => [card.key, RESEARCH_KIND_LABELS[board.kind as ResearchKind]]) : [])));
}
