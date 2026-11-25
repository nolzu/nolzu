import { flushSync } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import PublishPanel from './PublishPanel.svelte';

// The push confirm is a modal dialog. jsdom has the dialog element but none of its modal half, so this
// gives it the two calls the dialog uses, as Dialog.mount.test.ts does.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

type Answer = { ok: true } | { ok: false; reason: string; rejected?: boolean; command?: string };
const URL_TEXT = 'https://github.com/example/recipe-workspace/compare/main...APP-1?expand=1&title=APP-1';

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

function draw(over: Record<string, unknown>, onpush: () => Promise<Answer> = async () => ({ ok: true })) {
  page = mounted(PublishPanel as never, {
    confirmation: 'Push APP-1 to origin at https://github.com/example/recipe-workspace.git.',
    pushed: false,
    compare: { ok: true, url: URL_TEXT },
    change: { added: 4, removed: 1, files: 2, commits: 1 },
    onpush,
    ...over,
  });
  const target = page.target;
  const click = (selector: string) => {
    target.querySelector<HTMLButtonElement>(selector)!.click();
    flushSync();
  };
  return { target, click };
}

it('asks for the confirmation, naming the branch and the remote, before it pushes', async () => {
  const onpush = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const ui = draw({}, onpush);

  ui.click('[data-push]');
  expect(onpush).not.toHaveBeenCalled();
  expect(ui.target.textContent).toContain('Push APP-1 to origin at https://github.com/example/recipe-workspace.git.');

  ui.click('[data-confirm-push]');
  await settle();
  expect(onpush).toHaveBeenCalledTimes(1);
});

it('lets the person step back from the confirmation, and nothing is sent', () => {
  const onpush = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const ui = draw({}, onpush);

  ui.click('[data-push]');
  ui.click('[data-cancel-push]');

  expect(onpush).not.toHaveBeenCalled();
  expect(ui.target.querySelector('[data-confirm-push]')).toBeNull();
});

// The long URL is not printed: Copy link puts it on the clipboard, and the why sits in a help tip.
it('copies the compare URL instead of printing it, and says the branch must be pushed first in a tip', async () => {
  const oncopy = vi.fn(async (): Promise<string | null> => null);
  const ui = draw({ pushed: false, oncopy });

  expect(ui.target.textContent).not.toContain(URL_TEXT);
  expect(ui.target.querySelector('a[data-create-pr]')).toBeNull();
  const tip = ui.target.querySelector('[data-pr-help] [role="tooltip"]');
  expect(tip?.textContent).toBe('Push the branch first. Then this page opens with the pull request filled in.');

  ui.click('[data-copy-link]');
  await settle();
  expect(oncopy).toHaveBeenCalledWith(URL_TEXT);
  expect(ui.target.querySelector('[data-copy-link]')?.textContent).toBe('Copied');
});

it('offers Copy link beside the live link too, and says why the clipboard refused', async () => {
  const ui = draw({ pushed: true, oncopy: async () => 'The browser refused the clipboard.' });

  expect(ui.target.querySelector('[data-pr-help]')).toBeNull();
  ui.click('[data-copy-link]');
  await settle();
  expect(ui.target.querySelector('[data-copy-link]')?.textContent).toBe('Copy link');
  expect(ui.target.textContent).toContain('The browser refused the clipboard.');
});

// With no clipboard from the page, a Copy link button would say "Copied" and copy nothing.
it('leaves Copy link out when the page gives no clipboard', () => {
  expect(draw({ pushed: true }).target.querySelector('[data-copy-link]')).toBeNull();
});

it('keeps the push explanation in a tip beside the push button', () => {
  expect(draw({}).target.querySelector('[data-push-help] [role="tooltip"]')?.textContent).toBe('Sends the commits the remote has not got to your git host, and commits nothing.');
});

it('opens the prefilled page once the branch is pushed', () => {
  const ui = draw({ pushed: true });
  expect(ui.target.querySelector('a[data-create-pr]')?.getAttribute('href')).toBe(URL_TEXT);
});

it('says a pull request needs a GitHub remote when there is none', () => {
  const ui = draw({ confirmation: null, compare: { ok: false, reason: 'This project has no remote, and a pull request needs a GitHub remote.' } });

  expect(ui.target.textContent).toContain('a pull request needs a GitHub remote');
  expect(ui.target.querySelector('[data-push]')).toBeNull();
});

it("shows a refused push as git's own words", async () => {
  const ui = draw({}, async () => ({ ok: false, reason: '! [rejected] APP-1 -> APP-1 (non-fast-forward)' }));

  ui.click('[data-push]');
  ui.click('[data-confirm-push]');
  await settle();

  expect(ui.target.querySelector('pre[data-refusal]')?.textContent).toBe('! [rejected] APP-1 -> APP-1 (non-fast-forward)');
});

