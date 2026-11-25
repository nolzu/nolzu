import { describe, expect, it } from 'vitest';
import { cardKeyOf, cardKeyProblem, cutOnWord, decisionLines, localKey, localTitle, parseTicketRef, pullRequestRef, refinedBranch, refinedCriteria, refinedQuestions, refinedTitle, ticketLink, ticketRefProblem, TITLE_CAP } from './ticket.ts';

it('reads a key that does not match the local prefix as external', () => {
  expect(parseTicketRef('PROJ-123', 'APP')).toEqual({ kind: 'external', key: 'PROJ-123' });
});

it('reads a key that matches the local prefix as local', () => {
  expect(parseTicketRef('APP-12', 'APP')).toEqual({ kind: 'local', key: 'APP-12' });
});

it('reads a key as external when no local prefix is configured', () => {
  expect(parseTicketRef('APP-12')).toEqual({ kind: 'external', key: 'APP-12' });
});

it('reads repo#42 as a GitHub ref with no owner', () => {
  expect(parseTicketRef('repo#42')).toEqual({ kind: 'github', owner: null, repo: 'repo', number: 42 });
});

it('reads owner/repo#42 as a GitHub ref with its owner', () => {
  expect(parseTicketRef('owner/repo#42')).toEqual({ kind: 'github', owner: 'owner', repo: 'repo', number: 42 });
});

describe('pullRequestRef', () => {
  it('names the pull request of a link with a tab on it, or of owner/repo#N, in lower case', () => {
    expect(pullRequestRef(' https://github.com/Acme/API/pull/12/files#diff-1 ')).toEqual({ owner: 'Acme', repo: 'API', number: 12, name: 'acme/api#12' });
    expect(pullRequestRef('beta/web#7')).toEqual({ owner: 'beta', repo: 'web', number: 7, name: 'beta/web#7' });
  });

  it.each([
    ['https://github.com/acme/api/issues/3', 'That link is to an issue. Paste a pull request link, as in https://github.com/owner/repo/pull/12, or type owner/repo#12.'],
    ['https://gitlab.com/acme/api/-/merge_requests/3', 'Paste a pull request link, as in https://github.com/owner/repo/pull/12, or type owner/repo#12.'],
    ['', 'Paste a pull request link, as in https://github.com/owner/repo/pull/12, or type owner/repo#12.'],
    ['api#12', 'Type the owner as well, as in owner/api#12.'],
  ])('refuses %j with what to type instead', (input, refused) => {
    expect(pullRequestRef(input)).toEqual({ refused });
  });
});

it('reads an issue URL as the same ref as owner/repo#42', () => {
  expect(parseTicketRef('https://github.com/owner/repo/issues/42')).toEqual(parseTicketRef('owner/repo#42'));
});

// A pasted pull request URL used to fall through to free text, which made a local card titled with
// the URL. The board reads a github ref as an issue or as a pull request, so the parser answers one.
it('reads a pull request URL as the same ref as owner/repo#42', () => {
  expect(parseTicketRef('https://github.com/owner/repo/pull/42')).toEqual(parseTicketRef('owner/repo#42'));
});

it.each(['repo#0', 'repo#-1'])('falls back to free text for %s', (input) => {
  expect(parseTicketRef(input)).toEqual({ kind: 'text', text: input });
});

it('trims before reading, so a pasted ref still resolves', () => {
  expect(parseTicketRef('  repo#42  ')).toEqual(parseTicketRef('repo#42'));
});

it('reads a sentence as free text', () => {
  const title = 'Add a search box to the recipe list';
  expect(parseTicketRef(title, 'APP')).toEqual({ kind: 'text', text: title });
});

it('reads an empty input as free text', () => {
  expect(parseTicketRef('   ', 'APP')).toEqual({ kind: 'text', text: '' });
});

it('builds a local key from the prefix and the counter', () => {
  expect(localKey('APP', 12)).toBe('APP-12');
});

// A card key names the card's folder, its checkout and its address. Every sentence below is written
// out by hand: a test that asked the checker for the words would agree with whatever it said.
it('takes a counted local key', () => {
  expect(cardKeyProblem('PROJ-123')).toBe(null);
});

// The pull request key is lowercase on purpose and carries a hash, so both have to pass.
it('takes a lowercase key with a hash in it', () => {
  expect(cardKeyProblem('recipes#42')).toBe(null);
});

