import { type BoardSnapshot, type CardView, cardStarts, type StartsDescriptor } from '@nolzu/protocol';
import { cardFixture, stageFixture } from '@nolzu/ui/fixture';
import { describe, expect, it } from 'vitest';
import { boardOfCard, researchBoard, researchTags } from './research-board.ts';

const start = (phase: StartsDescriptor['phase'], model: string): StartsDescriptor => ({ phase, engine: 'default', model, effort: 'medium', modelState: 'ok', refusal: null });

// The two boards as core gives them: the same columns, and the Research column runs each kind's phase.
const research = (kind: 'questions' | 'investigations', phase: StartsDescriptor['phase'], model: string, cards: CardView[]): BoardSnapshot => ({
  version: 1,
  kind,
  flow: 'pull-request',
  stages: [
    stageFixture({ id: 'inbox', label: 'Inbox', role: 'you', count: cards.filter((card) => card.stage === 'inbox').length }),
    stageFixture({ id: 'research', label: 'Research', role: 'agent', starts: start(phase, model), count: cards.filter((card) => card.stage === 'research').length }),
    stageFixture({ id: 'review', label: 'Review', role: 'you' }),
    stageFixture({ id: 'wrapup', label: 'Wrap-up', role: 'agent', starts: start('wrapup', model) }),
    stageFixture({ id: 'done', label: 'Done', role: 'archive' }),
  ],
  cards,
  slots: { busy: 0, total: 3 },
  lanes: [],
});

const questions = research('questions', 'research', 'sonnet', [cardFixture({ key: 'Q-1' }), cardFixture({ key: 'Q-2', stage: 'research', state: 'running' })]);
const investigations = research('investigations', 'investigate', 'opus', [cardFixture({ key: 'INV-1' })]);
const delivery: BoardSnapshot = { ...questions, kind: 'delivery', cards: [cardFixture({ key: 'APP-1' })] };

describe('researchBoard', () => {
  it('draws the cards of both kinds in the question columns, each column counting both', () => {
    const board = researchBoard([delivery, questions, investigations])!;

    expect(board.kind).toBe('questions');
    expect(board.cards.map((card) => card.key)).toEqual(['Q-1', 'Q-2', 'INV-1']);
    expect(board.stages.map((stage) => [stage.id, stage.count])).toEqual([['inbox', 2], ['research', 1], ['review', 0], ['wrapup', 0], ['done', 0]]);
  });

  // The column a card is dragged over says what that card starts: /investigate on its own model row
  // for an investigation, /research for a question.
  it('says what each card starts in the Research column', () => {
    const board = researchBoard([questions, investigations])!;
    const column = board.stages.find((stage) => stage.id === 'research')!;
    const card = (key: string) => board.cards.find((one) => one.key === key)!;

    expect(cardStarts(column, card('INV-1'))).toMatchObject({ phase: 'investigate', model: 'opus' });
    expect(cardStarts(column, card('Q-1'))).toMatchObject({ phase: 'research', model: 'sonnet' });
    expect(cardStarts(board.stages.find((stage) => stage.id === 'wrapup')!, card('INV-1'))).toMatchObject({ phase: 'wrapup', model: 'opus' });
  });

  it('keeps the model row an investigation set for itself', () => {
    const own = research('investigations', 'investigate', 'opus', [cardFixture({ key: 'INV-2', starts: { investigate: start('investigate', 'haiku') } })]);
    const board = researchBoard([questions, own])!;

    expect(cardStarts(board.stages[1]!, board.cards.find((card) => card.key === 'INV-2')!)).toMatchObject({ phase: 'investigate', model: 'haiku' });
  });

  it('answers null before either board is on the stream, and the one board when only one is', () => {
    expect(researchBoard([delivery])).toBeNull();
    expect(researchBoard([investigations])).toBe(investigations);
  });
});

describe('boardOfCard', () => {
  it('finds the board that holds the card, and nothing for a card no board holds', () => {
    expect(boardOfCard([questions, investigations], 'INV-1')).toBe(investigations);
    expect(boardOfCard([questions, investigations], 'Q-2')).toBe(questions);
    expect(boardOfCard([questions, investigations], 'APP-9')).toBeNull();
  });
});

describe('researchTags', () => {
  it('tags each Research card by its kind, and no card of another board', () => {
    expect(researchTags([delivery, questions, investigations])).toEqual({ 'Q-1': 'Question', 'Q-2': 'Question', 'INV-1': 'Investigation' });
  });
});
