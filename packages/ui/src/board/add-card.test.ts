import { choiceOf, parseTicketRef, type StageView } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { canSubmit, cardKey, cardPayload, copyContext, pressOf, readInput, startOffer } from './add-card.ts';

const PREFIX = 'APP';
const ISSUE = 'Nolzu reads issue cook/recipes#12 from GitHub when you add the card.';

describe('readInput', () => {
  it.each(['Sort the list by time', 'PROJ-123', 'APP-3', 'recipes#12', 'https://github.com/example/recipes/issues/12', 'app-3'])(
    'reads %j the way parseTicketRef does',
    (input) => {
      expect(readInput(input, PREFIX).kind).toBe(parseTicketRef(input, PREFIX).kind);
    },
  );

  it('says free text becomes a new local ticket', () => {
    expect(readInput('Sort the list by time', PREFIX).says).toBe('A new local ticket with this title.');
  });

  it('says an external key is kept with its key as the title', () => {
    expect(readInput('PROJ-123', PREFIX).says).toMatch(/PROJ-123.*cannot read/);
  });

  it('says a typed local key cannot be made again', () => {
    expect(readInput('APP-3', PREFIX).says).toMatch(/APP-3.*numbers local cards itself/);
  });

  // The board decides what the number is, the same way the server reads it. An issue card is keyed
  // repo#n like a pull request card, so it runs, and the dialog sends it.
  it('reads a GitHub reference as a pull request on the PR reviews board, and as an issue elsewhere', () => {
    expect(readInput('cook/recipes#12', PREFIX)).toEqual({ kind: 'github', says: ISSUE });
    expect(readInput('https://github.com/cook/recipes/pull/42', PREFIX, 'prreview').says).toBe('Nolzu reads pull request cook/recipes#42 from GitHub when you add the card.');
  });

  it('says where the owner of a short reference comes from', () => {
    expect(readInput('recipes#12', PREFIX, 'prreview').says).toBe(
      'Nolzu reads pull request recipes#12 from GitHub when you add the card. The owner comes from the GitHub remote of this project.',
    );
  });

  // The server reads the number by the board alone, so a link to the other kind is always refused.
  it('holds a link to a pull request off the PR reviews board, and a link to an issue on it', () => {
    expect(readInput('https://github.com/cook/recipes/pull/42', PREFIX)).toEqual({
      kind: 'misplaced',
      says: 'This link is a pull request. Add it on the PR reviews board.',
    });
    expect(readInput('https://github.com/cook/recipes/issues/12', PREFIX, 'prreview')).toEqual({
      kind: 'misplaced',
      says: 'This link is an issue, and the PR reviews board takes pull requests only.',
    });
  });

  // An off board is not in the rail, so the hint names the switch that brings it back.
  it('says the PR reviews board is off and where to turn it on, when it is', () => {
    expect(readInput('https://github.com/cook/recipes/pull/42', PREFIX, 'delivery', ['prreview'])).toEqual({
      kind: 'misplaced',
      says: 'This link is a pull request, and the PR reviews board is off. Turn it on under Boards in Settings, Project at /settings/project, then add the link on the PR reviews board.',
    });
    expect(readInput('https://github.com/cook/recipes/pull/42', PREFIX, 'epics', ['questions']).says).toBe('This link is a pull request. Add it on the PR reviews board.');
  });

  // A pasted link often ends in a space or a line break, and the server trims it before it reads.
  it('holds a pasted pull request link on Delivery with space around it', () => {
    expect(readInput(' https://github.com/cook/recipes/pull/42\n', PREFIX).kind).toBe('misplaced');
  });

  // The server reads a number as a pull request on the PR reviews board only, and as an issue elsewhere.
  it.each(['delivery', 'epics', 'investigations', 'questions'] as const)('reads a GitHub issue on %s and says so', (board) => {
    for (const input of ['cook/recipes#12', 'https://github.com/cook/recipes/issues/12']) {
      expect(readInput(input, PREFIX, board)).toEqual({ kind: 'github', says: ISSUE });
    }
    expect(readInput('recipes#12', PREFIX, board).says).toBe('Nolzu reads issue recipes#12 from GitHub when you add the card. The owner comes from the GitHub remote of this project.');
    expect(readInput('https://github.com/cook/recipes/pull/42', PREFIX, board).kind).toBe('misplaced');
  });

  it('says nothing yet for an empty field', () => {
    expect(readInput('  ', PREFIX)).toEqual({ kind: 'empty', says: '' });
  });
});

