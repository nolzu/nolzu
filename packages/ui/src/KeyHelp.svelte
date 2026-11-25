<script lang="ts">
  import Dialog from './Dialog.svelte';
  import KeyCaps from './KeyCaps.svelte';
  import Kbd from './Kbd.svelte';
  import { type Binding, helpSections } from './keymap.ts';

  // The keyboard help. It lists the keys it is handed, which are
  // the keys the handler acts on, so it can never list one that does nothing.
  let { keys, onclose }: { keys: readonly Binding[]; onclose: () => void } = $props();

  const uid = $props.id();
  // A board's help also lists the card page tabs.
  const columns = $derived(helpSections(keys, keys.some((binding) => binding.scope === 'board')));
  const starts = $derived(keys.some((binding) => binding.starts === true));
  // The line beside the title, said only where the palette opens. A key for the selected
  // card has no row there, so the line names what does.
  const palette = $derived(keys.some((binding) => binding.action === 'palette') ? 'Screens, actions and card moves are also in the command palette, ⌘K' : null);
</script>

{#snippet bolt()}
  <svg class="bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"></path></svg>
{/snippet}

{#snippet runs()}
  <p class="runs">
    {@render bolt()}<span
      >Starts an agent run. The key first shows what starts, like a drop. <Kbd key="↵" aria-hidden="true" /><span class="hidden">Enter</span> confirms.</span
    >
  </p>
{/snippet}

<Dialog title="Keyboard" sub={palette} wide closer="Close keyboard help" {onclose} footer={starts ? runs : undefined} data-key-help>
  <div class="cols" style:--cols={columns.length}>
    {#each columns as column, c (c)}
      <div class="col">
        {#each column as section (section.group)}
          <section aria-labelledby="{uid}-{section.group}">
            <h3 id="{uid}-{section.group}">
              {section.title}{#if section.group === 'go' && section.note}<span class="quiet">{section.note}</span>{/if}
            </h3>
            <dl>
              {#each section.keys as binding (binding.action)}
                <div class="row" data-help-key={binding.action}>
                  <dt>{#if binding.starts}{@render bolt()}{/if}{binding.label}</dt>
                  <dd><KeyCaps combos={binding.keys} /></dd>
                </div>
              {/each}
            </dl>
            {#if section.group === 'tabs' && section.note}<p class="note">{section.note}</p>{/if}
          </section>
        {/each}
      </div>
    {/each}
  </div>
</Dialog>

<style>
  .cols {
    display: grid;
    grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
    gap: var(--space-6) 40px;
    padding-bottom: var(--space-1);
  }

  /* One column on a phone, as the rows would not fit three across. */
  @media (max-width: 760px) {
    .cols {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .col {
    display: flex;
    flex-direction: column;
    gap: 22px;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  h3 {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    padding-bottom: 6px;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .quiet {
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: 400;
  }

  dl {
    display: flex;
    flex-direction: column;
    margin: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 30px;
    color: var(--ink-2);
    font-size: var(--text-sm);
  }

  dt {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  dd {
    display: flex;
    align-items: center;
    margin: 0 0 0 auto;
  }

  .note {
    margin: 0;
    padding-top: 6px;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  /* Amber, because the bolt marks a key that starts an agent run. It is a mark, not a control. */
  .bolt {
    flex: none;
    width: 12px;
    height: 12px;
    fill: none;
    stroke: var(--amber);
    stroke-width: 1.7;
    stroke-linejoin: round;
  }

  /* 12.5px is off the scale, so the foot takes the nearest step. */
  .runs {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
