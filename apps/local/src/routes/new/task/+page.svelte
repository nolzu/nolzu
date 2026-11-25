<script lang="ts">
  import { onMount } from 'svelte';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import { Button } from '@nolzu/ui';
  import { pageKeys } from '$lib/page-keys.svelte.ts';
  import { confettiPieces } from '$lib/confetti.ts';
  import SetupSteps from '$lib/SetupSteps.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const repos = $derived(data.made.repos);

  // ⌘↵ presses Make card, from the task box too, through the global `make` key. The card is made
  // once: the key presses nothing while the answer is on its way, as requestSubmit passes a disabled button.
  let makeForm = $state<HTMLFormElement | null>(null);
  let making = $state(false);
  $effect(() => pageKeys.show({ keys: [], actions: { make: () => (making ? undefined : makeForm?.requestSubmit()) } }));

  // The answers of the small forms in the banner, each read only by its own form.
  const said = (field: string): { message?: string; said?: string; typed?: string; saved?: boolean } | null => (form !== null && form !== undefined && 'field' in form && form.field === field ? form : null);
  const keyRefused = $derived(said('key')?.message ?? null);
  // In place: the box keeps what was typed, and the keys above it are read again on a save.
  const inPlace: SubmitFunction = () => async ({ update }) => update({ reset: false });

  // A burst once per project, on the first look at this screen after Make the project: thrown up
  // and out from the middle of the window, drifting and fluttering, then falling. None when the system asks for
  // less motion. Browser storage is a convenience: when it is blocked the burst can come again on a
  // reload, which harms nothing.
  const PIECES = confettiPieces();
  let party = $state(false);
  onMount(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const seen = `nolzu.ready.${data.made.path}`;
    try {
      if (localStorage.getItem(seen) !== null) return;
      localStorage.setItem(seen, '1');
    } catch {
      // Blocked storage: show it anyway.
    }
    party = true;
    const done = setTimeout(() => (party = false), 2900);
    return () => clearTimeout(done);
  });
</script>

<svelte:head><title>The first task · Nolzu</title></svelte:head>

