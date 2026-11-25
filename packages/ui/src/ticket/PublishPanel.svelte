<script lang="ts">
  import type { CompareUrl } from '@nolzu/protocol';
  import { tick } from 'svelte';
  import Button from '../Button.svelte';
  import Chip from '../Chip.svelte';
  import Dialog from '../Dialog.svelte';
  import ErrorBox from '../ErrorBox.svelte';
  import Help from '../Help.svelte';
  import HooksSwitch from './HooksSwitch.svelte';
  import { repoSuffix } from './repo-id.ts';

  // `rejected` is a push the remote turned down because it holds commits the branch has not got, and
  // `command` the git command that ran.
  type Answer = { ok: true } | { ok: false; reason: string; rejected?: boolean; command?: string };
  type PullAnswer = { ok: true; upToDate?: boolean } | { ok: false; reason: string; conflicts?: string[] };

  // Push and the pull request, beside Commit and never after it in a sequence: work goes out of order,
  // so each action is on by its own state. Push sends the commits the remote has not got, and commits
  // nothing. Its press asks first, in a dialog: the branch, the remote and the
  // change. It opens on every push and remembers nothing, because each push leaves the machine and
  // its press is the consent. The fields after `repo` are optional, so a page that hands only the
  // sentence still works.
  let {
    confirmation,
    pushed,
    compare,
    onpush,
    repo = '.',
    card = null,
    branch = null,
    remote = null,
    host = null,
    place = null,
    change = null,
    onpull = null,
    oncopy = null,
    onopenpr = null,
    uncommitted = 0,
    pull: existing = null,
  }: {
    // Null when the project has no remote.
    confirmation: string | null;
    pushed: boolean;
    compare: CompareUrl;
    // The message is always left out: a push commits nothing. hooks is the dialog's Run hooks tick, for
    // this one press.
    onpush: (message: undefined, hooks: boolean) => Promise<Answer>;
    // Only for the id, as on the commit composer.
    repo?: string;
    // The card's key, for the title "Push APP-1 to GitHub".
    card?: string | null;
    branch?: string | null;
    remote?: { name: string; url: string } | null;
    // "GitHub" or "GitLab", or null for a host Nolzu has no name for, and its address.
    host?: string | null;
    place?: string | null;
    // What the push takes: the change the commits add, and how many commits the remote has not got.
    change?: { added: number; removed: number; files: number; commits: number } | null;
    // "Pull into the checkout" after a rejected push. The page does the fetch, as everywhere here.
    onpull?: (() => Promise<PullAnswer>) | null;
    // The page owns the clipboard. It answers with the sentence to show, or null once it is copied.
    // Copy link uses it too, so the long compare URL is never printed.
    oncopy?: ((text: string) => Promise<string | null>) | null;
    // The page opens the pull request page, because this package never touches the browser.
    onopenpr?: ((url: string) => void) | null;
    // The files the folder holds that no commit has yet. A push leaves them in the folder.
    uncommitted?: number;
    // The card's open pull request from this remote. The push updates it, so the panel offers no new one.
    pull?: { number: number; url: string } | null;
  } = $props();

  const suffix = $derived(repoSuffix(repo));
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

  let asking = $state(false);
  let shell = $state<ReturnType<typeof Dialog>>();
  let openAfter = $state(true);
  let pushing = $state(false);
  // Off each time the dialog opens, because the dialog remembers nothing between pushes.
  let hooks = $state(false);
  let refusal = $state<string | null>(null);
  // git's words of a rejected push, with the command above them, as the error box draws them.
  let rejected = $state<string | null>(null);
  let pulling = $state(false);
  let note = $state('');
  let pushButton = $state<HTMLButtonElement>();
  let linkCopied = $state(false);

  // The commits the remote has not got. None leaves Push off, with the reason beside it.
  const ahead = $derived(change?.commits ?? 0);
  const where = $derived(branch !== null && remote !== null ? ` to ${remote.name}/${branch}` : '');
  const idle = $derived(uncommitted > 0 ? 'Nothing to push yet. Commit first.' : 'Nothing to push. The remote has every commit.');

  // A refusal goes to the status line, so "Copied" on the button only ever means it worked.
  async function copyLink(url: string): Promise<void> {
    const refused = (await oncopy?.(url)) ?? null;
    linkCopied = refused === null;
    if (refused !== null) note = refused;
  }

  function ask(): void {
    if (ahead === 0) return;
    asking = true;
    hooks = false;
  }

  async function push(): Promise<void> {
    if (pushing) return;
    shell?.close();
    pushing = true;
    refusal = null;
    rejected = null;
    note = 'Pushing.';
    const answer = await onpush(undefined, hooks);
    pushing = false;
    if (answer.ok) {
      note = 'Pushed.';
      if (openAfter && compare.ok && existing === null) onopenpr?.(compare.url);
    } else if (answer.rejected) {
      // The error box's title is the alert, so the status line stays quiet and nothing is read twice.
      note = '';
      rejected = answer.command === undefined ? answer.reason : `$ ${answer.command}\n${answer.reason}`;
    } else {
      note = 'Git refused the push. Its words are below.';
      refusal = answer.reason;
    }
  }

  // A direct git action, so it shows its own pending state. Every answer but a plain refusal takes the
  // error box down: after a pull or a conflict, pressing it again would only repeat git's refusal.
  async function pull(): Promise<void> {
    if (pulling || onpull === null) return;
    pulling = true;
    refusal = null;
    note = 'Pulling into the checkout.';
    const answer = await onpull();
    pulling = false;
    if (answer.ok) {
      rejected = null;
      note = answer.upToDate ? 'Nothing new to pull. Push again.' : 'Pulled. Check the result in Changes, then push again.';
    } else if ((answer.conflicts ?? []).length > 0) {
      rejected = null;
      note = `The pull stopped on a conflict in ${plural(answer.conflicts?.length ?? 0, 'file')}. The Changes tab names each file and says what to do.`;
    } else {
      note = 'Git refused the pull. Its words are below.';
      refusal = answer.reason;
    }
    // The box went with the button that had the focus, so the focus goes back to Push, and not to the
    // page.
    if (rejected === null) {
      await tick();
      pushButton?.focus();
    }
  }

  // Cmd Enter pushes from anywhere in the dialog, as the key cap on the button says.
  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void push();
    }
  }
