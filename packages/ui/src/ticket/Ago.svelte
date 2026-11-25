<script lang="ts" module>
  // One formatter for every time on the page, not one for each.
  const FULL = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short' });
</script>

<script lang="ts">
  import { ago } from '../board/peek.ts';

  // A time on the trail and the Overview: "5 minutes ago", with the full date and time on hover. `now`
  // is the page's clock, so the words move on with it. A stamp that is no time draws nothing rather
  // than a wrong one.
  let { at, now }: { at: string; now: Date } = $props();
  const said = $derived(ago(at, now, true));
  const full = $derived(Number.isNaN(Date.parse(at)) ? '' : FULL.format(new Date(at)));
</script>

{#if said !== null}<time datetime={at} title={full}>{said}</time>{/if}