describe('canSubmit', () => {
  it.each(['', '   ', '\n\t'])('cannot submit %j', (input) => {
    expect(canSubmit({ input, description: '' }, PREFIX)).toBe(false);
  });

  it('submits free text and an external key', () => {
    expect(canSubmit({ input: 'Sort the list', description: '' }, PREFIX)).toBe(true);
    expect(canSubmit({ input: 'PROJ-123', description: '' }, PREFIX)).toBe(true);
  });

  // The server refuses a local key, so the button says so before the person presses it.
  it('cannot submit a local key', () => {
    expect(canSubmit({ input: 'APP-3', description: '' }, PREFIX)).toBe(false);
  });

  // The server reads each of these through gh, and says itself when it cannot.
  it.each(['delivery', 'epics', 'investigations', 'questions'] as const)('submits a GitHub issue on %s', (board) => {
    for (const input of ['cook/recipes#12', 'recipes#12', 'https://github.com/cook/recipes/issues/12']) {
      expect(canSubmit({ input, description: '' }, PREFIX, board)).toBe(true);
    }
  });

  // The server reads each of these through gh, and says itself when it cannot.
  it.each(['cook/recipes#42', 'recipes#42', 'https://github.com/cook/recipes/pull/42'])('submits the pull request %j on the PR reviews board', (input) => {
    expect(canSubmit({ input, description: '' }, PREFIX, 'prreview')).toBe(true);
  });

  it('cannot submit a link to the kind the board does not read', () => {
    expect(canSubmit({ input: 'https://github.com/cook/recipes/pull/42', description: '' }, PREFIX)).toBe(false);
    expect(canSubmit({ input: 'https://github.com/cook/recipes/issues/12', description: '' }, PREFIX, 'prreview')).toBe(false);
  });
});

describe('cardPayload', () => {
  it('carries a title and a description for free text, and no ref', () => {
    expect(cardPayload({ input: '  Sort the list  ', description: 'Quickest first.' }, PREFIX)).toEqual({
      input: 'Sort the list',
      title: 'Sort the list',
      description: 'Quickest first.',
    });
  });

  it('carries the key and no title for a ticket key', () => {
    expect(cardPayload({ input: ' PROJ-123 ', description: 'ignored' }, PREFIX)).toEqual({ input: 'PROJ-123' });
  });

  it('carries the GitHub reference as typed and no title, because GitHub has the title', () => {
    expect(cardPayload({ input: ' https://github.com/cook/recipes/pull/42 ', description: 'ignored' }, PREFIX)).toEqual({ input: 'https://github.com/cook/recipes/pull/42' });
  });
});

// Card pages and the board crumb read Research for either of its kinds.
describe('choiceOf', () => {
  it('reads Research for either kind, and the board itself for the rest', () => {
    expect(choiceOf('questions')).toBe('research');
    expect(choiceOf('investigations')).toBe('research');
    expect(choiceOf('epics')).toBe('epics');
  });
});

describe('copyContext', () => {
  it('puts the copied context in an empty field', () => {
    expect(copyContext('  ', 'Keep the old order for ties.')).toEqual({ text: 'Keep the old order for ties.', ask: false });
  });

  // What the person typed is theirs. The copy waits for a yes.
  it('keeps what the person typed and asks first', () => {
    expect(copyContext('My own note.', 'Keep the old order for ties.')).toEqual({ text: 'My own note.', ask: true });
  });
});

describe('cardPayload with context and links', () => {
  it('carries the extra context and the links, for free text and for a key alike', () => {
    expect(cardPayload({ input: 'Sort the list', description: '', extra: 'Ties keep order.', links: ['PROJ-8'] }, PREFIX)).toMatchObject({ extra: 'Ties keep order.', links: ['PROJ-8'] });
    expect(cardPayload({ input: 'PROJ-123', description: '', extra: 'Ties keep order.', links: [] }, PREFIX)).toEqual({ input: 'PROJ-123', extra: 'Ties keep order.', links: [] });
  });
});