it('takes a key of digits alone', () => {
  expect(cardKeyProblem('12345')).toBe(null);
});

// The length GitHub allows a repository name, which `pullKey` turns into `repo#number`. A card with
// such a key gets its folder and its branch, so nothing here may refuse it.
it('takes the longest pull request key GitHub can hand back', () => {
  expect(cardKeyProblem(`${'a'.repeat(100)}#123456`)).toBe(null);
});

it('takes a key of 255 bytes', () => {
  expect(cardKeyProblem('A'.repeat(255))).toBe(null);
});

it('refuses an empty key', () => {
  expect(cardKeyProblem('')).toBe('A card key cannot be empty.');
});

// The case this guard is for: a key copied out of a ticket system answer, with a line
// break in it, landing in the key column where every reader takes a key as one line.
it('refuses a key with a line break', () => {
  expect(cardKeyProblem('PROJ-123\nPROJ-124')).toBe('A card key is one line of plain text, with no line break and no control character.');
});

// A slash passes, and that is the decision this guard records rather than an oversight. No writer
// makes such a key any more, because `cardKeyOf` keys a reference with a path by its last part, and
// `ensureWorktree` refuses one at run time. A card a migration left on its old key holds one.
it('lets a key with a slash through, because the run refuses it and not the write', () => {
  expect(cardKeyProblem('acme/app#42')).toBeNull();
  expect(cardKeyProblem('acme\\app#42')).toBeNull();
});

it('refuses a key with a space', () => {
  expect(cardKeyProblem('PROJ 123')).toBe('A card key holds no space.');
});

it('refuses a key of 256 bytes', () => {
  expect(cardKeyProblem('A'.repeat(256))).toBe('A card key is 255 bytes or less, and that one is 256.');
});

// The filesystem counts bytes, so the check counts bytes. This key is 128 characters and 256 bytes.
it('refuses a key the filesystem is too short for, although it has few characters', () => {
  expect(cardKeyProblem('é'.repeat(128))).toBe('A card key is 255 bytes or less, and that one is 256.');
});

// Both name a folder somewhere else, and the card folder is built from the key.
it('refuses the two dot names', () => {
  expect(cardKeyProblem('.')).toBe('A card key cannot be . or .., because the key names the card folder.');
  expect(cardKeyProblem('..')).toBe('A card key cannot be . or .., because the key names the card folder.');
});

// A GitHub or a GitLab reference names a path, and a card key names one folder. The card takes the
// last part of the path and the number, the way a pull request card always has.
it('keys a reference with a path by its last part, in lower case', () => {
  expect(cardKeyOf('acme/app#42')).toBe('app#42');
  expect(cardKeyOf('Group/Sub/App#7')).toBe('app#7');
});

// A Jira or a Linear key is the card key as it is, capitals and all.
it('leaves a key with no path as it is', () => {
  expect(cardKeyOf('PROJ-123')).toBe('PROJ-123');
  expect(cardKeyOf('app#42')).toBe('app#42');
});

// The path is kept as the card's source ref and printed on pages, so a line break in it is refused
// too. Its length is not capped, because only the key names a folder.
it('checks the whole reference a card is started from', () => {
  expect(ticketRefProblem('PROJ-1\nPROJ-2/app#1')).toBe('A card key is one line of plain text, with no line break and no control character.');
  expect(ticketRefProblem('my group/app#1')).toBe('A card key holds no space.');
  expect(ticketRefProblem(`${'g'.repeat(300)}/app#1`)).toBeNull();
  expect(ticketRefProblem(`${'g'.repeat(300)}#1`)).toBe('A card key is 255 bytes or less, and that one is 302.');
});