it('keeps the plain id when no repository is named', () => {
  const ui = draw({});
  expect(ui.target.querySelector('section')?.getAttribute('aria-labelledby')).toBe('push-title');
  expect(ui.target.querySelector('h2')?.id).toBe('push-title');
});

// The push confirm: the card and the host in the title, the branch, the remote
// and the change in mono rows, the pull request page box, and Push to origin with Not yet.
const pushCase = {
  card: 'APP-1',
  branch: 'APP-1-sort-by-time',
  remote: { name: 'origin', url: 'https://github.com/recipes-app/web.git' },
  host: 'GitHub',
  place: 'github.com/recipes-app/web',
  change: { added: 38, removed: 6, files: 3, commits: 2 },
};

it('names the branch, the remote and the change in the push confirm, and never in amber', () => {
  const ui = draw({ ...pushCase, onopenpr: () => {} });

  ui.click('[data-push]');
  const dialog = ui.target.querySelector<HTMLDialogElement>('dialog[data-push-confirm]')!;
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('h2')?.textContent).toBe('Push APP-1 and open a pull request');
  expect(dialog.textContent).toContain('Nolzu never merges. The pull request is yours to review and merge.');
  const chips = [...dialog.querySelectorAll('[data-push-where] li')].map((one) => one.textContent?.replace(/\s+/g, ' ').trim());
  expect(chips).toEqual(['APP-1-sort-by-time', 'origin · github.com/recipes-app/web', '+38 -6 · 3 files · 2 commits']);
  expect(dialog.querySelector<HTMLInputElement>('[data-open-pr]')?.checked).toBe(true);
  expect(dialog.querySelector('[data-open-pr]')?.parentElement?.textContent?.trim()).toBe('Open the pull request page after the push, filled in from the card');
  // A push commits nothing, so the dialog asks for no message.
  expect(dialog.querySelector('textarea')).toBeNull();
  const confirm = dialog.querySelector<HTMLButtonElement>('[data-confirm-push]')!;
  expect(confirm.textContent).toContain('Push 2 commits');
  // The main safe action, cream: a push starts no agent, so nothing here is the amber go button.
  expect(confirm.classList.contains('primary')).toBe(true);
  expect(dialog.querySelector('.go')).toBeNull();
  expect(dialog.querySelector('[data-cancel-push]')?.textContent?.trim()).toBe('Not yet');
});

it('names the repository of a workspace in front of its remote', () => {
  const ui = draw({ ...pushCase, repo: 'web' });

  ui.click('[data-push]');

  expect(ui.target.querySelectorAll('[data-push-where] li')[1]?.textContent?.trim()).toBe('web → origin · github.com/recipes-app/web');
});

