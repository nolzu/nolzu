<script lang="ts">
  import { type BoardKind, type StageView, ticketLink } from '@nolzu/protocol';
  import { onMount, tick } from 'svelte';
  import Button from '../Button.svelte';
  import Dialog from '../Dialog.svelte';
  import { addWords, canSubmit, cardKey, type CardPayload, cardPayload, copyContext, pressOf, readInput, startOffer, type Tickets } from './add-card.ts';

  type Made = { ok: true; key: string; note: string | null } | { ok: false; reason: string };
  type Connected = { ok: true } | { ok: false; reason: string };
  type Draft = { input: string; description: string; extra: string };

  // The page sends the card, because this package never fetches, and shows what came of it once the
  // dialog has closed. The dialog is on the page only while it is open.
  let {
    prefix,
    board = 'delivery',
    off = [],
    snapshots = [],
    sources = async () => [],
    next = async () => null,
    tickets = 'local',
    onconnect,
    onsubmit,
    onclose,
    draft = $bindable(null),
  }: {
    prefix: string;
    // The board the card goes on: the one the page shows. The dialog offers no other.
    board?: BoardKind;
    // The boards turned off on /projects, so a hint never sends the person to one of them.
    off?: readonly BoardKind[];
    // Each board's stages from the live snapshot: the column a card lands in, and the start the go button
    // offers. A board with none offers no start yet.
    snapshots?: readonly { kind: BoardKind; stages: readonly StageView[] }[];
    // The cards whose extra context can be copied, asked for when the dialog opens.
    sources?: () => Promise<readonly { key: string; title: string; extra: string }[]>;
    // The key the next local card on the board gets, asked for when the dialog opens.
    next?: (board: BoardKind) => Promise<string | null>;
    // The project's ticket system. With Jira, a typed key or a Jira link is read from Jira.
    tickets?: Tickets;
    // Connect Jira, offered when a Jira link is pasted on a local project. The page posts it, because
    // this package never fetches. Left out, no offer is drawn.
    onconnect?: (form: { site: string; email: string; token: string }) => Promise<Connected>;
    // `start` is the go button, which adds the card and starts its first auto stage in one call.
    onsubmit: (payload: CardPayload & { board: BoardKind; start?: true }) => Promise<Made>;
    onclose: () => void;
    // What was typed when the dialog last closed without a card, kept by the page so a stray click on
    // the backdrop loses nothing. The Jira token is never kept.
    draft?: Draft | null;
  } = $props();

  const uid = $props.id();
  let shell: ReturnType<typeof Dialog>;
  let input = $state(draft?.input ?? '');
  let description = $state(draft?.description ?? '');
  let sending = $state(false);
  // Which of the two buttons sent, so only the pressed one says it is busy.
  let starting = $state(false);
  let refusal = $state('');
  let extra = $state(draft?.extra ?? '');
  let extraOpen = $state((draft?.extra ?? '') !== '');
  let copyable = $state<readonly { key: string; title: string; extra: string }[]>([]);
  let nextKey = $state<string | null>(null);
  // A copy that waits for a yes, because the field holds text the person typed.
  let asking = $state<{ key: string; extra: string } | null>(null);
  // The system as the dialog knows it, so a Connect that went through reads the key from Jira at once.
  // svelte-ignore state_referenced_locally
  let system = $state<Tickets>(tickets);
  // Keep it as a local card closes the offer for the life of the dialog.
  let kept = $state(false);
  // The three Jira fields, shown after the first press of Connect Jira. The token lives here only
  // until it is sent.
  let connecting = $state(false);
  let site = $state('');
  let email = $state('');
  let token = $state('');
  let connectSending = $state(false);
  let connectRefusal = $state('');

  const words = $derived(addWords(board));
  const reading = $derived(readInput(input, prefix, board, off, system));
  const key = $derived(cardKey(input, prefix, board, nextKey, system));
  const offerConnect = $derived(reading.kind === 'connect' && !kept && onconnect !== undefined);
  const offer = $derived(startOffer(snapshots.find((one) => one.kind === board)?.stages));
  // The model a refusal names, set in mono like every model.
  const refusedModel = $derived(offer.refused === null ? null : (snapshots.find((one) => one.kind === board)?.stages[1]?.starts?.model ?? null));
  const held = $derived(sending || !canSubmit({ input, description }, prefix, board, system));

  // The dialog opens as it mounts, so the cards to copy from and the next key are asked for then too.
  onMount(() => {
    void sources().then((found) => (copyable = found));
    void next(board).then((found) => (nextKey = found));
  });

  let extraField: HTMLTextAreaElement;
  let replaceButton = $state<HTMLButtonElement | null>(null);

  async function copyFrom(picker: HTMLSelectElement): Promise<void> {
    const source = copyable.find((card) => card.key === picker.value);
    // Back to "Pick a card", so the same card can be picked again.
    picker.value = '';
    if (source === undefined) {
      asking = null;
      return;
    }
    const copied = copyContext(extra, source.extra);
    extra = copied.text;
    asking = copied.ask ? { key: source.key, extra: source.extra } : null;
    // Open, so the person sees what was copied, and the field can take the focus after the question.
    extraOpen = true;
    // The question takes the focus, so a screen reader reads it rather than missing it.
    await tick();
    replaceButton?.focus();
  }

  function answer(replace: boolean): void {
    if (replace && asking !== null) extra = asking.extra;
    asking = null;
    extraField.focus();
  }

  // The first press shows the fields, with the site of the link filled in. The second sends them.
  async function connect(): Promise<void> {
    if (!connecting) {
      const link = ticketLink(input);
      // Only an Atlassian Cloud host is filled in. A pasted link can come from anyone, and the token
      // goes to the site in this box, so any other host is typed by the person.
      if (site === '' && link?.system === 'jira' && link.host.endsWith('.atlassian.net')) site = `https://${link.host}`;
      connecting = true;
      await tick();
      document.getElementById(`${uid}-jira-site`)?.focus();
      return;
    }
    if (connectSending || onconnect === undefined) return;
    connectSending = true;
    connectRefusal = '';
    const answer = await onconnect({ site, email, token });
    connectSending = false;
    if (!answer.ok) {
      connectRefusal = answer.reason;
      return;
    }
    token = '';
    connecting = false;
    system = 'jira';
    backToField();
  }

  function keepLocal(): void {
    kept = true;
    backToField();
  }

  // The box leaves with the button that had the focus, so the focus goes back to the field.
  const backToField = () => document.getElementById('card-input')?.focus();

  // Enter in a Jira field connects, and never sends the card form around it.
  function connectKeys(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    void connect();
  }

  // One way in for Add to Inbox, the go button and both keys. A press while the card is on its way sends
  // nothing, so a double press never makes two cards or two runs.
  async function send(start: boolean): Promise<void> {
    if (held || (start && offer.stage === null)) return;
    sending = true;
    starting = start;
    refusal = '';
    const payload = cardPayload({ input, description, extra: extra.trim() === '' ? undefined : extra }, prefix);
    const made = await onsubmit({ ...payload, board, ...(start ? { start: true as const } : {}) });
    sending = false;
    if (made.ok) {
      added = true;
      shell.close();
    }
    else refusal = made.reason;
  }

  let added = false;
  function closed(): void {
    draft = added ? null : { input, description, extra };
    onclose();
  }

  // Cmd Enter adds the card and never starts a run. Shift Cmd Enter is the go button. Held here, so a
  // focused button never turns the key into its own click.
  function keys(event: KeyboardEvent): void {
    const press = pressOf(event);
    if (press === null) return;
    event.preventDefault();
    void send(press === 'start');
  }
