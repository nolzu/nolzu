<script lang="ts">
  import { pullRequestRef } from '@nolzu/protocol';
  import { tick } from 'svelte';
  import Button from '../Button.svelte';
  import Chip from '../Chip.svelte';
  import Dialog from '../Dialog.svelte';

  interface CardPullRow {
    repo: string;
    number: number;
    url: string | null;
    title: string | null;
    state: 'open' | 'closed' | 'merged' | null;
    foundBy: 'branch' | 'attached';
    // How many discussions on this card a detach takes with it, for the question.
    discussions?: number;
  }

  // The card's pull requests and the attach field. Attach and detach are direct writes, not runs, so
  // the form holds its own pending state. Each callback answers the refusal sentence, or null once done.
  let {
    pulls,
    onattach,
    ondetach,
  }: {
    pulls: readonly CardPullRow[];
    onattach: (link: string) => Promise<string | null>;
    ondetach: (link: string) => Promise<string | null>;
  } = $props();

  const uid = $props.id();
  const STATE_WORD = { open: 'Open', closed: 'Closed', merged: 'Merged' } as const;

  let link = $state('');
  let busy = $state(false);
  let said = $state('');
  // A refusal reads in red, so it does not look like the line that says it worked.
  let failed = $state(false);

  const name = (pull: CardPullRow) => `${pull.repo}#${pull.number}`;
  // The pull request Detach asks about, while its question is open.
  let asking = $state<CardPullRow | null>(null);
  let shell: ReturnType<typeof Dialog> | undefined = $state();
  let section: HTMLElement;
  let field: HTMLInputElement;
  const losesLine = (pull: CardPullRow) => {
    const count = pull.discussions ?? 0;
    if (count === 0) return `The card loses ${name(pull)}.`;
    return count === 1 ? `The card loses ${name(pull)} and its 1 discussion with its messages.` : `The card loses ${name(pull)} and its ${count} discussions with their messages.`;
  };

  async function attach(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const typed = link.trim();
    if (typed === '' || busy) return;
    busy = true;
    said = 'Reading the pull request from GitHub.';
    failed = false;
    const refused = await onattach(typed);
    busy = false;
    // The name as the list shows it, not the link as typed, which can carry a /files tail.
    const ref = pullRequestRef(typed);
    said = refused ?? `Attached ${'name' in ref ? ref.name : typed}.`;
    failed = refused !== null;
    if (refused === null) link = '';
  }

  // Held while it runs, so Esc waits for the answer. The dialog closes the way Cancel does, so focus
  // goes back to Detach on a refusal.
  async function detach(event: Event): Promise<void> {
    event.preventDefault();
    const pull = asking;
    if (pull === null || busy) return;
    busy = true;
    const refused = await ondetach(name(pull));
    busy = false;
    said = refused ?? `Detached ${name(pull)}.`;
    failed = refused !== null;
    await tick();
    shell?.close();
  }

  // Once the row is gone its Detach cannot take focus back, so the link field gets it.
  function closed(): void {
    asking = null;
    if (!section.contains(document.activeElement)) field.focus();
  }
</script>

<section class="prs" aria-labelledby="{uid}-title" bind:this={section}>
  <h2 id="{uid}-title">Pull requests</h2>
  {#if pulls.length === 0}
    <p class="muted">No pull request on this card yet. Push the branch and open one from the Changes tab, then Read comments finds it by the branch. You can attach others below.</p>
  {:else}
    <ul>
      {#each pulls as pull (name(pull))}
        <li>
          <a class="mono" href={pull.url ?? `https://github.com/${pull.repo}/pull/${pull.number}`} target="_blank" rel="noreferrer">{name(pull)}</a>
          {#if pull.title !== null}<span class="title">{pull.title}</span>{/if}
          <Chip>{pull.state === null ? 'Not read yet' : STATE_WORD[pull.state]}</Chip>
          <span class="end">
            {#if pull.foundBy === 'branch'}
              <span class="muted">Found by the branch, so it stays</span>
            {:else}
              <Button variant="ghost" size="small" disabled={busy} data-detach={name(pull)} aria-label="Detach {name(pull)}" onclick={() => (asking = pull)}>Detach</Button>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
  <form onsubmit={attach}>
    <label for="{uid}-link">Attach a pull request</label>
    <div class="row">
      <input id="{uid}-link" bind:this={field} bind:value={link} placeholder="https://github.com/owner/repo/pull/12 or owner/repo#12" autocomplete="off" spellcheck="false" />
      <Button type="submit" disabled={busy} aria-busy={busy ? 'true' : undefined}>Attach</Button>
    </div>
    <p class="muted" class:failed role="status">{said}</p>
  </form>
</section>

{#if asking !== null}
  <Dialog bind:this={shell} title="Detach {name(asking)}?" held={busy} onclose={closed} role="alertdialog" aria-describedby="{uid}-loses">
    <form id="{uid}-detach" onsubmit={detach}>
      <p class="loses" id="{uid}-loses">{losesLine(asking)} The pull request on GitHub stays.</p>
    </form>
    {#snippet footer()}
      <!-- Red, as a delete is drawn. The first control, so it has the focus when the question opens. -->
      <Button variant="danger" type="submit" form="{uid}-detach" aria-busy={busy ? 'true' : undefined} data-detach-confirm>Detach</Button>
      <Button variant="ghost" key="Esc" disabled={busy} onclick={() => shell?.close()} data-detach-cancel>Cancel</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .prs {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  h2 {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
  }

  li + li {
    border-top: 1px solid var(--line);
  }

  a {
    color: var(--ink);
  }

  .title {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--ink-2);
  }

  .end {
    margin-left: auto;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .muted {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-sm);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .failed {
    color: var(--red);
  }

  .loses {
    margin: 0;
    font-size: var(--text-sm);
  }

  label {
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .row {
    display: flex;
    gap: var(--space-2);
  }

  input {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  /* The browser's grey placeholder fails AA on this background in both themes. */
  input::placeholder {
    color: var(--muted);
    opacity: 1;
  }
</style>