it('pushes on Cmd Enter, and opens the pull request page once the push went', async () => {
  const onpush = vi.fn(async (): Promise<Answer> => ({ ok: true }));
  const onopenpr = vi.fn();
  const ui = draw({ ...pushCase, onopenpr }, onpush);

  ui.click('[data-push]');
  ui.target.querySelector('dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  await settle();

  expect(onpush).toHaveBeenCalledOnce();
  expect(onopenpr).toHaveBeenCalledWith(URL_TEXT);
  expect(ui.target.querySelector('dialog')).toBeNull();
});

it('leaves the pull request page shut when the box is cleared, or the push failed', async () => {
  const onopenpr = vi.fn();
  const ui = draw({ ...pushCase, onopenpr }, async () => ({ ok: true }));

  ui.click('[data-push]');
  const box = ui.target.querySelector<HTMLInputElement>('[data-open-pr]')!;
  box.click();
  flushSync();
  ui.click('[data-confirm-push]');
  await settle();
  expect(onopenpr).not.toHaveBeenCalled();

  page?.remove();
  const failed = draw({ ...pushCase, onopenpr }, async () => ({ ok: false, reason: 'fatal: could not read from remote repository.' }));
  failed.click('[data-push]');
  failed.click('[data-confirm-push]');
  await settle();
  expect(onopenpr).not.toHaveBeenCalled();
});

it("pushes to the card's pull request and offers no new one", async () => {
  const onopenpr = vi.fn();
  const ui = draw({ ...pushCase, pushed: true, uncommitted: 1, onopenpr, pull: { number: 12, url: 'https://github.com/recipes-app/web/pull/12' } }, async () => ({ ok: true }));

  expect(ui.target.querySelector('[data-create-pr]')).toBeNull();
  expect(ui.target.querySelector('h2.hidden')?.textContent).toBe('Push to pull request #12');
  expect(ui.target.querySelector<HTMLAnchorElement>('[data-open-pull]')?.href).toBe('https://github.com/recipes-app/web/pull/12');
  ui.click('[data-push]');
  expect(ui.target.querySelector('dialog')?.textContent).toContain('Push APP-1 to pull request #12');
  expect(ui.target.querySelector('[data-open-pr]')).toBeNull();
  ui.click('[data-confirm-push]');
  await settle();
  expect(onopenpr).not.toHaveBeenCalled();
});

const REJECTED = " ! [rejected]        APP-1-sort-by-time -> APP-1-sort-by-time (fetch first)\nerror: failed to push some refs to 'github.com:recipes-app/web.git'";

async function rejectedPush(onpull: () => Promise<unknown>, oncopy = vi.fn(async () => null)) {
  const ui = draw({ ...pushCase, onpull, oncopy }, async () => ({ ok: false, reason: REJECTED, rejected: true, command: 'git push --no-follow-tags -u origin APP-1-sort-by-time' }) as Answer);
  ui.click('[data-push]');
  ui.click('[data-confirm-push]');
  await settle();
  return ui;
}

it('shows a rejected push as the error box, with the command, the fix and Pull into the checkout', async () => {
  const oncopy = vi.fn(async () => null);
  const ui = await rejectedPush(async () => ({ ok: true }), oncopy);

  const box = ui.target.querySelector<HTMLElement>('section.errbox')!;
  expect(box.querySelector('[role="alert"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('APP-1 was not pushed. GitHub has commits on the branch that the checkout does not.');
  expect(box.querySelector('pre')?.textContent).toBe(`$ git push --no-follow-tags -u origin APP-1-sort-by-time\n${REJECTED}`);
  expect(box.querySelector('.fix p')?.textContent).toBe('Someone pushed to this branch on GitHub. Pull their commits into the APP-1 checkout, check the result, then push again.');
  expect(box.querySelector('[data-pull]')?.textContent?.trim()).toBe('Pull into the checkout');
  // The box's title is the alert, so the status line says nothing over it.
  expect(ui.target.querySelector('p[role="status"]')?.textContent).toBe('');
  expect(ui.target.querySelector('pre[data-refusal]')).toBeNull();

  ui.click('[data-copy-output]');
  await settle();
  expect(oncopy).toHaveBeenCalledWith(`$ git push --no-follow-tags -u origin APP-1-sort-by-time\n${REJECTED}`);
});

it('pulls into the checkout on a press, shows it is pulling, and says to push again', async () => {
  let done: (answer: unknown) => void = () => {};
  const onpull = vi.fn(() => new Promise((resolve) => (done = resolve)));
  const ui = await rejectedPush(onpull);

  ui.click('[data-pull]');
  expect(onpull).toHaveBeenCalledOnce();
  expect(ui.target.querySelector('[data-pull]')?.getAttribute('aria-busy')).toBe('true');
  expect(ui.target.querySelector('[data-pull]')?.textContent?.trim()).toBe('Pulling into the checkout');
  // A second press while the first is on its way sends nothing.
  ui.click('[data-pull]');
  expect(onpull).toHaveBeenCalledOnce();

  done({ ok: true, upToDate: false });
  await settle();
  expect(ui.target.querySelector('section.errbox')).toBeNull();
  expect(ui.target.querySelector('p[role="status"]')?.textContent).toBe('Pulled. Check the result in Changes, then push again.');
  // The box took the pressed button with it, so the focus goes to Push and not to the page.
  await vi.waitFor(() => expect(document.activeElement).toBe(ui.target.querySelector('[data-push]')));
});

it('says a pull stopped on a conflict, and leaves the files to Changes', async () => {
  const ui = await rejectedPush(async () => ({ ok: false, reason: 'CONFLICT (content): Merge conflict in list.ts', conflicts: ['list.ts'] }));

  ui.click('[data-pull]');
  await settle();

  expect(ui.target.querySelector('section.errbox')).toBeNull();
  expect(ui.target.querySelector('p[role="status"]')?.textContent).toBe('The pull stopped on a conflict in 1 file. The Changes tab names each file and says what to do.');
  await vi.waitFor(() => expect(document.activeElement).toBe(ui.target.querySelector('[data-push]')));
});

it('draws no Pull button where the page offers no pull', async () => {
  const ui = draw({ ...pushCase }, async () => ({ ok: false, reason: REJECTED, rejected: true }) as Answer);
  ui.click('[data-push]');
  ui.click('[data-confirm-push]');
  await settle();

  expect(ui.target.querySelector('section.errbox pre')?.textContent).toBe(REJECTED);
  expect(ui.target.querySelector('[data-pull]')).toBeNull();
});

// Work goes out of order: commit some files, change more, commit again, push later. So Push is on by
// the commits the remote has not got, never by a step before it, and it commits nothing.
describe('push on its own', () => {
  it('counts the commits the remote has not got, and pushes them with no message', async () => {
    const onpush = vi.fn<(message: undefined, hooks: boolean) => Promise<Answer>>(async () => ({ ok: true }));
    const ui = draw({ ...pushCase, pushed: true, uncommitted: 2 }, onpush as never);

    expect(ui.target.querySelector('[data-push]')?.textContent).toBe('Push 2 commits to origin/APP-1-sort-by-time');
    ui.click('[data-push]');
    const dialog = ui.target.querySelector<HTMLDialogElement>('dialog[data-push-confirm]')!;
    expect(dialog.querySelector('textarea')).toBeNull();
    expect(dialog.querySelector('[data-push-leaves]')?.textContent).toBe('2 files not committed stay in the folder. Commit them first to push them too.');
    expect(dialog.querySelector('[data-confirm-push]')?.textContent).toContain('Push 2 commits');
    ui.click('[data-confirm-push]');
    await settle();
    expect(onpush).toHaveBeenCalledWith(undefined, false);
  });

  it('stays off with its reason while there is nothing to push, and opens nothing on a press', () => {
    const onpush = vi.fn(async (): Promise<Answer> => ({ ok: true }));
    const ui = draw({ ...pushCase, change: { ...pushCase.change, commits: 0 }, uncommitted: 3 }, onpush);

    const button = ui.target.querySelector<HTMLButtonElement>('[data-push]')!;
    expect(button.textContent).toBe('Push to origin/APP-1-sort-by-time');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(ui.target.querySelector('[data-push-why]')?.textContent).toBe('Nothing to push yet. Commit first.');
    ui.click('[data-push]');
    expect(ui.target.querySelector('dialog')).toBeNull();
    page?.remove();

    expect(draw({ ...pushCase, change: { ...pushCase.change, commits: 0 } }).target.querySelector('[data-push-why]')?.textContent).toBe('Nothing to push. The remote has every commit.');
  });

  it("says git's words when the push is refused", async () => {
    const ui = draw(pushCase, async () => ({ ok: false, reason: 'remote: Permission denied' }));

    ui.click('[data-push]');
    ui.click('[data-confirm-push]');
    await settle();
    expect(ui.target.textContent).toContain('Git refused the push. Its words are below.');
    expect(ui.target.querySelector('pre[data-refusal]')?.textContent).toBe('remote: Permission denied');
  });
});

// Push and the pull request are actions of their own, with no step number. The push names
// where it goes, and the pull request is a link once the branch is pushed, also with nothing to push.
it('draws Push and the pull request with no step number, each on by its own state', () => {
  const ui = draw(pushCase);

  expect(ui.target.querySelector('.no')).toBeNull();
  expect(ui.target.querySelector('[data-push]')?.textContent).toBe('Push 2 commits to origin/APP-1-sort-by-time');
  expect(ui.target.querySelector('a[data-create-pr]')).toBeNull();
  expect(ui.target.querySelector('.create.off')?.textContent).toBe('Create pull request');
  page?.remove();

  const pushed = draw({ ...pushCase, pushed: true, change: { ...pushCase.change, commits: 0 } });
  expect(pushed.target.querySelector('[data-push]')?.getAttribute('aria-disabled')).toBe('true');
  expect(pushed.target.querySelector('a[data-create-pr]')?.textContent).toBe('Create pull request ↗');
});

// An agent wrote the work, so the push dialog says the hooks are skipped and offers them for one press.
it('says the git hooks are skipped, and runs them only on the press they were ticked for', async () => {
  const onpush = vi.fn<(message: string | undefined, hooks: boolean) => Promise<Answer>>(async () => ({ ok: true }));
  const ui = draw({}, onpush as never);

  ui.click('[data-push]');
  expect(ui.target.querySelector('[data-hooks]')?.textContent).toContain('Git hooks are skipped, because an agent wrote these changes.');
  const tick = ui.target.querySelector<HTMLInputElement>('[data-run-hooks]')!;
  expect(tick.checked).toBe(false);
  expect(ui.target.querySelector(`label[for="${tick.id}"]`)?.textContent).toBe('Run hooks');
  ui.click('[data-run-hooks]');
  ui.click('[data-confirm-push]');
  await settle();
  expect(onpush).toHaveBeenLastCalledWith(undefined, true);

  ui.click('[data-push]');
  expect(ui.target.querySelector<HTMLInputElement>('[data-run-hooks]')?.checked).toBe(false);
  ui.click('[data-confirm-push]');
  await settle();
  expect(onpush).toHaveBeenLastCalledWith(undefined, false);
});