</script>

<!-- Esc and the close button wait while the card is on its way, or its answer would land on a dialog that
     is gone. The buttons sit in the footer, outside the form, so the submit button names the form it sends. -->
<Dialog bind:this={shell} title={words.title} closer="Close without adding" medium held={sending} onclose={closed} onkeydown={keys}>
  <form
    id="{uid}-form"
    onsubmit={(event) => {
      event.preventDefault();
      void send(false);
    }}
  >
    <div class="field">
      <div class="label-row">
        <label for="card-input">{words.label}</label>
        <span class="key" id="card-key" data-card-key>{key === null ? '' : `becomes ${key}`}</span>
      </div>
      <!-- svelte-ignore a11y_autofocus -->
      <input id="card-input" bind:value={input} autocomplete="off" autofocus aria-describedby="card-key card-reading" />
      <p class="quiet" id="card-reading">
        {#if reading.says !== ''}{reading.says}{:else if board === 'prreview'}Type owner/repo#number, or paste the pull request link from GitHub. It is read through
          <code>gh</code>.{:else if system === 'jira'}A Jira key or link is read from Jira, and a GitHub issue or pull request link through <code>gh</code>.{:else}A GitHub
          issue or pull request link is read through <code>gh</code>.{/if}
      </p>
    </div>

    <!-- A Jira link on a local project. Blue, because it
         is information and starts nothing. The fields sit inside the card form, so Enter in them is
         held here and connects. -->
    {#if offerConnect}
      <div class="link-offer" data-connect-jira role="group" aria-label="Connect Jira">
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v5h1"></path></svg>
        <div class="offer-body">
          <span>That is a Jira ticket. Connect Jira to read its title and text into the card.</span>
          <span class="offer-sub">The token goes in your keychain on this machine. Nothing is sent anywhere else.</span>
          {#if connecting}
            <label for="{uid}-jira-site">Jira site address</label>
            <input id="{uid}-jira-site" class="mono" bind:value={site} placeholder="https://your-site.atlassian.net" autocomplete="off" onkeydown={connectKeys} />
            <label for="{uid}-jira-email">Account email</label>
            <input id="{uid}-jira-email" bind:value={email} placeholder="you@example.com" autocomplete="off" onkeydown={connectKeys} />
            <label for="{uid}-jira-token">API token</label>
            <input id="{uid}-jira-token" type="password" bind:value={token} autocomplete="new-password" onkeydown={connectKeys} />
            <p class="refusal" role="alert">{connectRefusal}</p>
          {/if}
          <div class="offer-actions">
            <Button variant="primary" size="small" data-connect aria-busy={connectSending ? 'true' : undefined} aria-disabled={connectSending ? 'true' : undefined} onclick={() => void connect()}
              >Connect Jira</Button
            >
            <Button size="small" data-keep-local onclick={keepLocal}>Keep it as a local card</Button>
          </div>
        </div>
      </div>
    {/if}

    {#if reading.kind === 'text'}
      <div class="field">
        <label for="card-description">Description</label>
        <textarea id="card-description" rows="3" bind:value={description} placeholder="What done looks like"></textarea>
      </div>
    {/if}

    <!-- Folded, because most cards need none. The field stays on the page, so a copy can fill it. -->
    <details class="fold" bind:open={extraOpen}>
      <summary
        ><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m10 7 5 5-5 5"></path></svg><span class="fold-name">Extra context</span><span class="quiet">for the agents, not the ticket</span><span
          class="quiet optional">optional</span
        ></summary
      >
      <textarea
        id="card-extra"
        aria-label="Extra context"
        bind:this={extraField}
        bind:value={extra}
        oninput={() => (asking = null)}
        placeholder="What the ticket does not say, for every run of this card"
      ></textarea>
    </details>

    {#if copyable.length > 0}
      <div class="field">
        <label for="card-copy">Copy context from</label>
        <select id="card-copy" onchange={(event) => copyFrom(event.currentTarget)}>
          <option value="">Pick a card</option>
          {#each copyable as card (card.key)}<option value={card.key}>{card.key} · {card.title}</option>{/each}
        </select>
      </div>
    {/if}
    {#if asking !== null}
      <div class="ask" role="group" aria-label="Copy context">
        <p>Replace your text with the context of {asking.key}?</p>
        <button type="button" data-replace bind:this={replaceButton} onclick={() => answer(true)}>Replace</button>
        <button type="button" data-keep-mine onclick={() => answer(false)}>Keep mine</button>
      </div>
    {/if}

    <p class="refusal" role="alert">{refusal}</p>
  </form>
  {#snippet footer()}
    <div class="actions">
      <div>
        <Button
          variant="primary"
          type="submit"
          form="{uid}-form"
          key="⌘↵"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          data-add-card
          aria-disabled={held ? 'true' : undefined}
          aria-busy={sending && !starting ? 'true' : undefined}>{offer.first === null ? words.title : `Add to ${offer.first}`}</Button
        >
        {#if offer.first !== null}<span class="note">Lands in {offer.first}. Nothing runs.</span>{/if}
      </div>
      <!-- The one amber button, because it is where an agent starts. A refused start starts no agent, so it
           loses the amber, as the refused column does. It is no submit button, so Enter in the title field
           never picks it. -->
      {#if offer.stage !== null}
        <div>
          <Button variant={offer.refused === null ? 'go' : 'default'} key="⇧⌘↵" aria-keyshortcuts="Shift+Meta+Enter Shift+Control+Enter" data-add-start aria-disabled={held ? 'true' : undefined} aria-busy={sending && starting ? 'true' : undefined} onclick={() => void send(true)}
            >Add and start {offer.stage}</Button
          >
          {#if offer.line !== null}<span class="line" data-start-line>{offer.line}</span>{:else if offer.refused !== null}<span class="note" data-start-line
              >{#each refusedModel === null ? [offer.refused] : offer.refused.split(refusedModel) as part, i (i)}{#if i > 0}<code>{refusedModel}</code>{/if}{part}{/each}</span
            >{/if}
        </div>
      {/if}
    </div>
  {/snippet}
</Dialog>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  label {
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--ink-2);
  }

  .label-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .key {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--mono-card-key);
    color: var(--muted);
  }

  input,
  textarea,
  select {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
  }

  input,
  select {
    height: 34px;
    padding: 0 10px;
  }

  textarea {
    padding: 10px var(--space-3);
    line-height: 1.5;
    resize: none;
  }

  /* Three lines tall when empty. */
  #card-description {
    min-height: calc(4.5em + 22px);
  }

  #card-extra {
    margin-top: var(--space-2);
    min-height: 80px;
    resize: vertical;
  }

  .quiet,
  .refusal {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  /* Ink and muted on the blue tint over the card, the pairs tokens.test.ts holds. The second button is
     the plain one and not a ghost, because ink-2 on the tint is a pair no test measures. */
  .link-offer {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    padding: var(--space-3) 14px;
    border-radius: var(--radius-lg);
    background: var(--blue-bg);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .link-offer .icon {
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    fill: none;
    stroke: var(--blue);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .offer-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .link-offer label {
    color: var(--ink);
  }

  .offer-sub {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .offer-actions {
    display: flex;
    gap: var(--space-2);
  }

  input.mono {
    font-family: var(--font-mono);
  }

  code {
    padding: 0 4px;
    border: 1px solid var(--line);
    border-radius: var(--radius-xs);
    background: var(--card-2);
    font-family: var(--font-mono);
    font-size: 0.92em;
  }

  .refusal {
    color: var(--ink);
  }

  .refusal:empty {
    display: none;
  }

  /* Wraps rather than squeezes: in a narrow window the hint goes to its own line and the name stays whole. */
  .fold summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px var(--space-2);
    box-sizing: border-box;
    min-height: 34px;
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    color: var(--ink-2);
    font-size: var(--text-sm);
    list-style: none;
    cursor: pointer;
  }

  .fold summary::-webkit-details-marker {
    display: none;
  }

  .fold-name {
    white-space: nowrap;
  }

  .fold .optional {
    margin-left: auto;
  }

  .chev {
    flex: none;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .fold[open] .chev {
    transform: rotate(90deg);
  }

  button {
    padding: 5px 11px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    font: inherit;
    font-size: var(--text-xs);
  }

  .ask {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    border-left: 2px solid var(--muted);
    /* One step up from the dialog card, so the question reads as a box. */
    background: var(--card-2);
    font-size: var(--text-xs);
  }

  .ask p {
    margin: 0;
    flex-basis: 100%;
  }

  /* Two columns, and one when the window is too narrow for both buttons side by side. */
  .actions {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
    gap: var(--space-4);
    container-type: inline-size;
  }

  /* Side by side, the start button sits at the right edge. 560px is two 17rem columns and
     the gap, where the grid above puts them side by side; stacked, both stay at the left. */
  @container (min-width: 560px) {
    .actions > div + div {
      align-items: flex-end;
    }
  }

  .actions > div {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 7px;
    min-width: 0;
  }

  /* A long stage name wraps inside its button rather than out of the dialog. */
  .actions :global(.btn) {
    max-width: 100%;
    height: auto;
    min-height: 30px;
    padding-block: 5px;
    white-space: normal;
    text-align: left;
  }

  .note {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .line {
    font-family: var(--font-mono);
    font-size: var(--mono-card-key);
    color: var(--ink-2);
  }
</style>
