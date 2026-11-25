<script lang="ts">
  // The account on the cloud and the Team page, under Settings, Cloud connection. Each shows only when
  // the signed document names its feature: the settings page asks display.ts and hands the addresses
  // in. On Free there is neither, and nothing shows.
  let { account, team }: { account: string | null; team: string | null } = $props();
</script>

{#if account !== null || team !== null}
  <ul class="links">
    {#if account !== null}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an address on the web app, not a route of this one -->
      <li><a href={account}>Account</a>, your profile and sign-in on the web app.</li>
    {/if}
    {#if team !== null}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the settings page resolve()s this address and hands it in -->
      <li><a href={team}>Team</a>, where your team's screens on the web app start.</li>
    {/if}
  </ul>
{/if}

<style>
  .links {
    margin: 0;
    padding: 0 14px 10px;
    list-style: none;
    font-size: var(--text-sm);
    color: var(--ink-2);
  }

  li + li {
    margin-top: var(--space-1);
  }

  a {
    color: var(--blue);
  }
</style>
