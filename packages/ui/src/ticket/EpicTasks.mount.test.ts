import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import { boardFixture, cardFixture } from '../board/fixture.ts';
import Overview from './Overview.svelte';

// The task table of an epic overview, on an epic whose plan names three tasks and one of them
// is on Delivery already.
let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};

const plan = [
  '1. Store meal plans in the api',
  '2. Show a week view at /plan',
  '   Files: web/src/routes/plan/+page.svelte',
  '   Undo: revert the page.',
  '3. Copy the plan of last week',
].join('\n');

type Add = (titles: string[], keys?: string[], descriptions?: string[], steps?: string[], refs?: string[], notes?: string[]) => Promise<string | null | { note: string }>;

function draw(onaddtasks: Add, more: Record<string, unknown> = {}) {
  page = mounted(Overview as never, {
    summary: null,
    changesHref: null,
    ticket: null,
    extra: null,
    related: [],
    plan,
    tasks: [{ key: 'APP-10', title: 'Store meal plans in the api', done: false }],
    delivery: boardFixture('pull-request', [cardFixture({ key: 'APP-10', stage: 'inbox' })]),
    nextKey: 'APP-11',
    onaddtasks,
    ...more,
  });
  return page.target;
}

it('links an added task to its card, and keeps the key of a task not added yet editable', () => {
  const target = draw(async () => null);
  const rows = [...target.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim()));

  expect(rows).toEqual([
    ['APP-10', 'Store meal plans in the api', 'Inbox'],
    ['Key for Show a week view at /plan', 'Description of Show a week view at /plan Title of Show a week view at /plan', 'not added yet Remove'],
    ['Key for Copy the plan of last week', 'Description of Copy the plan of last week Title of Copy the plan of last week', 'not added yet Remove'],
  ]);
  expect([...target.querySelectorAll<HTMLInputElement>('[data-task-title]')].map((field) => field.value)).toEqual(['Show a week view at /plan', 'Copy the plan of last week']);
  expect(target.querySelector<HTMLAnchorElement>('tbody a')?.getAttribute('href')).toBe('/t/APP-10');
  expect([...target.querySelectorAll<HTMLInputElement>('[data-task-key]')].map((field) => field.value)).toEqual(['APP-11', 'APP-12']);
  // The steps are the tasks here, so they are not drawn a second time as a plan.
  expect(target.querySelector('[data-plan]')).toBeNull();
  expect(target.querySelector('#new-tasks')).toBeNull();
});

it('adds the tasks not added yet under the keys their rows hold, with a plain button', async () => {
  const onaddtasks = vi.fn(async () => null);
  const target = draw(onaddtasks);
  const field = target.querySelector<HTMLInputElement>('[data-task-key]')!;
  field.value = 'PROJ-123';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  const button = target.querySelector<HTMLButtonElement>('[data-add-planned]')!;

  expect(button.textContent).toContain('Add 2 tasks to Delivery');
  expect(target.querySelector('[data-tasks-land]')?.textContent).toBe('They land in Inbox as local tickets. Nothing starts.');
  // Amber is for a press that starts an agent, and these land in Inbox.
  expect(button.className).not.toContain('go');
  button.click();
  await settle();

  expect(onaddtasks).toHaveBeenCalledOnce();
  // With no plan for colleagues the description is empty, and the step's body goes as the notes.
  expect(onaddtasks).toHaveBeenCalledWith(
    ['Show a week view at /plan', 'Copy the plan of last week'],
    ['PROJ-123', 'APP-12'],
    ['', ''],
    ['Show a week view at /plan', 'Copy the plan of last week'],
    ['', ''],
    ['Show a week view at /plan\n\n- Files: web/src/routes/plan/+page.svelte\n- Undo: revert the page.', 'Copy the plan of last week'],
  );
  expect(target.querySelector('[data-tasks-status]')?.textContent).toBe('2 tasks are on the Delivery board.');
});

