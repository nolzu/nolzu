<script lang="ts">
  import { type Estimate, estimateFrom, estimateText, formatCost, formatDuration, formatTokens } from '@nolzu/protocol';
  import Button from '../Button.svelte';
  import Markdown from '../Markdown.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { engineName, startsCommand } from '../board/drop.ts';
  import { nearBottom } from './follow.ts';
  import { byteSize } from './log.ts';

  // The shapes the page hands over. This package reads only the protocol, so they are spelled out
  // here, the same way the Settings tab does it.
  interface Thread {
    id: string;
    kind: string;
    label: string;
    sessionId: string | null;
    engine: string | null;
    // How many messages it holds, and when its run started, for the list. `when` is that start in the
    // trail's words, written by the server so the zone is the machine's.
    count?: number;
    at?: string | null;
    when?: string | null;
    // An ask discussion's subject, from the pass after its first answer or from a person, and the start
    // of its first message, which the list shows until there is a subject.
    subject?: string | null;
    opening?: string | null;
  }
  interface ToolCall {
    name: string;
    subject: string | null;
    input: string;
    result: { bytes: number; error: boolean } | null;
  }
  interface Message {
    id: number;
    author: string;
    body: string;
    at: string;
    // An agent message's tool calls, read from its run's log. Null when that log is gone.
    tools?: readonly ToolCall[] | null;
    run?: { model: string | null; durationMs: number | null; tokens: number | null; costUsd: number | null };
    // `at` in the trail's words: the time today, a short day before it otherwise.
    when?: string | null;
    // On the first message of each run: the line drawn above it.
    divider?: { phase: string; started: string | null; durationMs: number | null; costUsd: number | null; wrote: readonly string[] };
    // On an answer from Before you approve: the column whose phase reads it. No agent of this phase does.
    forNext?: string;
  }

  let {
    threads,
    later = [],
    order = [],
    current,
    messages,
    models,
    phaseModel,
    phaseEffort = null,
    estimates = {},
    resume,
    next,
    asking = false,
    toolsWaiting = false,
    onsend,
    oncopy,
    onrename = async () => 'Renaming is not offered here.',
  }: {
    threads: readonly Thread[];
    // The board's phases that have not run yet, listed greyed: a thread opens once its phase runs.
    later?: readonly { id: string; label: string }[];
    // The board's phases in the order they run. The list keeps it, threads and greyed ones together.
    order?: readonly string[];
    current: string;
    messages: readonly Message[];
    // The models of the engine the thread's session ran on. A resume cannot move to another engine,
    // so the engine is plain text and only the model is a picker.
    models: readonly string[];
    // The model a message runs on when none is picked, named so the default is not a guess.
    phaseModel: string | null;
    // The effort it runs at, which a message keeps.
    phaseEffort?: string | null;
    // What a run of this phase costs per model, only where runs measured it.
    estimates?: Readonly<Record<string, Estimate>>;
    // The terminal command that continues the open thread's session, or null when there is none.
    resume: string | null;
    // The thread id a new ask discussion takes.
    next: string;
    // The open thread's run still goes, read off its run row by the server, so Send holds until the
    // answer comes, also after a reload. An Ask run never shows on the card, so the snapshot cannot say it.
    asking?: boolean;
    // True while the page reads each run's log for its tool calls, which lands after the page drew.
    toolsWaiting?: boolean;
    // The page does the write, because this package never fetches. It answers with the sentence
    // the send was refused with, or null once the run is asked for.
    onsend: (thread: string, text: string, model: string) => Promise<string | null>;
    // The page owns the clipboard. It answers with the sentence to show, or null once it is copied.
    oncopy: (text: string) => Promise<string | null>;
    // Renames an ask discussion. The page does the write and answers with the refusal, or null.
    onrename?: (thread: string, subject: string) => Promise<string | null>;
  } = $props();

  const EMPTY = 'The message is empty. Write it above, then send it.';
  const WAIT = 'The agent is still answering. Wait for its answer, then send the next message.';
  // Limit: a run with more calls than this folds them under one line, so an Implement summary is
  // not a page of rows. One line per call is what the Log tab is for.
  const CALLS_SHOWN = 6;

  let draft = $state('');
  let model = $state('');
  let sending = $state(false);
  let status = $state('');
  let copied = $state('');
  let picking = $state(false);
  // A refused copy prints the command, so a person can still select it by hand.
  let refused = $state(false);

  // What a list row and the open thread's heading call a thread: an ask discussion by its subject, else
  // by the start of its first message, else by its label.
  const named = (one: Thread) => (one.kind === 'ask' ? (one.subject ?? one.opening ?? one.label) : one.label);

  // The three dot menu beside an ask discussion, as the menu button pattern has it: the button opens a
  // menu of one item, which takes the focus; Escape or a press outside closes it and gives the focus back.
  let menuFor = $state<string | null>(null);
  let renaming = $state<string | null>(null);
  let name = $state('');
  let saving = $state(false);
  let renameNote = $state('');
  function openMenu(id: string): void {
    menuFor = id;
    requestAnimationFrame(() => document.getElementById(`menu-${id}`)?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
  }
  function closeMenu(focusButton: boolean): void {
    const id = menuFor;
    menuFor = null;
    if (focusButton && id !== null) document.getElementById(`menu-button-${id}`)?.focus();
  }
  function startRename(one: Thread): void {
    menuFor = null;
    renaming = one.id;
    name = one.subject ?? one.opening ?? '';
    renameNote = '';
    requestAnimationFrame(() => document.getElementById(`rename-${one.id}`)?.focus());
  }
  function stopRename(): void {
    const id = renaming;
    renaming = null;
    renameNote = '';
    if (id !== null) requestAnimationFrame(() => document.getElementById(`menu-button-${id}`)?.focus());
  }
  async function saveName(): Promise<void> {
    if (saving || renaming === null) return;
    if (name.trim() === '') {
      renameNote = 'The name is empty. Write a few words that say what the discussion is about.';
      return;
    }
    saving = true;
    let refused: string | null;
    try {
      refused = await onrename(renaming, name.trim());
    } catch {
      refused = 'The name could not be saved. The local app is not answering.';
    } finally {
      saving = false;
    }
    if (refused === null) stopRename();
    else renameNote = refused;
  }
  function onRenameKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveName();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      stopRename();
    }
  }
  // A press anywhere but the open menu closes it, as a native menu does.
  $effect(() => {
    if (menuFor === null) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest('.thread-menu') === null) menuFor = null;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  });

  async function copy(command: string): Promise<void> {
    const said = await oncopy(command);
    refused = said !== null;
    copied = said ?? 'Copied. Paste it into a terminal to continue the session there.';
  }

  // Phase order: a thread and a phase that has not run yet sit
  // where their phase runs. A phase the board does not name goes last, in the order it came.
  const rank = (id: string) => {
    const at = order.indexOf(id);
    return at === -1 ? order.length : at;
  };
  const phases = $derived(
    [...threads.filter((one) => one.kind !== 'ask').map((one) => ({ one, off: false })), ...later.map((one) => ({ one, off: true }))]
      .map((entry, at) => ({ ...entry, at }))
      .sort((a, b) => rank(a.one.id) - rank(b.one.id) || a.at - b.at),
  );
  const asks = $derived(threads.filter((one) => one.kind === 'ask'));
  // An ask discussion with nothing in it is the Ask row, and the list shows only the ones that
  // hold something. The open empty one is that row, else the first empty one, else a new id.
  const empty = (one: Thread) => (one.count ?? 0) === 0 && one.sessionId === null;
  const fresh = $derived(asks.find((one) => empty(one) && one.id === current) ?? asks.find(empty) ?? null);
  const askHref = $derived(`?thread=${fresh?.id ?? next}`);
  const askOpen = $derived(fresh !== null && fresh.id === current);

  const thread = $derived(threads.find((one) => one.id === current) ?? null);
  // An ask discussion goes on in its read-only session, or starts one, so it takes a message with no
  // session, and so does the discussion of a pull request comment, which is the same kind of session.
  // Every other thread continues its phase's session, and one that kept none says so rather than
  // offering a box that cannot send.
  const isAsk = $derived(thread?.kind === 'ask' || thread?.kind === 'feedback');
  const canSend = $derived(thread !== null && (isAsk || thread.sessionId !== null));
  // A press starts or resumes a run, which is the one place amber goes.
  const goes = $derived(canSend);
  const held = $derived(sending || asking || draft.trim() === '' || !canSend);
  // From the press until the answer lands or the run ends: the send itself, then the run it started.
  const busy = $derived(sending || asking);
  const phase = $derived(thread?.label.toLowerCase() ?? '');
  const engine = $derived(thread?.engine == null ? null : engineName(thread.engine));
  const command = $derived(thread?.engine != null && phaseModel !== null && phaseEffort !== null ? startsCommand({ engine: thread.engine, model: phaseModel, effort: phaseEffort }) : null);
  const estimate = $derived(estimates[model === '' ? (phaseModel ?? '') : model]);
  const agentName = $derived(thread?.kind === 'phase' ? `${thread.label} agent` : 'Agent');
  // What the empty choice of the picker runs: the ask row in an ask discussion, the phase's row elsewhere.
  const rowModel = $derived(isAsk ? 'the Ask model' : "the phase's model");

  // A caller that sends no `when` gets the stored stamp, cut to the minute.
  const when = (at: string) => at.slice(0, 16).replace('T', ' ');
  const said = (one: { at?: string | null; when?: string | null }) => one.when ?? (one.at ? when(one.at) : null);
  const picked = $derived(model === '' ? (phaseModel ?? rowModel) : model);
  // "Plan run 15:31 · 1m 12s · $0.11 · wrote plan/plan.md", each part only where the run row has it.
  // Limit: three files, then a count, so a phase that wrote many does not fill the line.
  const dividerLine = (one: NonNullable<Message['divider']>) =>
    [
      `${one.phase} run${one.started === null ? '' : ` ${one.started}`}`,
      one.durationMs === null ? null : formatDuration(one.durationMs),
      one.costUsd === null ? null : formatCost(one.costUsd),
      one.wrote.length === 0 ? null : `wrote ${one.wrote.slice(0, 3).join(', ')}${one.wrote.length > 3 ? ` and ${one.wrote.length - 3} more` : ''}`,
    ]
      .filter((part) => part !== null)
      .join(' · ');
  function choose(value: string): void {
    model = value;
    picking = false;
  }
  // What the run spent, each part only where the engine reported it.
  // The message is written once its run ended, so a cost it has not reported is not on its way.
  const figures = (run: NonNullable<Message['run']>) =>
    [run.durationMs === null ? null : formatDuration(run.durationMs), run.tokens === null ? null : `${formatTokens(run.tokens)} tokens`, run.costUsd === null ? 'no cost reported' : formatCost(run.costUsd)]
      .filter((part) => part !== null)
      .join(' · ');
  const resultLine = (result: ToolCall['result']) =>
    result === null ? 'The log holds no result for this call.' : `${result.error ? 'Error result' : 'Result'}, ${byteSize(result.bytes)}. Its text stays in the raw log on the Log tab.`;

  async function send(): Promise<void> {
    if (sending || thread === null || !canSend) return;
    if (asking) {
      status = WAIT;
      return;
    }
    if (draft.trim() === '') {
      status = EMPTY;
      return;
    }
    sending = true;
    status = '';
    // Let go whatever happens, so a write that throws never leaves Send busy for the life of the page.
    try {
      const refused = await onsend(thread.id, draft, model);
      if (refused === null) {
        draft = '';
        // An Ask run takes no place on the board, so it must not say it waits for one.
        status = isAsk ? 'Sent. The answer shows here when the run ends.' : 'Sent. Waiting for the board to queue the run.';
      } else {
        status = refused;
      }
    } catch {
      status = 'The message could not be sent. The local app is not answering.';
    } finally {
      sending = false;
    }
  }

  // The answer is in, so the line that said it was coming has done its job.
  let wasAsking = false;
  $effect(() => {
    if (wasAsking && !asking && status.startsWith('Sent.')) status = '';
    wasAsking = asking;
  });

  // The tab opens on the newest message, and the component is keyed on the thread, so a switch opens
  // there too. A frame later, because the router scrolls to the top once the page has drawn. After
  // that the page follows what lands (a message, the tool calls, the answering line) only while the
  // person is at the end: one who scrolled up to read stays where they are.
  let section = $state<HTMLElement | null>(null);
  $effect(() => {
    if (section === null) return;
    const end = () => window.scrollTo({ top: document.documentElement.scrollHeight });
    let follow = true;
    const read = () => (follow = nearBottom(window.scrollY, window.innerHeight, document.documentElement.scrollHeight));
    const frame = requestAnimationFrame(() => {
      end();
      follow = true;
    });
    window.addEventListener('scroll', read, { passive: true });
    const grows = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => follow && end());
    grows?.observe(section);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', read);
      grows?.disconnect();
    };
  });

  // Cmd Enter sends from the field, as the key cap on Send says.
  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  }
