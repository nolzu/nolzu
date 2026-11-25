<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';

  let {
    title,
    reason = null,
    output,
    fix,
    oncopy = null,
    children,
  }: {
    // The problem in one sentence, such as "APP-1 was not pushed."
    title: string;
    // Why it happened, in plain words after the title, such as "GitHub has commits the checkout does not."
    reason?: string | null;
    // The tool's own words, unchanged, so a person can search for them or paste them into a question.
    output: string;
    // What to do about it. A box that only shows the output leaves the person stuck.
    fix: string;
    // The page owns the clipboard. It answers with the sentence to show, or null once it is copied.
    oncopy?: ((text: string) => Promise<string | null>) | null;
    // The buttons that do the fix, such as "Pull into the checkout".
    children?: Snippet;
  } = $props();

  const uid = $props.id();
  let copied = $state('');

  async function copy(): Promise<void> {
    copied = (await oncopy?.(output)) ?? 'Copied.';
  }
</script>

<!-- Only the title is the alert. The whole box as one would read every line of the output aloud. -->
<section class="errbox" aria-labelledby="{uid}-title">
  <p class="head" id="{uid}-title" role="alert">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3Z"></path><path d="M12 10v4M12 17h.01"></path></svg>
    <span><b>{title}</b> {#if reason}{reason}{/if}</span>
  </p>
  <pre>{output}</pre>
  <div class="fix">
    <p>{fix}</p>
    {#if children || oncopy}
      <div class="actions">
        {@render children?.()}
        {#if oncopy}
          <Button variant="ghost" size="small" data-copy-output onclick={copy}><svg class="copy" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"></path></svg>Copy output</Button>
          <p class="quiet" role="status">{copied}</p>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  /* The edge is red at 45%. Mixed from the token, so the box follows the theme. */
  .errbox {
    box-sizing: border-box;
    border: 1px solid color-mix(in oklch, var(--red) 45%, transparent);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding: 10px 14px;
    background: var(--red-bg);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .head b {
    font-weight: 500;
  }

  svg {
    flex: none;
    width: 16px;
    height: 16px;
    fill: none;
    stroke: var(--red);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The copy glyph takes the ghost button's ink, not the red of the warning sign. */
  svg.copy {
    width: 13px;
    height: 13px;
    stroke: currentColor;
  }

  /* A long path or URL has no space to break at, and a box wider than the screen takes the page with it. */
  pre {
    margin: 0;
    padding: var(--space-3) 14px;
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .fix {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: var(--space-3) 14px;
    border-top: 1px solid var(--line);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .fix p {
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .fix .quiet {
    color: var(--muted);
    font-size: var(--text-xs);
  }
</style>