// The ticket copies the epic criteria the step covers and the decisions it names, and the
// person sees that text in the row before adding it.
it('sends each task the epic criteria and decisions its step names', async () => {
  const onaddtasks = vi.fn(async () => null);
  const seeded = plan.replace('   Undo: revert the page.', '   Uses: D2.\n   Covers: AC1');
  const seed = { key: 'APP-9', criteria: [{ id: 'AC1', level: 'must', text: 'The week view lists seven days.', check: null }], decisions: [{ id: 'D2', text: 'The week starts on Monday.' }] };
  const target = draw(onaddtasks, { plan: seeded, seed });
  target.querySelector<HTMLButtonElement>('[data-add-planned]')!.click();
  await settle();

  expect((onaddtasks.mock.calls[0] as unknown[])[5]).toEqual([
    'Show a week view at /plan\n\n- Files: web/src/routes/plan/+page.svelte\n- Uses: D2.\n- Covers: AC1\n\n- From APP-9: AC1 (must): The week view lists seven days.\n- From APP-9: D2: The week starts on Monday.',
    'Copy the plan of last week',
  ]);
});

it('shows the sentence the add was refused with, and keeps the typed key', async () => {
  const target = draw(async () => 'APP-12 is already on the board. Open that card, or use another key.');
  const field = target.querySelector<HTMLInputElement>('[data-task-key]')!;
  field.value = 'APP-12';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  target.querySelector<HTMLButtonElement>('[data-add-planned]')!.click();
  await settle();

  expect(target.querySelector('[data-tasks-status]')?.textContent).toContain('APP-12 is already on the board');
  expect(target.querySelector<HTMLInputElement>('[data-task-key]')?.value).toBe('APP-12');
});

const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
};

it('opens a row to show its description and notes as a property list, and closes it again', () => {
  const target = draw(async () => null);
  const toggle = target.querySelector<HTMLButtonElement>('[data-task-expand]')!;

  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(target.querySelector('.props')).toBeNull();
  toggle.click();
  flushSync();

  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const more = target.querySelector(`#${toggle.getAttribute('aria-controls')}`)!;
  expect([...more.querySelectorAll('dt')].map((one) => one.textContent)).toEqual(['Description', 'Internal notes', 'Share']);
  expect(more.querySelector('[data-task-empty="description"]')?.textContent).toBe('Empty. Plan writes it with the plan for colleagues.');
  expect(more.querySelector('[data-task-text="notes"]')?.textContent).toContain('Files: web/src/routes/plan/+page.svelte');
  // Read, not a box: the box opens on Edit.
  expect(more.querySelector('textarea')).toBeNull();
  expect(more.querySelector('[data-task-link]')).toBeNull();
  expect(more.querySelector('[data-task-copy]')?.textContent?.trim()).toBe('Copy title and description');
  // Copy is a row of the list like the others, so its button sits in the value column.
  expect(more.querySelector('.prop:last-child dd [data-task-copy]')).not.toBeNull();
  toggle.click();
  flushSync();
  expect(target.querySelector('.props')).toBeNull();
});

it('sends the edited title and description, leaves a removed row out, and adds a row the person wrote', async () => {
  const onaddtasks = vi.fn<Add>(async () => null);
  const target = draw(onaddtasks);

  type(target.querySelector<HTMLInputElement>('[data-task-title]')!, 'Show a week view');
  target.querySelector<HTMLButtonElement>('[data-task-expand]')!.click();
  flushSync();
  target.querySelector<HTMLButtonElement>('[data-task-edit-open="description"]')!.click();
  flushSync();
  type(target.querySelector<HTMLTextAreaElement>('[data-task-edit="description"]')!, 'A week, Monday first.');
  target.querySelector<HTMLButtonElement>('[data-task-save]')!.click();
  flushSync();
  // The third step goes.
  target.querySelectorAll<HTMLButtonElement>('[data-task-remove]')[1]!.click();
  flushSync();
  target.querySelector<HTMLButtonElement>('[data-add-row]')!.click();
  await settle();
  const title = target.querySelector<HTMLInputElement>('[data-task-new="x1"] [data-task-title]')!;
  expect(document.activeElement).toBe(title);
  type(title, 'Print the week');

  const button = target.querySelector<HTMLButtonElement>('[data-add-planned]')!;
  expect(button.textContent).toContain('Add 2 tasks to Delivery');
  button.click();
  await settle();
  await settle();

  expect(onaddtasks).toHaveBeenCalledWith(
    ['Show a week view', 'Print the week'],
    ['APP-11', ''],
    ['A week, Monday first.', ''],
    ['Show a week view at /plan', ''],
    ['', ''],
    ['Show a week view at /plan\n\n- Files: web/src/routes/plan/+page.svelte\n- Undo: revert the page.', ''],
  );
  // Nothing is left to edit once the add went through.
  expect(target.querySelector('[data-task-new="x1"]')).toBeNull();
});