</script>

<!-- Push and the pull request page of the Commit and push panel, each on by its own
     state and with no step number. -->
<section class="publish" aria-labelledby="push-title{suffix}">
  <h2 class="hidden" id="push-title{suffix}">{existing === null ? 'Push and open a pull request' : `Push to pull request #${existing.number}`}</h2>

  {#if confirmation !== null}
    <div class="step">
      <!-- Not disabled, so it keeps the focus and the reason beside it is read: the press does nothing. -->
      <button type="button" class="primary" class:off={ahead === 0} data-push aria-disabled={ahead === 0 ? 'true' : undefined} aria-busy={pushing} aria-haspopup="dialog" aria-describedby="push-why{suffix}" bind:this={pushButton} onclick={ask}
        >{ahead === 0 ? `Push${where}` : `Push ${plural(ahead, 'commit')}${where}`}</button
      >
      <span data-push-help><Help label="About the push" text="Sends the commits the remote has not got to your git host, and commits nothing." /></span>
    </div>
    <p class="quiet" id="push-why{suffix}" data-push-why>{ahead === 0 ? idle : ''}</p>
  {/if}
  {#if asking}
    <!-- The pull request page block. Cream and never amber, because a push starts no agent. -->
    <Dialog
      bind:this={shell}
      medium
      title={existing !== null ? `Push ${card ?? 'the branch'} to pull request #${existing.number}` : compare.ok && !pushed ? `Push ${card ?? 'the branch'} and open a pull request` : card === null ? 'Push the branch' : `Push ${card} to ${host ?? remote?.name ?? 'the remote'}`}
      sub="Nolzu never merges. The pull request is yours to review and merge."
      onclose={() => (asking = false)}
      {onkeydown}
      data-push-confirm
    >
      {#if branch !== null && remote !== null}
        <ul class="chips" aria-label="Where the push goes" data-push-where>
          <li>
            <Chip mono
              ><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"></circle><circle cx="6" cy="19" r="2"></circle><circle cx="18" cy="7" r="2"></circle><path d="M6 7v10"></path><path d="M18 9c0 5-6 4-11 8"></path></svg
              >{branch}</Chip
            >
          </li>
          <li><Chip mono>{repo === '.' ? '' : `${repo} → `}{remote.name} · {place ?? remote.url}</Chip></li>
          {#if change !== null}
            <li><Chip mono><span class="plus">+{change.added}</span> <span class="minus">-{change.removed}</span>{` · ${plural(change.files, 'file')} · ${plural(change.commits, 'commit')}`}</Chip></li>
          {/if}
        </ul>
      {:else}
        <p class="said">{confirmation} This leaves your machine.</p>
      {/if}
      {#if uncommitted > 0}
        <p class="quiet" data-push-leaves>{plural(uncommitted, 'file')} not committed {uncommitted === 1 ? 'stays' : 'stay'} in the folder. Commit {uncommitted === 1 ? 'it' : 'them'} first to push {uncommitted === 1 ? 'it' : 'them'} too.</p>
      {/if}
      <HooksSwitch id="push-hooks{suffix}" bind:checked={hooks} />
      {#if compare.ok && onopenpr !== null && existing === null}
        <label class="check"><input type="checkbox" bind:checked={openAfter} data-open-pr />Open the pull request page after the push, filled in from the card</label>
      {/if}
      {#snippet footer()}
        <Button variant="primary" key="⌘↵" autofocus data-confirm-push onclick={push}>{`Push ${plural(ahead, 'commit')}`}</Button>
        <Button variant="ghost" data-cancel-push onclick={() => shell?.close()}>Not yet</Button>
      {/snippet}
    </Dialog>
  {/if}
  <p class="quiet" role="status">{note}</p>
  {#if rejected !== null}
    <ErrorBox
      title="{card ?? 'The branch'} was not pushed."
      reason="{host ?? 'The remote'} has commits on the branch that the checkout does not."
      output={rejected}
      fix="Someone pushed to this branch{host === null ? '' : ` on ${host}`}. Pull their commits into the {card ?? 'card'} checkout, check the result, then push again."
      {oncopy}
    >
      {#if onpull !== null}
        <Button size="small" aria-busy={pulling ? 'true' : undefined} data-pull onclick={pull}>{pulling ? 'Pulling into the checkout' : 'Pull into the checkout'}</Button>
      {/if}
    </ErrorBox>
  {/if}
  {#if refusal !== null}
    <pre class="refusal" data-refusal>{refusal}</pre>
  {/if}

  {#if existing !== null}
    <div class="step">
      <a class="create" data-open-pull href={existing.url} target="_blank" rel="noreferrer">Open pull request #{existing.number} ↗</a>
    </div>
  {:else if !compare.ok}
    <p class="quiet">{compare.reason}</p>
  {:else}
    {@const url = compare.url}
    <div class="step">
      {#if pushed}
        <a class="create" data-create-pr href={url} target="_blank" rel="noreferrer">Create pull request ↗</a>
      {:else}
        <span class="create off">Create pull request</span>
      {/if}
      {#if oncopy !== null}
        <button type="button" class="copy" data-copy-link onclick={() => copyLink(url)}>{linkCopied ? 'Copied' : 'Copy link'}</button>
      {/if}
      {#if !pushed}
        <span data-pr-help><Help label="About the pull request" text="Push the branch first. Then this page opens with the pull request filled in." /></span>
      {/if}
    </div>
  {/if}
</section>

<style>
  /* Inside the Commit and push panel, which draws the edge. */
  .publish {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* One action across the panel, with its help or Copy link beside it. */
  .step {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .step button:not(.copy),
  .step .create {
    display: inline-flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-height: 30px;
    text-align: center;
  }

  /* Not on yet: a disabled action, with no fill. */
  .create.off,
  .primary.off {
    border-color: var(--line);
    background: transparent;
    color: var(--muted);
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .said {
    margin: 0;
    font-size: var(--text-sm);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ico {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
  }

  .plus {
    color: var(--green);
  }

  .minus {
    color: var(--red);
  }

  /* Amber is the colour of a run starting. A push starts none, so the box is cream. */
  .check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  .check input {
    accent-color: var(--accent);
  }

  button,
  .create {
    padding: 5px 11px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
    text-decoration: none;
  }


  .primary {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 500;
  }

  .quiet {
    margin: 0;
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  .copy {
    flex: none;
    min-height: 30px;
  }

  .refusal {
    margin: 0;
    padding: 9px;
    border: 1px solid var(--red);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    white-space: pre-wrap;
  }
</style>
