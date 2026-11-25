<script lang="ts">
  import { findingOfKey, isMaintenanceKey, type LaneView } from '@nolzu/protocol';
  import Chip from './Chip.svelte';

  // One chip per lane the snapshot sends, in its order. A lane runs one job at a time, so the chip says
  // whether it is free or who holds it.
  // `projects` names another project's holder, by registry id: lanes belong to the machine, and the
  // same key can be a card of this project. Left out, a holder of another project reads as one.
  let { lanes, projects = {} }: { lanes: readonly LaneView[]; projects?: Readonly<Record<number, string>> } = $props();

  const named = (lane: LaneView): string => `${lane.name.charAt(0).toUpperCase()}${lane.name.slice(1)} lane`;
  // Two holders are not cards: the knowledge upkeep run and a Scout assessment. Each gets words, and
  // a card gets its key.
  const holder = (key: string): { words: string } | { key: string } =>
    isMaintenanceKey(key) ? { words: 'a maintenance run' } : findingOfKey(key) !== null ? { words: 'an assessment' } : { key };
</script>

{#if lanes.length > 0}
  <span class="lanes">
    {#each lanes as lane (lane.name)}
      <Chip>
        <span class="dot" data-held={lane.heldBy === null ? undefined : 'true'} aria-hidden="true"></span>
        {#if lane.heldBy === null}
          {named(lane)} free
        {:else}
          {@const by = holder(lane.heldBy)}
          {named(lane)} busy with {#if 'key' in by}<span class="key">{by.key}</span>{:else}{by.words}{/if}{#if lane.project !== undefined}
            in {projects[lane.project] ?? 'another project'}{/if}
        {/if}
      </Chip>
    {/each}
  </span>
{/if}

<style>
  .lanes {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  /* The words say free or busy, so the dot is never the only sign. Green is free, amber is an agent
     at work on the lane. */
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
  }

  .dot[data-held='true'] {
    background: var(--amber);
  }

  .key {
    font-family: var(--font-mono);
  }
</style>