it('does not count a new row with no title', () => {
  const target = draw(async () => null);
  target.querySelector<HTMLButtonElement>('[data-add-row]')!.click();
  flushSync();

  expect(target.querySelector('[data-add-planned]')?.textContent).toContain('Add 2 tasks to Delivery');
  target.querySelector<HTMLButtonElement>('[data-task-new="x1"] [data-task-remove]')!.click();
  flushSync();
  expect(target.querySelector('[data-task-new="x1"]')).toBeNull();
});

it('counts the rows the table shows, and gives focus to Add a task when a row goes', async () => {
  const target = draw(async () => null);
  // The count leads the meta of the block header.
  const count = () => target.querySelector('[aria-labelledby="tasks"] .meta')?.textContent?.split(' · ')[0];

  expect(count()).toBe('3');
  target.querySelector<HTMLButtonElement>('[data-task-remove]')!.click();
  await settle();

  expect(count()).toBe('2');
  expect(document.activeElement).toBe(target.querySelector('[data-add-row]'));
});

// Plan rewrote the plan from the Discussion, and the table reads it again. A change kept by the row's
// place would land on another step, or hide it.
it('drops the changes to the plan rows when the plan names other steps, and keeps a row the person added', async () => {
  const target = draw(async () => null);
  type(target.querySelector<HTMLInputElement>('[data-task-title]')!, 'Show a week view');
  target.querySelectorAll<HTMLButtonElement>('[data-task-remove]')[1]!.click();
  target.querySelector<HTMLButtonElement>('[data-add-row]')!.click();
  await settle();
  type(target.querySelector<HTMLInputElement>('[data-task-new="x1"] [data-task-title]')!, 'Print the week');

  page!.set({ plan: ['1. Store meal plans in the api', '2. Show a month view at /plan', '3. Share a plan by link'].join('\n') });

  expect([...target.querySelectorAll<HTMLInputElement>('[data-task-title]')].map((field) => field.value)).toEqual(['Show a month view at /plan', 'Share a plan by link', 'Print the week']);
});

// Each task has a description colleagues read, from the plan for colleagues, and the
// notes that stay inside Nolzu. Edits are page state until Add.
const sharePlan = ['A meal planner.', '', '## Tasks', '', '### 2. Show the week', 'A page that shows the meals of one week.', '', '### 3. Reuse last week', 'Copy the meals of the week before.'].join('\n');

it('takes the title and description of each row from the plan for colleagues, by step number', async () => {
  const onaddtasks = vi.fn<Add>(async () => null);
  const target = draw(onaddtasks, { sharePlan });

  expect([...target.querySelectorAll<HTMLInputElement>('[data-task-title]')].map((field) => field.value)).toEqual(['Show the week', 'Reuse last week']);
  target.querySelector<HTMLButtonElement>('[data-add-planned]')!.click();
  await settle();
  const sent = onaddtasks.mock.calls[0]!;
  expect(sent[2]).toEqual(['A page that shows the meals of one week.', 'Copy the meals of the week before.']);
  // The step keeps the plan's own title, which the link pairs the task with.
  expect(sent[3]).toEqual(['Show a week view at /plan', 'Copy the plan of last week']);
});

it('edits the notes with Save, drops an edit with Cancel, and copies the title and description', async () => {
  const oncopy = vi.fn(async () => null);
  const onaddtasks = vi.fn<Add>(async () => null);
  const target = draw(onaddtasks, { sharePlan, oncopy, linkSystem: 'Jira' });
  target.querySelector<HTMLButtonElement>('[data-task-expand]')!.click();
  flushSync();

  target.querySelector<HTMLButtonElement>('[data-task-edit-open="description"]')!.click();
  flushSync();
  type(target.querySelector<HTMLTextAreaElement>('[data-task-edit="description"]')!, 'Gone.');
  target.querySelector<HTMLButtonElement>('[data-task-cancel]')!.click();
  flushSync();
  expect(target.querySelector('[data-task-text="description"]')?.textContent).toContain('A page that shows the meals of one week.');

  target.querySelector<HTMLButtonElement>('[data-task-edit-open="notes"]')!.click();
  flushSync();
  type(target.querySelector<HTMLTextAreaElement>('[data-task-edit="notes"]')!, 'Use the week module.');
  target.querySelector<HTMLButtonElement>('[data-task-save]')!.click();
  flushSync();
  expect(target.querySelector('[data-task-text="notes"]')?.textContent).toContain('Use the week module.');

  const copy = target.querySelector<HTMLButtonElement>('[data-task-copy]')!;
  expect(copy.textContent?.trim()).toBe('Copy for Jira');
  copy.click();
  await settle();
  expect(oncopy).toHaveBeenCalledWith('Show the week\n\nA page that shows the meals of one week.');
  expect(target.querySelector('[data-task-copy-status]')?.textContent).toBe('Copied the title and the description. Paste them into a new Jira ticket.');

  target.querySelector<HTMLButtonElement>('[data-add-planned]')!.click();
  await settle();
  expect(onaddtasks.mock.calls[0]![5]).toEqual(['Use the week module.', 'Copy the plan of last week']);
});