// The key beside the title is the key the card gets: the server's own next number for free text, the
// typed key for a ticket key, and the key the runner makes for a GitHub issue or pull request.
describe('cardKey', () => {
  it('shows the next local key for free text, as the server read it', () => {
    expect(cardKey('Sort recipes by rating', PREFIX, 'delivery', 'APP-21')).toBe('APP-21');
    expect(cardKey('Sort recipes by rating', PREFIX, 'delivery', null)).toBeNull();
  });

  it('shows a ticket key as it is', () => {
    expect(cardKey(' PROJ-123 ', PREFIX, 'delivery', 'APP-21')).toBe('PROJ-123');
  });

  it('shows a GitHub reference as repo#number, in lower case, with no owner', () => {
    expect(cardKey('https://github.com/Cook/Recipes/issues/12', PREFIX, 'delivery', 'APP-21')).toBe('recipes#12');
    expect(cardKey('cook/recipes#42', PREFIX, 'prreview', 'APP-21')).toBe('recipes#42');
  });

  it('shows no key where the input makes no card', () => {
    expect(cardKey('', PREFIX, 'delivery', 'APP-21')).toBeNull();
    expect(cardKey('APP-3', PREFIX, 'delivery', 'APP-21')).toBeNull();
    expect(cardKey('https://github.com/cook/recipes/pull/42', PREFIX, 'delivery', 'APP-21')).toBeNull();
  });
});