</script>

{#snippet link(one: Thread)}
  <a class="thread" class:current={one.id === current} aria-current={one.id === current ? 'page' : undefined} href="?thread={one.id}"
    ><span class="label">{named(one)}</span>{#if (one.count ?? 0) > 0}<span class="n">{one.count}</span>{/if}
    <span class="t2">
      {#if one.sessionId !== null}
        <span class="mono">session {one.sessionId.slice(0, 8)}{#if said(one)}{` · ${said(one)}`}{/if}</span>
      {:else if one.kind === 'ask'}
        A read-only session about this card
      {:else if one.kind === 'feedback'}
        A read-only session about this comment
      {:else}
        no session
      {/if}
    </span>
  </a>
{/snippet}

<!-- Three dots that pulse in turn while something is on its way. Hidden from screen readers, which read
     the words beside them. -->
{#snippet dots()}<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>{/snippet}

{#snippet tool(call: ToolCall)}
  <!-- Folded by default. A native disclosure, so the keyboard and a screen reader open it. -->
  <details class="tool">
    <summary>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>
      <b>{call.name}</b>
      {#if call.subject !== null}<span class="subject">{call.subject}</span>{/if}
      {#if call.result !== null}<span class="size">{call.result.error ? 'error, ' : ''}{byteSize(call.result.bytes)}</span>{/if}
    </summary>
    <div class="call">
      <p class="part">Input</p>
      <pre>{call.input}</pre>
      <p class="part">Result</p>
      <p class="result">{resultLine(call.result)}</p>
    </div>
  </details>
{/snippet}

<section class="discussion" bind:this={section}>
  <nav class="threads" aria-label="Threads">
    <p class="part">Threads</p>
    {#each phases as { one, off } (one.id)}
      {#if off}
        <span class="thread off">{one.label}<span class="t2">Opens when {one.label} runs</span></span>
      {:else}
        {@render link(one as Thread)}
      {/if}
    {/each}
    {#each asks.filter((one) => !empty(one)) as one (one.id)}
      <div class="asked">
        {#if renaming === one.id}
          <div class="rename">
            <label class="sr" for="rename-{one.id}">Name of this discussion</label>
            <input id="rename-{one.id}" type="text" maxlength="80" bind:value={name} onkeydown={onRenameKey} aria-describedby="rename-note-{one.id}" />
            <div class="row">
              <Button size="small" variant="primary" aria-busy={saving ? 'true' : undefined} aria-disabled={saving ? 'true' : undefined} onclick={saveName}>Save</Button>
              <Button size="small" variant="ghost" onclick={stopRename}>Cancel</Button>
            </div>
            <p class="quiet" id="rename-note-{one.id}" role="status">{renameNote}</p>
          </div>
        {:else}
          {@render link(one)}
          <div class="thread-menu">
            <button
              type="button"
              class="dots-button"
              id="menu-button-{one.id}"
              aria-label="More for {named(one)}"
              aria-haspopup="menu"
              aria-expanded={menuFor === one.id ? 'true' : 'false'}
              aria-controls={menuFor === one.id ? `menu-${one.id}` : undefined}
              onclick={() => (menuFor === one.id ? closeMenu(false) : openMenu(one.id))}
              onkeydown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  openMenu(one.id);
                }
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle></svg>
            </button>
            {#if menuFor === one.id}
              <div
                class="menu"
                id="menu-{one.id}"
                role="menu"
                tabindex="-1"
                aria-labelledby="menu-button-{one.id}"
                onkeydown={(event) => {
                  if (event.key === 'Escape' || event.key === 'Tab') {
                    if (event.key === 'Escape') event.preventDefault();
                    closeMenu(event.key === 'Escape');
                  }
                }}
              >
                <button type="button" role="menuitem" data-rename onclick={() => startRename(one)}>Rename</button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
    <!-- The Ask row: it opens a new read-only session about this card. -->
    <a class="thread" class:current={askOpen} aria-current={askOpen ? 'page' : undefined} href={askHref}>Ask<span class="t2">A read-only session about this card</span></a>
  </nav>

  {#if thread !== null}
    <div class="open">
      <div class="head">
        <h2>{named(thread)}</h2>
        {#if command !== null}<span class="chip">{command}</span>{/if}
        {#if thread.kind === 'feedback'}
          <span class="sub">A read-only session about this pull request comment. It reads the code and changes nothing, and its answers never change the comment's row.</span>
        {:else if isAsk}
          <span class="sub">A read-only session about this card. It reads the code and changes nothing.</span>
        {:else if canSend}
          {@const answered = messages.find((one) => one.forNext !== undefined)?.forNext}
          <span class="sub"
            >A message written here continues the {phase} session.{answered === undefined ? '' : ` An answer marked For ${answered} goes to no agent here: ${answered} reads it when the card moves.`}</span
          >
        {/if}
      </div>

      {#if messages.length === 0}
        <p class="quiet empty">
          Nothing said yet.
          {#if isAsk}Ask below about this card. The agent reads its code and the card folder, answers here, and changes
            nothing.{:else if canSend}Write below to continue this phase's session.{/if}
        </p>
      {:else}
        <ol class="messages">
          {#each messages as message (message.id)}
            {#if message.divider !== undefined}<li class="runline">{dividerLine(message.divider)}</li>{/if}
            <li class="message">
              <span class="avatar" class:agent={message.author === 'agent'} aria-hidden="true">
                <!-- The person's is a head and shoulders. The name line says "You" to a screen reader. -->
                {#if message.author === 'agent'}<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"></path></svg>{:else}<svg
                    class="person"
                    viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.75"></circle><path d="M4.75 20a7.25 7.25 0 0 1 14.5 0"></path></svg
                  >{/if}
              </span>
              <div class="body">
                <p class="who">
                  <b>{message.author === 'agent' ? agentName : 'You'}</b>
                  {#if message.forNext !== undefined}<span class="for" title="An answer from Before you approve. {message.forNext} reads it when the card moves.">For {message.forNext}</span>{/if}
                  <span class="mono">{#if message.run?.model}{`${message.run.model} · `}{/if}<time datetime={message.at}>{said(message)}</time></span>
                </p>
                {#if message.tools === null}
                  <p class="quiet">The log of this run is gone, so its tool calls cannot be shown.</p>
                {:else if message.tools !== undefined && message.tools.length > CALLS_SHOWN}
                  <details class="calls">
                    <summary>{message.tools.length} tool calls</summary>
                    {#each message.tools as call, at (at)}
                      {@render tool(call)}
                    {/each}
                  </details>
                {:else if message.tools !== undefined}
                  {#each message.tools as call, at (at)}
                    {@render tool(call)}
                  {/each}
                {:else if toolsWaiting && message.author === 'agent'}
                  <Skeleton shape="line" width="220px" label="Reading the tool calls from the run log." />
                {/if}
                <Markdown source={message.body} headingsFrom={4} />
                {#if message.run !== undefined && figures(message.run) !== ''}<p class="figures">{figures(message.run)}</p>{/if}
              </div>
            </li>
          {/each}
          {#if asking}
            <!-- The answer is on its way, read off the run row, so a reload still shows it. -->
            <li class="message answering" data-answering>
              <span class="avatar agent" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"></path></svg></span>
              <p class="who" role="status"><b>{agentName}</b> <span class="quiet">is answering</span>{@render dots()}</p>
            </li>
          {/if}
        </ol>
      {/if}

      <div class="composer">
        <label class="sr" for="message">{isAsk ? 'Question about this card' : `Message to the ${phase} session`}</label>
        <!-- Not disabled. A disabled field cannot be reached by keyboard or read by a screen
             reader, so the reason below would never be heard. The button is what holds. -->
        <textarea
          id="message"
          rows="3"
          bind:value={draft}
          {onkeydown}
          oninput={() => (status = '')}
          placeholder={isAsk ? 'Ask about this card or its code' : `Ask the ${phase} agent, or tell it what to change`}
          aria-describedby="send-note"
          readonly={!canSend}
        ></textarea>
        <div class="row">
          {#if engine !== null}<span class="fixed">{engine}</span>{/if}
          {#if canSend}
            <!-- A chip that opens the list. A native disclosure, so the keyboard opens it. -->
            <details class="pick" id="message-model" bind:open={picking}>
              <summary aria-label="Model for this message only: {picked}">{picked}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg></summary>
              <div class="choices">
                <button type="button" data-model="" aria-pressed={model === '' ? 'true' : 'false'} onclick={() => choose('')}>{phaseModel === null ? rowModel : `${phaseModel} (${rowModel})`}</button>
                {#each models as one (one)}
                  <button type="button" data-model={one} aria-pressed={model === one ? 'true' : 'false'} onclick={() => choose(one)}>{one}</button>
                {/each}
              </div>
            </details>
          {:else}
            <span class="fixed">{picked}</span>
          {/if}
          {#if phaseEffort !== null}<span class="fixed">{phaseEffort}</span>{/if}
          <span class="sub">model for this message only</span>
          <span class="spacer"></span>
          {#if goes && estimate !== undefined}<span class="figure" id="send-estimate">{estimateText(estimate)}</span>{/if}
          <!-- Go when the message starts or resumes a run. A phase with no session to resume starts
               nothing, so there it is primary. -->
          <Button
            variant={goes ? 'go' : 'primary'}
            glyph="resume"
            size="small"
            key={goes ? '⌘↵' : null}
            data-send-message
            aria-disabled={held ? 'true' : undefined}
            aria-busy={busy ? 'true' : undefined}
            aria-describedby={goes && estimate !== undefined ? 'send-estimate send-from' : undefined}
            onclick={send}
          >
            Send{#if busy}{@render dots()}{/if}
          </Button>
        </div>
        <p class="quiet" role="status">{status}</p>
        {#if goes && estimate !== undefined}
          <p class="quiet" id="send-from">{isAsk ? 'What a new Ask session takes' : `What a ${thread.label} run takes`}, {estimateFrom(estimate)}.</p>
        {/if}
        {#if asking}
          <p class="quiet" id="send-note">{isAsk ? 'The agent is reading the code.' : `The ${phase} run is going.`} Its answer shows here when the run ends.</p>
        {:else if isAsk && thread.sessionId === null}
          <p class="quiet" id="send-note">
            Starts a read-only session{#if engine !== null}&nbsp;on {engine}{/if}. It reads the card's code and the card folder, and changes nothing.
          </p>
        {:else if thread.sessionId === null}
          <p class="quiet" id="send-note">
            {thread.label} has no session to continue. Move the card forward to start one.
          </p>
        {:else}
          <div class="row">
            <p class="quiet" id="send-note">
              <!-- A named login is said, because the session lives in it and nowhere else. -->
              Resumes {isAsk ? 'the read-only' : phase} session <span class="mono">{thread.sessionId.slice(0, 8)}</span>{#if thread.engine?.includes('#')}&nbsp;on the
                <span class="mono">{thread.engine}</span> login{/if}.
            </p>
            {#if resume !== null}
              <Button variant="ghost" size="small" data-copy-resume onclick={() => copy(resume)}>Copy resume command</Button>
              <p class="quiet" role="status">{copied}</p>
            {/if}
          </div>
          {#if resume !== null && refused}<code class="command">{resume}</code>{/if}
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  /* The threads in a column beside the open one, the composer under it, with no frame around
     them, only the divider between. The messages, the tool rows and the composer have no px cap: a tab fills the width (`width.test.ts`), and the message
     text keeps its measure through `Markdown`. */
  .discussion {
    display: grid;
    grid-template-columns: minmax(0, 248px) minmax(0, 1fr);
    align-items: stretch;
  }

  /* Stays in sight while the conversation scrolls, no taller than the window, and scrolls on its own
     when the threads do not fit. It sticks under the card page's sticky head, which sets
     --thead-height. The divider is on the open thread, which runs the whole height while this column
     does not. */
  .threads {
    position: sticky;
    top: var(--thead-height, 0px);
    display: flex;
    flex-direction: column;
    align-self: start;
    gap: 2px;
    box-sizing: border-box;
    max-height: calc(100dvh - var(--thead-height, 0px));
    overflow-y: auto;
    padding: 18px var(--space-3);
  }

  .part {
    margin: 0;
    padding: 0 10px 6px;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  /* The label is the link's first text, then its count, then the session line under both. */
  .thread {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 2px var(--space-2);
    padding: var(--space-2) 10px;
    border-radius: var(--radius-md);
    color: var(--ink);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  .thread .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* An ask discussion's row with its three dot menu at the right, over the row's padding. */
  .asked {
    position: relative;
  }

  .asked .thread {
    padding-right: 42px;
  }

  .thread-menu {
    position: absolute;
    top: 6px;
    right: 4px;
  }

  .dots-button {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }

  .dots-button:hover,
  .dots-button[aria-expanded='true'] {
    background: var(--card);
    color: var(--ink);
  }

  .dots-button svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
  }

  .menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 3;
    display: flex;
    flex-direction: column;
    min-width: 120px;
    padding: 4px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
  }

  .menu button {
    padding: 5px var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }

  .menu button:hover,
  .menu button:focus-visible {
    background: var(--card-2);
    color: var(--ink);
  }

  .rename {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-2) 10px;
  }

  .rename input {
    box-sizing: border-box;
    width: 100%;
    padding: 5px var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
  }

  .thread .n {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .t2 {
    grid-column: 1 / -1;
    color: var(--muted);
    font-size: var(--text-2xs);
  }

  .t2 .mono {
    font-size: var(--mono-2xs);
  }

  .thread.off {
    color: var(--muted);
  }

  /* The open thread is a soft filled row with a weight, and aria-current names it, so it is not
     colour alone. The focus ring stays the global one. */
  .thread.current {
    background: var(--card-2);
    font-weight: 500;
  }

  .open {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-left: 1px solid var(--line);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 18px var(--space-6) 4px;
  }

  h2 {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-md);
    font-weight: 600;
  }

  .chip {
    padding: 2px var(--space-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .sub {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .empty {
    padding: var(--space-4) var(--space-6);
  }

  .messages {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    margin: 0;
    padding: var(--space-4) var(--space-6) var(--space-6);
    list-style: none;
  }

  .message {
    display: flex;
    gap: var(--space-3);
  }

  /* A run's figures between two hairlines, above its first message. */
  .runline {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .runline::before,
  .runline::after {
    flex: 1;
    height: 1px;
    background: var(--line);
    content: '';
  }

  .avatar {
    display: grid;
    flex: none;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--card-2);
    color: var(--ink);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .avatar.agent {
    background: var(--panel);
    box-shadow: inset 0 0 0 1px var(--line-2);
    color: var(--muted);
  }

  .avatar svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linejoin: round;
  }

  .avatar svg.person {
    width: 16px;
    height: 16px;
    stroke-linecap: round;
  }

  .answering {
    align-items: center;
  }

  .answering .who {
    align-items: center;
  }

  .dots {
    display: inline-flex;
    gap: 3px;
    margin-left: 2px;
  }

  .dots i {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1.2s ease-in-out infinite;
  }

  .dots i:nth-child(2) {
    animation-delay: 0.2s;
  }

  .dots i:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes pulse {
    50% {
      opacity: 0.25;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dots i {
      animation: none;
    }
  }

  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    color: var(--ink-2);
    font-size: var(--text-base);
    line-height: 1.6;
  }

  .who {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    color: var(--ink);
    font-size: 12.5px;
    line-height: 1.4;
  }

  .who b {
    font-weight: 600;
  }

  .for {
    padding: 0 6px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    color: var(--ink-2);
    font-size: var(--text-2xs);
  }

  .who .mono {
    color: var(--muted);
    font-size: var(--mono-2xs);
  }

  .tool {
    border: 1px solid var(--line);
    border-radius: 7px;
    background: var(--panel);
  }

  .tool summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 30px;
    padding: 0 10px;
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    list-style: none;
    cursor: pointer;
  }

  .tool summary::-webkit-details-marker {
    display: none;
  }

  .tool summary svg {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    transition: transform 0.12s;
  }

  .tool[open] summary svg {
    transform: rotate(90deg);
  }

  .tool b {
    color: var(--ink);
    font-weight: 500;
  }

  .subject {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size {
    margin-left: auto;
    color: var(--muted);
    font-size: var(--mono-2xs);
    white-space: nowrap;
  }

  .call {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-1) 10px 10px;
    border-top: 1px solid var(--line);
  }

  .call .part {
    padding: var(--space-1) 0 0;
    font-size: var(--text-2xs);
  }

  .call pre {
    max-height: 240px;
    margin: 0;
    overflow: auto;
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .result {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  .calls {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .calls > summary {
    color: var(--muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .calls[open] > summary {
    margin-bottom: 6px;
  }

  .calls .tool + .tool {
    margin-top: 6px;
  }

  .figures {
    margin: 0;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: auto;
    padding: 14px var(--space-6) 18px;
    border-top: 1px solid var(--line);
    background: var(--panel);
  }

  textarea {
    box-sizing: border-box;
    width: 100%;
    padding: 10px var(--space-3);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-lg);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-base);
    line-height: 1.5;
    resize: none;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .fixed {
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .pick {
    position: relative;
  }

  .pick summary {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    padding: 0 9px;
    border: 1px solid var(--line-2);
    border-radius: 7px;
    background: var(--card);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    list-style: none;
    cursor: pointer;
  }

  .pick summary::-webkit-details-marker {
    display: none;
  }

  .pick summary svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
  }

  /* Opens upward, because the composer sits at the foot of the tab. */
  .choices {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    min-width: 100%;
    padding: 4px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
  }

  .choices button {
    padding: 5px var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .choices button:hover,
  .choices button[aria-pressed='true'] {
    background: var(--card-2);
    color: var(--ink);
  }

  .spacer {
    flex: 1;
  }

  .figure {
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .quiet {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .command {
    display: block;
    padding: var(--space-2) 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    overflow-wrap: anywhere;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* One column on a narrow window: the threads above the open one. */
  @media (max-width: 720px) {
    .discussion {
      grid-template-columns: minmax(0, 1fr);
    }

    /* Above the open thread, so it does not stick over it. A long list still scrolls on its own and
       leaves the conversation in sight. */
    .threads {
      position: static;
      max-height: 40dvh;
      border-bottom: 1px solid var(--line);
    }

    .open {
      border-left: none;
    }

    .head,
    .empty,
    .messages,
    .composer {
      padding-right: var(--space-4);
      padding-left: var(--space-4);
    }
  }
</style>
