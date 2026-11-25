<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Team · Nolzu</title></svelte:head>

<div class="page">
  <h1>Team</h1>
  <p>Your team's screens are on the web app, because they read the data the team shares on Nolzu Cloud and not the data on this machine.</p>
  <!-- The web app answers 403 to a plain member on Members, so every member starts from the projects. -->
  <p>
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an address on the web app, not a route of this one -->
    <a href="{data.webTeam}/projects">Team projects</a>, for every member: the cards waiting on you and the team's boards. A row at the top of each team screen links the others: claims, knowledge proposals, decision records, the team cost report, the audit log and members.
  </p>
  <p>
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an address on the web app, not a route of this one -->
    <a href="{data.webTeam}/costs">Team cost report</a>, for the team owner and admins: one month of the team's run cost, by member, project, card and model.
  </p>
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- an address on the web app, not a route of this one -->
  <p><a href={data.webTeam}>Members, roles, invites and seats</a>, for the team owner and admins. So are the decision records and the audit log.</p>
</div>

<style>
  /* Full width beside the rail. A paragraph keeps its own measure. */
  .page {
    padding: 16px 14px 60px;
  }

  h1 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  p {
    max-width: 72ch;
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
    color: var(--ink);
  }

  a {
    color: var(--blue);
  }
</style>
