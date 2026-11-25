<script lang="ts">
  import { Button } from '@nolzu/ui';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // The button waits for the box. The server checks the box again, so a post without it is refused.
  let ticked = $state(false);
</script>

<svelte:head><title>Before you start · Nolzu</title></svelte:head>

<!-- No rail and no menu: nothing else on the server answers until the terms are accepted. -->
<div class="terms">
  <header class="top">
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle class="dot" cx="5" cy="10" r="3.4"></circle>
      <rect x="10.2" y="4" width="1.7" height="12" rx="0.85"></rect>
      <rect x="13.6" y="4" width="1.7" height="12" rx="0.85"></rect>
      <rect x="17" y="4" width="1.7" height="12" rx="0.85"></rect>
    </svg>
    <span class="word">Nolzu</span>
  </header>

  <div class="page">
    <h1>{data.terms.heading}</h1>
    {#if data.changed}
      <p class="changed" data-changed>{data.terms.changed}</p>
    {/if}
    <p class="lede">{data.terms.intro}</p>
    <ol>
      {#each data.terms.points as point, index (index)}
        <li>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- nolzu.com and GitHub, not routes of this app -->
          {#each point as part, at (at)}{#if 'href' in part && part.href}<a href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>{:else}{part.text}{/if}{/each}
        </li>
      {/each}
    </ol>

    <!-- A plain post: the page then loads whole, and the server hook refuses one from another site. -->
    <form method="post">
      {#if data.to}<input type="hidden" name="to" value={data.to} />{/if}
      <label class="tick">
        <input type="checkbox" name="accept" bind:checked={ticked} />
        <span>{data.terms.checkbox}</span>
      </label>
      {#if form?.message}
        <p class="refused" role="alert">{form.message}</p>
      {/if}
      <div>
        <Button type="submit" variant="primary" size="large" disabled={!ticked}>{data.terms.button}</Button>
      </div>
      <p class="after">{data.terms.after}</p>
    </form>
  </div>
</div>

<style>
  .terms {
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

  /* Cream and not amber, as on New project: accepting starts no agent run. */
  .top .dot {
    fill: var(--accent);
  }

  .word {
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: -0.015em;
  }

  .page {
    display: flex;
    flex-direction: column;
    gap: 22px;
    box-sizing: border-box;
    width: 100%;
    max-width: 1180px;
    align-self: center;
    padding: 56px 32px 48px;
  }

  h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 600;
    line-height: 1.08;
    letter-spacing: -0.035em;
  }

  .lede {
    max-width: 68ch;
    margin: 0;
    color: var(--ink-2);
    font-size: 16px;
    line-height: 1.55;
  }

  /* A neutral box, as the offline banner draws one. Amber would say an agent is about to work. */
  .changed {
    box-sizing: border-box;
    max-width: 68ch;
    margin: 0;
    padding: 10px 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-lg);
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-base);
    line-height: 1.55;
  }

  ol {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 68ch;
    margin: 0;
    padding-left: 1.4em;
    color: var(--ink);
    font-size: var(--text-base);
    line-height: 1.55;
  }

  a {
    color: var(--ink);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .tick {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--ink);
    font-size: var(--text-base);
    cursor: pointer;
  }

  .tick input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--accent);
  }

  .refused {
    margin: 0;
    color: var(--red);
    font-size: var(--text-sm);
  }

  .after {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-sm);
  }

  @media (max-width: 760px) {
    .page {
      padding: 32px 16px;
    }

    h1 {
      font-size: 30px;
    }
  }
</style>