it('links a row to a ticket it read, hides the key field, refuses a ticket linked twice, and sends the key', async () => {
  const onaddtasks = vi.fn<Add>(async () => null);
  const onreadticket = vi.fn(async (ref: string) => (ref === 'PROJ-9' ? 'PROJ-9 is not in Jira.' : { key: ref, title: `${ref} in Jira` }));
  const target = draw(onaddtasks, { linkSystem: 'Jira', onreadticket });
  const open = (at: number) => {
    target.querySelectorAll<HTMLButtonElement>('[data-task-expand]')[at]!.click();
    flushSync();
  };
  const linkAs = async (at: number, ref: string) => {
    const row = target.querySelectorAll('.more')[at]!;
    row.querySelector<HTMLButtonElement>('[data-task-link]')?.click();
    flushSync();
    type(row.querySelector<HTMLInputElement>('[data-task-ref]')!, ref);
    row.querySelector<HTMLButtonElement>('[data-task-link-submit]')!.click();
    await settle();
    await settle();
  };
  open(0);
  open(1);

  await linkAs(0, 'PROJ-9');
  expect(target.querySelector('[data-task-link-status]')?.textContent).toBe('PROJ-9 is not in Jira.');
  await linkAs(0, 'PROJ-123');
  expect(target.querySelector('[data-task-linked]')?.textContent).toBe('PROJ-123');
  expect(target.querySelector('.more')?.textContent).toContain('PROJ-123 in Jira');
  expect(target.querySelectorAll('[data-task-key]')).toHaveLength(1);
  expect(target.querySelector('[data-task-ref-key]')?.textContent).toBe('PROJ-123');

  await linkAs(1, 'PROJ-123');
  expect(target.querySelectorAll('.more')[1]!.querySelector('[data-task-link-status]')?.textContent).toBe('PROJ-123 is linked on another task. Unlink it there first.');

  expect(target.querySelector('[data-tasks-land]')?.textContent).toBe('1 lands in Inbox as a local ticket, 1 as a Jira ticket (PROJ-123). Nothing starts, and nothing is written to Jira.');
  target.querySelector<HTMLButtonElement>('[data-add-planned]')!.click();
  await settle();
  expect(onaddtasks.mock.calls[0]![4]).toEqual(['PROJ-123', '']);
});

// A project of local tickets links a task to a GitHub issue, with the words for an issue.
it('links a row to a GitHub issue in the words of an issue', async () => {
  const onaddtasks = vi.fn<Add>(async () => null);
  const target = draw(onaddtasks, { linkSystem: 'GitHub', onreadticket: async () => ({ key: 'recipes#12', title: 'Search by ingredient', ref: 'cook/recipes#12' }) });
  target.querySelectorAll<HTMLButtonElement>('[data-task-expand]')[0]!.click();
  flushSync();
  const row = target.querySelector('.more')!;
  expect(row.textContent).toContain('Issue');
  const link = row.querySelector<HTMLButtonElement>('[data-task-link]')!;
  expect(link.textContent?.trim()).toBe('Link to GitHub');
  link.click();
  flushSync();
  expect(row.querySelector<HTMLInputElement>('[data-task-ref]')?.placeholder).toBe('repo#12 or a link');
  type(row.querySelector<HTMLInputElement>('[data-task-ref]')!, 'recipes#12');
  row.querySelector<HTMLButtonElement>('[data-task-link-submit]')!.click();
  await settle();
  await settle();

  expect(row.querySelector('[data-task-ticket-text]')?.textContent).toBe("The card takes the issue's own text from GitHub. This text is for Copy only.");
  expect(target.querySelector('[data-tasks-land]')?.textContent).toContain('1 as a GitHub issue (recipes#12)');
  // Add sends the full name Link read, so the owner the person typed is the one read again.
  target.querySelector<HTMLButtonElement>('[data-add-planned]')!.click();
  await settle();
  expect(onaddtasks.mock.calls[0]![4]).toEqual(['cook/recipes#12', '']);
});

