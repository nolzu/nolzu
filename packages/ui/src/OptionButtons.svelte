<script lang="ts">
  // The answers the agent offered with its question. A press fills the answer with the option's label
  // and sends nothing: Send stays the one button that resumes the run. An option shows pressed while
  // the answer is its label, alone or ahead of a blank line and the text the person kept, so an
  // edited label presses none.
  let {
    options,
    answer,
    onpick,
    compact = false,
  }: {
    options: readonly { label: string; means?: string | null }[];
    answer: string;
    onpick: (label: string) => void;
    // Pills with the label only, for a list such as Now. The full size adds what each option means.
    compact?: boolean;
  } = $props();
</script>

{#if options.length > 0}
  <div class="opts" class:compact role="group" aria-label="Answers the agent offered">
    <!-- By place, because an agent may offer two options with the same label. -->
    {#each options as option, at (at)}
      {@const pressed = answer.trim() === option.label || answer.trim().startsWith(`${option.label}\n\n`)}
      <button type="button" class="opt" aria-pressed={pressed ? 'true' : 'false'} onclick={() => onpick(option.label)}>
        <span class="label">
          {#if pressed}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>{/if}{option.label}
        </span>
        {#if option.means && !compact}<span class="means">{option.means}</span>{/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .opts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }

  /* Violet is the colour of a question from the agent. No amber: a press fills the answer and
     starts nothing. The page's accent focus ring is left on. */
  .opt {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    box-sizing: border-box;
    padding: var(--space-3) 14px;
    border: 1px solid color-mix(in oklch, var(--violet) 50%, transparent);
    border-radius: var(--radius-lg);
    background: var(--card);
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-base);
    font-weight: 600;
  }

  .means {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  /* Pressed: an ink edge and a check, so it is not colour alone. */
  .opt[aria-pressed='true'] {
    border-color: var(--ink);
    box-shadow: inset 0 0 0 1px var(--ink);
  }

  svg {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .compact {
    display: flex;
    flex-wrap: wrap;
  }

  .compact .opt {
    justify-content: center;
    height: 28px;
    padding: 0 var(--space-3);
    border-radius: 999px;
    background: transparent;
  }

  .compact .label {
    font-size: var(--text-xs);
    font-weight: 400;
  }
</style>