describe('ticketLink', () => {
  it.each([
    ['https://you.atlassian.net/browse/PROJ-123', 'you.atlassian.net'],
    ['https://you.atlassian.net/browse/PROJ-123/', 'you.atlassian.net'],
    ['  https://you.atlassian.net/browse/PROJ-123?focusedCommentId=1#comment  ', 'you.atlassian.net'],
    ['https://you.atlassian.net/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-123', 'you.atlassian.net'],
    // A Jira Server or Data Center site has a host of its own, and some sit under a path.
    ['https://jira.example.com/browse/PROJ-123', 'jira.example.com'],
    ['https://tickets.example.com:8443/jira/browse/PROJ-123', 'tickets.example.com:8443'],
  ])('reads %s as Jira ticket PROJ-123 on %s', (input, host) => {
    expect(ticketLink(input)).toEqual({ system: 'jira', key: 'PROJ-123', host });
  });

  it('reads a Linear issue link, with or without the title part', () => {
    expect(ticketLink('https://linear.app/recipes/issue/PROJ-123/search-by-ingredient')).toEqual({ system: 'linear', key: 'PROJ-123' });
    expect(ticketLink('https://linear.app/recipes/issue/PROJ-123')).toEqual({ system: 'linear', key: 'PROJ-123' });
  });

  it('reads a GitHub issue and a pull request, the same links parseTicketRef reads', () => {
    expect(ticketLink('https://github.com/cook/recipes/issues/12')).toEqual({ system: 'github', owner: 'cook', repo: 'recipes', number: 12, pull: false });
    expect(ticketLink('https://github.com/cook/recipes/pull/42/')).toEqual({ system: 'github', owner: 'cook', repo: 'recipes', number: 42, pull: true });
  });

  // A host that only starts like the real one belongs to somebody else.
  it.each([
    'https://github.com.example.net/cook/recipes/issues/12',
    'https://notgithub.com/cook/recipes/issues/12',
    'https://linear.app.example.net/recipes/issue/PROJ-123',
    'https://evil-linear.app/recipes/issue/PROJ-123',
  ])('refuses the look-alike host of %s', (input) => {
    expect(ticketLink(input)).toBeNull();
  });

  // Any host can run Jira, so a look-alike is still a Jira link. Its host comes back, and the read
  // compares it with the site the project set, so nothing is read from a site nobody chose.
  it('keeps the host of a Jira look-alike, so the read can refuse it', () => {
    expect(ticketLink('https://you.atlassian.net.example.org/browse/PROJ-123')).toEqual({ system: 'jira', key: 'PROJ-123', host: 'you.atlassian.net.example.org' });
  });

  // Only the exact github.com is GitHub. A Jira site on a host that merely ends like it is still Jira,
  // and github.com itself is never read as a Jira site.
  it('reads a Jira link on a host that ends like github.com, and none on github.com', () => {
    expect(ticketLink('https://notgithub.com/browse/PROJ-123')).toEqual({ system: 'jira', key: 'PROJ-123', host: 'notgithub.com' });
    expect(ticketLink('https://github.com/cook/browse/PROJ-123')).toBeNull();
  });

  it.each([
    'PROJ-123',
    'Sort the list by time',
    'https://you.atlassian.net/browse/proj-123',
    'https://you.atlassian.net/wiki/spaces/PROJ',
    'https://you.atlassian.net/browse/PROJ-0x1',
    'ftp://you.atlassian.net/browse/PROJ-123',
    // A link that carries a password is not one to copy anywhere.
    'https://me:secret@you.atlassian.net/browse/PROJ-123',
    'https://github.com/cook/recipes/issues/0',
  ])('reads %j as no ticket link', (input) => {
    expect(ticketLink(input)).toBeNull();
  });
});

