import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../test/stubs/app-paths.ts';
import Page from './+page.svelte';

// A submit is recorded by its action and goes nowhere, as there is no server.
const posted = vi.hoisted(() => [] as string[]);
vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement) => {
    const on = (event: Event): void => {
      event.preventDefault();
      posted.push(form.getAttribute('action') ?? '');
    };
    form.addEventListener('submit', on);
    return { destroy: () => form.removeEventListener('submit', on) };
  },
}));

let target: HTMLElement;
let instance: object | null = null;
const settle = async () => {
  for (let round = 0; round < 3; round += 1) await tick();
  flushSync();
};

beforeAll(() => {
  drawnAt('/settings/integrations');
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  HTMLFormElement.prototype.requestSubmit = function (this: HTMLFormElement) {
    this.dispatchEvent(new Event('submit', { cancelable: true }));
  };
});

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target.remove();
  posted.length = 0;
});

function open(site: string | null) {
  target = document.createElement('div');
  document.body.append(target);
  const jira = { site, email: site === null ? null : 'dana@example.com' };
  instance = mount(Page as never, { target, props: { data: { gh: { found: true, signedIn: true, account: 'dana' }, jira }, form: null } });
  flushSync();
  return target;
}

const button = (page: HTMLElement, words: string) => [...page.querySelectorAll('button')].find((one) => one.textContent?.trim() === words);

it('asks before Disconnect posts, and Keep it posts nothing', async () => {
  const page = open('https://you.atlassian.net');

  button(page, 'Disconnect')!.click();
  await settle();
  const ask = document.querySelector('[data-disconnect-confirm]');
  expect(ask?.textContent).toContain('Disconnect Jira?');
  expect(posted).toEqual([]);
  // The safe button has the focus, so a stray Enter does not disconnect.
  expect(document.activeElement?.textContent?.trim()).toBe('Keep it');

  button(document.body, 'Keep it')!.click();
  await settle();
  expect(document.querySelector('[data-disconnect-confirm]')).toBeNull();
  expect(posted).toEqual([]);

  button(page, 'Disconnect')!.click();
  await settle();
  document.querySelector<HTMLButtonElement>('[data-disconnect-go]')!.click();
  await settle();
  expect(posted).toEqual(['?/disconnect']);
});

it('opens the three fields on Edit with the site and email filled, and the focus in the first', async () => {
  const page = open('https://you.atlassian.net');

  button(page, 'Edit')!.click();
  await settle();

  expect(page.querySelector<HTMLInputElement>('#jira-site')?.value).toBe('https://you.atlassian.net');
  expect(page.querySelector<HTMLInputElement>('#jira-email')?.value).toBe('dana@example.com');
  expect(page.querySelector<HTMLInputElement>('#jira-token')?.value).toBe('');
  expect(document.activeElement?.id).toBe('jira-site');
  expect(button(page, 'Edit')).toBeUndefined();

  button(page, 'Cancel')!.click();
  await settle();
  expect(page.querySelector('[data-jira-form]')).toBeNull();
});

it('opens empty fields on Connect when Jira is not connected', async () => {
  const page = open(null);

  button(page, 'Connect')!.click();
  await settle();

  expect(page.querySelector<HTMLInputElement>('#jira-site')?.value).toBe('');
  expect(button(page, 'Connect Jira')?.type).toBe('submit');
});

it('draws a grey line while gh is checked', async () => {
  target = document.createElement('div');
  document.body.append(target);
  let answer: (gh: { found: boolean; signedIn: boolean; account: string | null }) => void = () => {};
  const gh = new Promise((done) => (answer = done));
  instance = mount(Page as never, { target, props: { data: { gh, jira: { site: null, email: null } }, form: null } });
  flushSync();
  const row = target.querySelector('[data-integration="github"]')!;
  expect(row.querySelector('[data-skeleton] .sr')?.textContent).toBe('Checking the gh login.');
  answer({ found: true, signedIn: true, account: 'dana' });
  await settle();
  expect(row.querySelector('[data-skeleton]')).toBeNull();
  expect(row.textContent).toContain('Signed in with gh as dana');
});