<div class="first">
  <header class="top">
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle class="dot" cx="5" cy="10" r="3.4"></circle>
      <rect x="10.2" y="4" width="1.7" height="12" rx="0.85"></rect>
      <rect x="13.6" y="4" width="1.7" height="12" rx="0.85"></rect>
      <rect x="17" y="4" width="1.7" height="12" rx="0.85"></rect>
    </svg>
    <span class="word">Nolzu</span>
    {#if data.display.plan === 'free'}<span class="sub plan">Free · runs on this machine only{data.display.id === '' ? ' · no account' : ''}</span>{/if}
  </header>

  {#if party}
    <div class="confetti" aria-hidden="true">
      {#each PIECES as piece, at (at)}<span
          class="piece"
          style:--dx="{piece.dx}vw"
          style:--up="{piece.up}vh"
          style:--fall="{piece.fall}vh"
          style:--sway="{piece.sway}vw"
          style:--spin="{piece.spin}deg"
          style:--flip="{piece.flip}deg"
          style:--delay="{piece.delay}ms"
          ><span class="y"><i style:width="{piece.w}px" style:height="{piece.h}px" style:background="var({piece.colour})"></i></span></span
        >{/each}
    </div>
  {/if}

  <div class="page">
    <section class="ready" aria-labelledby="ready">
      <span class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"></path></svg></span>
      <div class="grow">
        <h1 id="ready">{data.made.name} is ready</h1>
        <p class="sub"><span class="mono">{data.made.path}</span> · {repos.length === 1 ? '1 repository' : `${repos.length} repositories`}</p>

        <div class="keys">
          <span>Cards get the keys <span class="mono">{data.keys.join(', ')}</span></span>
          <details open={keyRefused !== null}>
            <summary>Change<span class="sr"> the card key prefix</span></summary>
            <form class="keyform" method="POST" action="?/key" use:enhance={inPlace}>
              <label for="prefix">Card key prefix</label>
              <input id="prefix" name="value" class="input mono" value={said('key')?.typed ?? data.prefix} autocomplete="off" spellcheck="false" aria-invalid={keyRefused !== null} />
              <Button type="submit" size="small">Save</Button>
            </form>
          </details>
        </div>
        {#if keyRefused !== null}<p class="refused" role="alert">{keyRefused}</p>{:else if said('key')?.saved}<p class="sub" role="status">Saved. New cards get the keys above.</p>{/if}

        <ul class="facts">
          <li>
            Runs on {data.runsOn.label}, {data.runsOn.preset} preset.
            <a class="link" href={resolve('/settings/[section]', { section: 'models' })}>Change in Settings, Models</a>
          </li>
          <li class="files">
            <span>Nolzu wrote its files for the agents (rules and the run guard) into the workspace folder, outside your repositories.</span>
            <form method="POST" action="?/reveal" use:enhance={inPlace}><Button type="submit" size="small">Open the folder</Button></form>
            {#if said('reveal')?.message}<span class="refused" role="alert">{said('reveal')?.message}</span>{:else if said('reveal')?.said}<span role="status">{said('reveal')?.said}</span>{/if}
          </li>
        </ul>
      </div>
    </section>

    <form
      class="choices"
      method="POST"
      action="?/card"
      bind:this={makeForm}
      use:enhance={() => {
        making = true;
        return async ({ update }) => {
          await update();
          making = false;
        };
      }}
    >
      <section class="choice" aria-labelledby="give">
        <h2 id="give">Give it a task</h2>
        <p class="sub">One small change. Making the card runs nothing. On the board you drag it to start the agent.</p>
        <label class="sr" for="task">First task</label>
        <textarea id="task" name="task" class="input ta" rows="3" value={form !== null && form !== undefined && 'task' in form ? form.task : ''}></textarea>
        <div class="go">
          <Button type="submit" variant="primary" size="large" key="⌘↵" aria-keyshortcuts="Meta+Enter Control+Enter" disabled={making} aria-busy={making}
            >Make card <span class="mono">{data.key}</span></Button
          >
        </div>
        <div class="bigger">
          <Button type="submit" name="board" value="epics" disabled={making}>Plan a bigger feature (Epic board)</Button>
          <p class="sub">The text above goes on the Epic board as an idea. Agents plan it and split it into tasks.</p>
        </div>
      </section>

      <!-- A kind of card, not a suggestion: it makes the read-only question card on Research. -->
      <section class="choice" aria-labelledby="ask">
        <h2 id="ask">Ask about the project</h2>
        <p class="sub">An agent reads the code and answers "What does this project do?". It changes no file.</p>
        <div class="go">
          <Button type="submit" size="large" name="board" value="questions" disabled={making}>Ask what it does</Button>
        </div>
      </section>

      {#if form !== null && form !== undefined && !('field' in form) && form.message}
        <p class="refused" role="alert">
          {form.message}
        </p>
      {/if}
    </form>

    <!-- Set up the project: every step, where the old "Also learn this project" tick was. -->
    <SetupSteps steps={data.setup} variant="list" />

    <form class="skip" method="POST" action="?/skip"><button type="submit" class="link">Skip, go to the board</button></form>
  </div>
</div>

<style>
  /* The frame of New project: no rail, a header, then one page of at most 1180px. */
  .first {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    background: var(--bg);
  }

  .top {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 18px 32px;
    border-bottom: 1px solid var(--line);
  }

  .top svg {
    flex: none;
    width: 20px;
    height: 20px;
    fill: currentColor;
  }

  /* Cream and not amber: amber means an agent starts or resumes work, and a logo starts none. */
  .top .dot {
    fill: var(--accent);
  }

  .word {
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: -0.015em;
  }

  .top .plan {
    margin-left: auto;
  }

  .page {
    display: flex;
    flex-direction: column;
    align-self: center;
    gap: 28px;
    box-sizing: border-box;
    width: 100%;
    max-width: 1180px;
    padding: 48px 32px;
  }

  .ready {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 20px 22px;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .grow {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 600;
    line-height: 1.08;
    letter-spacing: -0.035em;
    overflow-wrap: anywhere;
  }

  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .sub {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .keys {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2) var(--space-3);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .keys .mono {
    font-size: var(--mono-xs);
  }

  summary {
    color: var(--ink);
    font-size: var(--text-xs);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .keyform {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .keyform label {
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  .keyform .input {
    width: 12ch;
    padding: 5px 8px;
  }

  .facts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 4px 0 0;
    padding: 10px 0 0;
    border-top: 1px solid var(--line);
    list-style: none;
    color: var(--ink-2);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .files {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }

  .check {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    margin-top: 2px;
    border-radius: 50%;
    background: var(--green-bg);
    color: var(--green);
  }

  .check svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Two equal choices, side by side when there is room for both. Each box is as tall as what it holds,
     so the short Ask box does not stand as a tall empty one. */
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
    align-items: start;
    gap: var(--space-4);
  }

  .choice {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    padding: 20px 22px;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
  }

  .bigger {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }

  .choices .refused {
    grid-column: 1 / -1;
  }

  .refused {
    margin: 0;
    color: var(--red);
    font-size: var(--text-sm);
  }

  .input {
    box-sizing: border-box;
    width: 100%;
    padding: 12px 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
  }

  /* No amber ring: the box makes a card, and amber is only where an agent starts work. */
  .ta {
    min-height: 112px;
    font-size: 18px;
    line-height: 1.45;
    resize: vertical;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .skip {
    font-size: var(--text-sm);
  }

  /* A burst over the page, gone after one run of about 2.5 s. Three layers, so each moves one way: the
     piece drifts sideways and slows, its inner box rises fast, stops and falls faster and faster, and
     the strip itself turns and flips, which is the flutter. The global rule for reduced motion stops it
     too, and the script does not draw it then. */
  .confetti {
    position: fixed;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    perspective: 600px;
  }

  .piece {
    position: absolute;
    left: 50%;
    top: 50%;
    animation: drift 2.5s cubic-bezier(0.2, 0.7, 0.4, 1) var(--delay) both;
  }

  .y {
    display: block;
    animation: throw 2.5s var(--delay) both;
  }

  .piece i {
    display: block;
    translate: -50% -50%;
    border-radius: 1px;
    animation: tumble 2.5s linear var(--delay) both;
  }

  @keyframes drift {
    60% {
      transform: translateX(var(--dx));
    }

    to {
      transform: translateX(calc(var(--dx) + var(--sway)));
    }
  }

  /* Up quickly and slowing to the top, then down faster and faster, as under gravity. */
  @keyframes throw {
    0% {
      transform: translateY(0);
      animation-timing-function: cubic-bezier(0.25, 0.75, 0.45, 1);
    }

    28% {
      transform: translateY(calc(var(--up) * -1));
      animation-timing-function: cubic-bezier(0.5, 0, 0.85, 0.6);
    }

    85% {
      opacity: 1;
    }

    100% {
      opacity: 0;
      transform: translateY(var(--fall));
    }
  }

  @keyframes tumble {
    to {
      transform: rotate(var(--spin)) rotateX(var(--flip));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .confetti {
      display: none;
    }
  }

  @media (max-width: 760px) {
    .top {
      padding: 14px 16px;
    }

    .page {
      gap: 20px;
      padding: 24px 16px;
    }

    .ready,
    .choice {
      padding: 16px;
    }

    h1 {
      font-size: 30px;
    }
  }
</style>