describe('a local card title', () => {
  it('keeps a short line as it is', () => {
    expect(localTitle('  Search the recipe list  ')).toBe('Search the recipe list');
  });

  it('takes the first line that has words', () => {
    expect(localTitle('\n\nSearch the recipe list\nIt filters by title.')).toBe('Search the recipe list');
  });

  it('cuts a long line on a word, with an ellipsis, at the cap', () => {
    const idea = 'A recipe app where a cook can save a recipe, search by ingredient, plan the meals of a week and print a shopping list';
    const title = localTitle(idea);
    expect(title.length).toBeLessThanOrEqual(TITLE_CAP);
    expect(title.endsWith('…')).toBe(true);
    expect(idea.startsWith(title.slice(0, -1))).toBe(true);
    expect(idea[title.length - 1]).toBe(' ');
  });

  it('cuts one long word where the cap falls', () => {
    expect(cutOnWord('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('the title Refine wrote', () => {
  it('reads the first heading when it names the card', () => {
    expect(refinedTitle('# APP-1: Daily habit tracker\n\nKind: feature\n', 'APP-1')).toBe('Daily habit tracker');
  });

  it('reads nothing from a heading that names another card or none', () => {
    expect(refinedTitle('# APP-2: Daily habit tracker\n', 'APP-1')).toBeNull();
    expect(refinedTitle('# Refined\n', 'APP-1')).toBeNull();
    expect(refinedTitle('# APP-1:   \n', 'APP-1')).toBeNull();
    expect(refinedTitle('The problem.\n', 'APP-1')).toBeNull();
  });

  it('reads only the first heading', () => {
    expect(refinedTitle('# Brief\n\n# APP-1: Daily habit tracker\n', 'APP-1')).toBeNull();
    expect(refinedTitle('Intro line\n# APP-1: Daily habit tracker\n## Scope\n', 'APP-1')).toBe('Daily habit tracker');
  });

  it('caps a long heading', () => {
    const title = refinedTitle(`# PROJ-123: ${'word '.repeat(30)}\n`, 'PROJ-123');
    expect(title?.length).toBeLessThanOrEqual(TITLE_CAP);
    expect(title?.endsWith('…')).toBe(true);
  });
});

// The whole brief the refine skill writes since it has ids: the sections under the title do not move
// the title, the kind or the branch words, and a Branch line further down is not taken.
describe('a brief with assumptions and acceptance ids', () => {
  const BRIEF = [
    '# APP-1: Search the recipe list',
    'Kind: feature',
    'Branch: recipe-search',
    '',
    '## Problem',
    '',
    'A cook with many recipes scrolls to find one.',
    '',
    '## Assumptions',
    '',
    '- A1: The search matches titles. Branch: not this one',
    '',
    '## Acceptance checks',
    '',
    '- AC1: Typing a word shows only recipes with that word in the title.',
    '',
    '## Open questions',
    '',
    '- Match ingredients too? Default: no. blocks: no',
    '',
    'Repositories: api, web',
  ].join('\n');

  it('reads the title, the kind and the branch words', () => {
    expect(refinedTitle(BRIEF, 'APP-1')).toBe('Search the recipe list');
    expect(refinedBranch(BRIEF)).toEqual({ type: 'feature', desc: 'recipe-search' });
  });
});

describe('the branch words Refine wrote', () => {
  it('reads the Kind and Branch lines under the heading', () => {
    expect(refinedBranch('# APP-1: Search box\nKind: fix\nBranch: search-box\n\nThe problem.\n')).toEqual({ type: 'fix', desc: 'search-box' });
  });

  it('reads a kind in any case, and drops one that is not feature, fix or chore', () => {
    expect(refinedBranch('# APP-1: Tidy\nKind: Chore\nBranch: tidy-up\n')).toEqual({ type: 'chore', desc: 'tidy-up' });
    expect(refinedBranch('# APP-1: Tidy\nKind: epic\nBranch: tidy-up\n')).toEqual({ type: null, desc: 'tidy-up' });
  });

  it('reads nothing from a brief without the lines', () => {
    expect(refinedBranch('# APP-1: Search box\n\nThe problem.\n')).toEqual({ type: null, desc: null });
    expect(refinedBranch('# APP-1: Search box\nBranch:   \n')).toEqual({ type: null, desc: null });
  });

  it('reads only the lines right under the heading, not a Branch line in the text', () => {
    expect(refinedBranch('# APP-1: Search box\n\nKind: fix\nBranch: search-box\n\nThe problem.\n')).toEqual({ type: 'fix', desc: 'search-box' });
    expect(refinedBranch('# APP-1: Search box\n\n## Scope\nBranch: main\nKind: fix\n')).toEqual({ type: null, desc: null });
    expect(refinedBranch('Kind: fix\nBranch: search-box\n')).toEqual({ type: null, desc: null });
  });
});

// The criteria and questions of the brief, with their levels and ids, and a brief from before them.
describe('the criteria and questions Refine wrote', () => {
  const BRIEF = [
    '# APP-1: Search the recipe list',
    '',
    '## Acceptance checks',
    '',
    '- AC1 (must): Typing "bean" shows only recipes with "bean" in the title.',
    '  Check: a browser test types "bean" and counts the rows.',
    '- AC2 (Should): An empty box shows every recipe.',
    'Check: at the margin, still the check of AC2.',
    '  Check: a second check line, which is left alone.',
    '- AC3: A line with no level.',
    '',
    '## Open questions',
    '',
    '- Q1: Should the search also match ingredients? Default: no, titles only. blocks: yes',
    '- Q2: Search as you type? Default: yes. blocks: no.',
    '',
    '## What the code does today',
    '- AC9 (must): not a criterion, it sits under another heading.',
  ].join('\n');

  it('reads each criterion with its level and its Check line', () => {
    expect(refinedCriteria(BRIEF)).toEqual([
      { id: 'AC1', level: 'must', text: 'Typing "bean" shows only recipes with "bean" in the title.', check: 'a browser test types "bean" and counts the rows.' },
      { id: 'AC2', level: 'should', text: 'An empty box shows every recipe.', check: 'at the margin, still the check of AC2.' },
      { id: 'AC3', level: null, text: 'A line with no level.', check: null },
    ]);
  });

  // A small model put the Check on the criterion's own line in two briefs of four. The check is still
  // there, so it is read rather than lost.
  it('reads a Check written on the criterion line, and the one under it in both shapes', () => {
    const brief = [
      '## Acceptance checks',
      '- AC1 (must): A Basic member can have 2 tools out. Check: an api test borrows a third and gets 400.',
      '- AC2 (should): Spaces do not matter.',
      '  Check: the api test asks for " bean ".',
      '- AC3 (should): The health check: still answers.',
    ].join('\n');
    expect(refinedCriteria(brief)).toEqual([
      { id: 'AC1', level: 'must', text: 'A Basic member can have 2 tools out.', check: 'an api test borrows a third and gets 400.' },
      { id: 'AC2', level: 'should', text: 'Spaces do not matter.', check: 'the api test asks for " bean ".' },
      { id: 'AC3', level: 'should', text: 'The health check: still answers.', check: null },
    ]);
  });

  it('reads each question with its id, default and blocks word', () => {
    expect(refinedQuestions(BRIEF)).toEqual([
      { id: 'Q1', question: 'Should the search also match ingredients?', answer: 'no, titles only', blocks: true },
      { id: 'Q2', question: 'Search as you type?', answer: 'yes', blocks: false },
    ]);
  });

  it('reads a brief from before the levels and ids, and one with no questions', () => {
    const old = '## Acceptance checks\n\n- AC1: Typing a word filters.\n\n## Open questions\n\n- Match ingredients too? Default: no. blocks: no\n- A loose thought\n';
    expect(refinedCriteria(old)).toEqual([{ id: 'AC1', level: null, text: 'Typing a word filters.', check: null }]);
    expect(refinedQuestions(old)).toEqual([
      { id: null, question: 'Match ingredients too?', answer: 'no', blocks: false },
      { id: null, question: 'A loose thought', answer: null, blocks: null },
    ]);
    expect(refinedQuestions('## Open questions\n\nNone.\n')).toEqual([]);
    expect(refinedCriteria('# APP-1: No sections\n')).toEqual([]);
  });
});

describe('the questions and decisions of an architecture and a plan', () => {
  it('reads the open questions under another heading', () => {
    const architecture = '## What is still open\n\n- Q2: One recipe per request? Default: yes. blocks: no\n\n## Touch points\n\n- Q9: not a question here.\n';
    expect(refinedQuestions(architecture, '## What is still open')).toEqual([{ id: 'Q2', question: 'One recipe per request?', answer: 'yes', blocks: false }]);
  });

  // An epic task copies the decisions its step names, so the reader takes them from the architecture and
  // from the plan, which goes on from the architecture's last id.
  it('reads the D lines of both, the first of an id winning, and nothing from a file in the old shape', () => {
    const architecture = '## The decisions\n\n- D1: The api filters. Not: the page, because the list grows.\n- D2: One route per recipe.\n  Keep: the list route as it is.\n\n## What is still open\n\nNothing.\n';
    const plan = '## Decisions\n\n- D3: The box waits 200 ms.\n- D1: A repeated id.\n\n## Steps\n\n- D4: under the steps, not a decision.\n';
    expect(decisionLines(`${architecture}\n${plan}`)).toEqual([
      { id: 'D1', text: 'The api filters. Not: the page, because the list grows.' },
      { id: 'D2', text: 'One route per recipe. Keep: the list route as it is.' },
      { id: 'D3', text: 'The box waits 200 ms.' },
    ]);
    expect(decisionLines('## The decisions\n\n- Filter in the api, because the list grows.\n')).toEqual([]);
    expect(decisionLines('')).toEqual([]);
  });
});