// Cmd Enter only adds the card, so fast typing never starts a run.
describe('pressOf', () => {
  const press = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) =>
    pressOf({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

  it('adds on Cmd Enter, and on Ctrl Enter off a Mac, and never starts', () => {
    expect(press('Enter', { metaKey: true })).toBe('add');
    expect(press('Enter', { ctrlKey: true })).toBe('add');
  });

  it('starts on Shift Cmd Enter and Shift Ctrl Enter', () => {
    expect(press('Enter', { metaKey: true, shiftKey: true })).toBe('start');
    expect(press('Enter', { ctrlKey: true, shiftKey: true })).toBe('start');
  });

  it('leaves every other key to the field', () => {
    expect(press('Enter')).toBeNull();
    expect(press('Enter', { shiftKey: true })).toBeNull();
    expect(press('Enter', { metaKey: true, altKey: true })).toBeNull();
    expect(press('k', { metaKey: true })).toBeNull();
  });
});

const stage = (id: string, label: string, starts: StageView['starts'] = null): StageView => ({ id, label, role: starts === null ? 'you' : 'agent', count: 0, cadence: null, starts });
const refine = (more: Partial<NonNullable<StageView['starts']>> = {}): NonNullable<StageView['starts']> => ({
  phase: 'refine',
  model: 'haiku',
  effort: 'low',
  engine: 'claude-code',
  modelState: 'ok',
  refusal: null,
  ...more,
});

// What the two buttons say, read off the chosen board's stages in the snapshot.
describe('startOffer', () => {
  it('names the first column and the stage a start runs, with the drop box line and a measured estimate', () => {
    const estimate = { costUsd: 0.048, lowMs: 60_000, highMs: 120_000, from: 'preset' as const, runs: 0 };
    expect(startOffer([stage('inbox', 'Inbox'), stage('refine', 'Refine', refine({ estimate }))])).toEqual({
      first: 'Inbox',
      stage: 'Refine',
      line: 'Claude Code · haiku · low · about $0.05',
      refused: null,
    });
  });

  // No estimate where nothing measured the start.
  it('shows the engine, model and effort alone where no run measured the start', () => {
    const research = { ...refine(), phase: 'research' as const, model: 'sonnet', effort: 'medium' as const };
    expect(startOffer([stage('inbox', 'Inbox'), stage('researching', 'Researching', research)])).toEqual({ first: 'Inbox', stage: 'Researching', line: 'Claude Code · sonnet · medium', refused: null });
  });

  // The figure is the started stage's own. A later stage's measured runs say nothing about this start.
  it('takes no estimate from a later stage that has one', () => {
    const research = { ...refine(), phase: 'research' as const, model: 'sonnet', effort: 'medium' as const };
    const estimate = { costUsd: 0.4, lowMs: 360_000, highMs: 600_000, from: 'history' as const, runs: 7 };
    expect(startOffer([stage('inbox', 'Inbox'), stage('researching', 'Researching', research), stage('plan', 'Plan', refine({ estimate }))])).toMatchObject({
      line: 'Claude Code · sonnet · medium',
    });
  });

  it('names the stage on a board whose first column is not Inbox', () => {
    expect(startOffer([stage('incoming', 'Incoming'), stage('pre-review', 'Agent pre-review', { ...refine(), phase: 'pr-review' })])).toMatchObject({ first: 'Incoming', stage: 'Agent pre-review' });
  });

  it('says why a drop there would be refused, in place of the line', () => {
    expect(startOffer([stage('inbox', 'Inbox'), stage('refine', 'Refine', refine({ model: 'claude-retired-1', modelState: 'gone' }))])).toEqual({
      first: 'Inbox',
      stage: 'Refine',
      line: null,
      refused: 'Refine uses claude-retired-1, which Claude Code no longer offers. Pick another in Settings, Models.',
    });
  });

  it('offers no start before the board has a snapshot, or where the next stage starts nothing', () => {
    expect(startOffer(undefined)).toEqual({ first: null, stage: null, line: null, refused: null });
    expect(startOffer([stage('inbox', 'Inbox'), stage('review', 'Review')])).toEqual({ first: 'Inbox', stage: null, line: null, refused: null });
  });
});

// A pasted ticket link, and Jira as the project's ticket system.
describe('readInput with ticket links', () => {
  const JIRA = 'https://you.atlassian.net/browse/PROJ-123';
  const LINEAR = 'https://linear.app/recipes/issue/PROJ-123/search-by-ingredient';

  it('offers Connect Jira for a Jira link on a local project, and says what it becomes without', () => {
    expect(readInput(JIRA, PREFIX)).toEqual({ kind: 'connect', says: 'Added as it is, it becomes a local card titled PROJ-123, with the link in its text.' });
  });

  it('reads a Jira link and a typed key from Jira once Jira is set', () => {
    expect(readInput(JIRA, PREFIX, 'delivery', [], 'jira')).toEqual({ kind: 'jira', says: 'Nolzu reads PROJ-123 from Jira when you add the card.' });
    expect(readInput('PROJ-123', PREFIX, 'delivery', [], 'jira')).toEqual({ kind: 'jira', says: 'Nolzu reads PROJ-123 from Jira when you add the card.' });
  });

  it('keeps a key with the local prefix local, and a typed key external on a local project', () => {
    expect(readInput('APP-3', PREFIX, 'delivery', [], 'jira').kind).toBe('local');
    expect(readInput('PROJ-123', PREFIX).kind).toBe('external');
  });

  // The server refuses a Jira link whose key has the local prefix, so the dialog promises no read.
  it('sends no Jira link whose key has the local prefix on a Jira project', () => {
    const own = 'https://you.atlassian.net/browse/APP-3';
    expect(readInput(own, PREFIX, 'delivery', [], 'jira')).toEqual({
      kind: 'local',
      says: "APP-3 has this project's local key prefix. Change the key prefix in Settings, Project at /settings/project to one no Jira project uses.",
    });
    expect(canSubmit({ input: own, description: '' }, PREFIX, 'delivery', 'jira')).toBe(false);
    expect(cardKey(own, PREFIX, 'delivery', 'APP-4', 'jira')).toBeNull();
    // On a local project it is still a local card titled with the key.
    expect(canSubmit({ input: own, description: '' }, PREFIX)).toBe(true);
  });

  it('says Linear is not read yet and keeps a Linear link as a local card', () => {
    expect(readInput(LINEAR, PREFIX, 'delivery', [], 'jira')).toEqual({
      kind: 'linear',
      says: 'That is a Linear issue. Nolzu cannot read Linear into a card yet, so it becomes a local card titled PROJ-123, with the link in its text.',
    });
  });

  it('reads a GitHub link as it did, whatever the system', () => {
    expect(readInput('https://github.com/cook/recipes/issues/12', PREFIX, 'delivery', [], 'jira')).toEqual({ kind: 'github', says: ISSUE });
  });

  it('sends every link and shows the key each one gets', () => {
    for (const input of [JIRA, LINEAR]) expect(canSubmit({ input, description: '' }, PREFIX)).toBe(true);
    expect(cardKey(JIRA, PREFIX, 'delivery', 'APP-4')).toBe('APP-4');
    expect(cardKey(LINEAR, PREFIX, 'delivery', 'APP-4')).toBe('APP-4');
    expect(cardKey(JIRA, PREFIX, 'delivery', 'APP-4', 'jira')).toBe('PROJ-123');
    expect(cardKey('PROJ-123', PREFIX, 'delivery', 'APP-4', 'jira')).toBe('PROJ-123');
    // The server reads the link, so the dialog sends it as typed and adds no title.
    expect(cardPayload({ input: JIRA, description: '' }, PREFIX)).toEqual({ input: JIRA });
  });
});
