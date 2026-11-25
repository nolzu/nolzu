import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, openDatabase } from '@nolzu/core/node';
import type { RunGh } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { namedIssues, namedNumbers, withNamedIssues } from './named-issues.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-named-issues-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The epic of the test repository, as its body reads: the tasks are numbers and nothing else.
const EPIC = 'Members get tiers.\n\n- [ ] #1\n- [ ] #2\n- [ ] #3\n\nSee #2 again, and #5 is this one.';

// A `gh` that answers the GraphQL read with these issues, in the order they were asked, and keeps the calls.
const gh = (issues: readonly ({ title: string; state?: string } | null)[], code = 0): { run: RunGh; calls: string[][] } => {
  const calls: string[][] = [];
  const data = Object.fromEntries(issues.map((one, at) => [`t${at}`, { issueOrPullRequest: one === null ? null : { __typename: 'Issue', number: at + 1, body: '', url: null, parent: null, state: one.state ?? 'OPEN', title: one.title } }]));
  return {
    calls,
    run: async (args) => {
      calls.push([...args]);
      return { code, stdout: JSON.stringify({ data }), stderr: '' };
    },
  };
};

const card = (summary: string | null, source = 'github', sourceRef: string | null = 'acme/app#5') =>
  createCard(db, { key: 'app#5', board: 'delivery', stage: 'refine', title: 'Tiers', summary, source, sourceRef });

describe('namedNumbers', () => {
  it('reads each issue number once, in order, and not the issue itself', () => {
    expect(namedNumbers(EPIC, 5)).toEqual([1, 2, 3]);
  });

  it('reads no number inside a word, a link, an entity or a heading', () => {
    expect(namedNumbers('a#4 https://x.dev/page#6 &#7; ##8 C#9 #0', 1)).toEqual([]);
  });

  it('reads twenty at most, the issues one read can ask for', () => {
    expect(namedNumbers(Array.from({ length: 30 }, (_, at) => `#${at + 1}`).join(' '), 99)).toHaveLength(20);
  });
});

describe('namedIssues', () => {
  it('reads the titles of the issues a GitHub card names, in one call', async () => {
    card(EPIC);
    const github = gh([{ title: 'Tier limits' }, { title: 'Holds\nexpire', state: 'CLOSED' }, null]);

    expect(await namedIssues(db, 'app#5', github.run, new AbortController().signal)).toEqual(['- #1: Tier limits', '- #2: Holds expire (closed)']);
    expect(github.calls).toHaveLength(1);
    expect(github.calls[0]?.join(' ')).toContain('repository(owner: "acme", name: "app")');
  });

  it.each([
    ['a pull request card', () => card(EPIC, 'github-pr')],
    ['a local card', () => card(EPIC, 'local', null)],
    ['a card with no text', () => card(null)],
    ['a card whose text names no issue', () => card('Members get tiers.')],
  ])('asks nothing for %s', async (_, make) => {
    make();
    const github = gh([{ title: 'Tier limits' }]);

    expect(await namedIssues(db, 'app#5', github.run, new AbortController().signal)).toEqual([]);
    expect(github.calls).toHaveLength(0);
  });

  // The run goes ahead with the ticket as before. A failed read is no reason to stop it.
  it('gives nothing when GitHub did not answer, or there is no gh', async () => {
    card(EPIC);
    const broken: RunGh = async () => {
      throw new Error('gh: connection refused');
    };

    expect(await namedIssues(db, 'app#5', broken, new AbortController().signal)).toEqual([]);
    expect(await namedIssues(db, 'app#5', null, new AbortController().signal)).toEqual([]);
  });
});

describe('withNamedIssues', () => {
  const prompt = '## The card\n\napp#5: Tiers\n\nMembers get tiers.\n\n## How this run works\n\nThis run is not interactive.\n';

  it('puts the titles under their own heading, before the prompt says how the run works', () => {
    expect(withNamedIssues(prompt, ['- #1: Tier limits'])).toBe(
      "## The card\n\napp#5: Tiers\n\nMembers get tiers.\n\n## Issues the ticket names\n\nGitHub's titles for the issues the ticket names by number. This run cannot reach GitHub, so\nthese lines are all it has of them.\n\n- #1: Tier limits\n\n## How this run works\n\nThis run is not interactive.\n",
    );
  });

  it('goes before the prompt\'s own heading when the ticket holds one of the same name', () => {
    const copied = prompt.replace('Members get tiers.', 'Members get tiers.\n## How this run works\nAs the wiki says.');

    expect(withNamedIssues(copied, ['- #1: Tier limits'])).toMatch(/As the wiki says\.\n\n## Issues the ticket names\n[\s\S]*- #1: Tier limits\n\n## How this run works\n\nThis run is not interactive\.\n$/);
  });

  it('leaves a prompt with no titles as it was, and adds them at the end of one with no such heading', () => {
    expect(withNamedIssues(prompt, [])).toBe(prompt);
    expect(withNamedIssues('Answer a question.\n', ['- #1: Tier limits'])).toMatch(/^Answer a question\.\n\n## Issues the ticket names\n[\s\S]*- #1: Tier limits\n$/);
  });
});
