<script lang="ts">
  import Button from '../Button.svelte';

  // Waiting on me, in the board's top bar: the board's filter, with how many cards on this board wait
  // on a person. The page counts them off its snapshot, so the button is there once the board is.
  let { on, count, onclick }: { on: boolean; count: number; onclick: () => void } = $props();
</script>

<!-- The count first and the key as a cap after it, so the letter never reads as the number. The word
     after the count sits outside the badge with a space between the two, because Svelte drops a space
     at the start of an element and a screen reader would hear "3cards". -->
<Button class="waiting" aria-pressed={on} key="W" {onclick}>
  Waiting on me <span class="count" data-waiting-count>{count}</span> <span class="hidden">{count === 1 ? 'card' : 'cards'}</span>
</Button>

<style>
  /* Pressed is said by the attribute and by the edge, so it is not colour alone. */
  :global(.btn.waiting[aria-pressed='true']) {
    border-color: var(--green);
  }

  /* A count badge is cream: amber means an agent starts or resumes work. */
  .count {
    padding: 0 6px;
    border-radius: 99px;
    background: var(--accent);
    color: var(--accent-ink);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    font-weight: 600;
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