it('shows the note of an add that took with notes it could not write, and clears the rows', async () => {
  const target = draw(async () => ({ note: "The epic's notes could not be written for APP-11. Add them to the extra context of that card." }));
  target.querySelector<HTMLButtonElement>('[data-add-row]')!.click();
  await settle();
  type(target.querySelector<HTMLInputElement>('[data-task-new="x1"] [data-task-title]')!, 'Print the week');
  target.querySelector<HTMLButtonElement>('[data-add-planned]')!.click();
  await settle();
  await settle();

  expect(target.querySelector('[data-tasks-status]')?.textContent).toBe("3 tasks are on the Delivery board. The epic's notes could not be written for APP-11. Add them to the extra context of that card.");
  expect(target.querySelector('[data-task-new="x1"]')).toBeNull();
});

// A read that is still going when the person cancels, or when Plan rewrites the steps, links nothing.
it('drops a ticket read that was cancelled or that a new plan overtook', async () => {
  let answer: (found: { key: string; title: string }) => void = () => {};
  const onreadticket = vi.fn(() => new Promise<{ key: string; title: string }>((done) => (answer = done)));
  const target = draw(async () => null, { linkSystem: 'Jira', onreadticket });
  target.querySelector<HTMLButtonElement>('[data-task-expand]')!.click();
  flushSync();
  const start = () => {
    target.querySelector<HTMLButtonElement>('.more [data-task-link]')!.click();
    flushSync();
    type(target.querySelector<HTMLInputElement>('.more [data-task-ref]')!, 'PROJ-123');
    target.querySelector<HTMLButtonElement>('.more [data-task-link-submit]')!.click();
    flushSync();
  };

  start();
  target.querySelector<HTMLButtonElement>('.more [data-task-link-cancel]')!.click();
  flushSync();
  answer({ key: 'PROJ-123', title: 'PROJ-123 in Jira' });
  await settle();
  await settle();
  expect(target.querySelector('[data-task-linked]')).toBeNull();
  expect(target.querySelector('[data-task-ref-key]')).toBeNull();

  start();
  page!.set({ plan: plan.replace('2. Show a week view at /plan', '2. Show a month view at /plan') });
  answer({ key: 'PROJ-123', title: 'PROJ-123 in Jira' });
  await settle();
  await settle();
  expect(target.querySelector('[data-task-ref-key]')).toBeNull();
  target.querySelector<HTMLButtonElement>('[data-task-expand]')!.click();
  flushSync();
  expect(target.querySelector('[data-task-linked]')).toBeNull();
});

it('edits one field at a time, and keeps the description of a linked row read only', async () => {
  const target = draw(async () => null, { linkSystem: 'Jira', sharePlan, onreadticket: async (ref: string) => ({ key: ref, title: `${ref} in Jira` }) });
  target.querySelector<HTMLButtonElement>('[data-task-expand]')!.click();
  flushSync();
  target.querySelector<HTMLButtonElement>('.more [data-task-edit-open="description"]')!.click();
  flushSync();
  expect(target.querySelector('.more [data-task-edit-open="notes"]')).toBeNull();
  target.querySelector<HTMLButtonElement>('.more [data-task-cancel]')!.click();
  flushSync();

  target.querySelector<HTMLButtonElement>('.more [data-task-link]')!.click();
  flushSync();
  type(target.querySelector<HTMLInputElement>('.more [data-task-ref]')!, 'PROJ-123');
  target.querySelector<HTMLButtonElement>('.more [data-task-link-submit]')!.click();
  await settle();
  await settle();
  expect(target.querySelector('[data-task-linked]')?.textContent).toBe('PROJ-123');
  expect(target.querySelector('.more [data-task-edit-open="description"]')).toBeNull();
  expect(target.querySelector('.more [data-task-edit-open="notes"]')).not.toBeNull();
  expect(target.querySelector('.more [data-task-ticket-text]')?.textContent).toBe("The card takes the ticket's own text from Jira. This text is for Copy only.");
});
