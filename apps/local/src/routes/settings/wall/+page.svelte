<script lang="ts">
  import { resolve } from '$app/paths';
  import { CLOUD_OPEN, SCOUT_AND_EVIDENCE } from '@nolzu/protocol';
  import { settingsTitle } from '$lib/settings-sections.ts';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{settingsTitle('wall')}</title></svelte:head>

<!-- Its own route, because it reads no setting: the fixed rules hold for every project and every run.
     Each group is one line with its paths folded inside, then what leaves the machine by another road
     than the hub, which was on the old What leaves this machine page. -->
<section class="section" id="wall" aria-labelledby="wall-title">
  <header class="section-head">
    <h2 id="wall-title">Wall</h2>
    <p>What every run is walled from, on every engine and in every project, and what leaves this machine another way.</p>
  </header>

  <section class="box" aria-labelledby="hidden-title">
    <header>
      <h3 id="hidden-title">Always hidden</h3>
    </header>
    <p class="quiet pad">
      Nothing in a project can loosen these. To hide more for one project, or let a run read one .env file, use <a href="{resolve('/settings/project')}#walls">Walls on Settings, Project</a>.
    </p>
    <ul class="groups">
      {#each data.groups as group (group.id)}
        <li data-group={group.id}>
          <details>
            <summary>
              <span class="name">{group.name}</span>
              <span class="line">{group.line}</span>
              <span class="count">{group.paths.length === 1 ? '1 path' : `${group.paths.length} paths`}</span>
            </summary>
            <ul class="paths">
              {#each group.paths as path (path)}<li>{path}</li>{/each}
            </ul>
          </details>
        </li>
      {/each}
    </ul>
  </section>

  <section class="box" aria-labelledby="git-title">
    <header>
      <h3 id="git-title">Nolzu's own git</h3>
    </header>
    <p class="quiet pad" data-git-wall>{data.git}</p>
  </section>

  <section class="box" aria-labelledby="leaves-title">
    <header>
      <h3 id="leaves-title">What leaves this machine another way</h3>
    </header>
    <!-- Not through a hub. Each is in the product, so a bare "nothing leaves this machine" would be wider
         than the product keeps. The agent CLI last. -->
    <dl>
      <dt>Push, pull request</dt>
      <dd>Pushing a card's branch, or opening a pull request for it, sends that branch and its commits to your own git host.</dd>
      <!-- The export is a Solo feature, so it needs the paid plans as well as Evidence. -->
      {#if SCOUT_AND_EVIDENCE && CLOUD_OPEN}
        <dt>Timesheet export</dt>
        <dd>Exporting a week sends its card keys, titles, days and minutes to the time tracker you connect, and only when you press Export.</dd>
      {/if}
      {#if CLOUD_OPEN}
        <dt>Sign in</dt>
        <dd>Signing in with <code>npx nolzu@latest login</code>, and asking which plan this machine is on, reach the Nolzu server on any plan.</dd>
      {/if}
      <dt>Agent runs</dt>
      <dd>The agent CLI of each run sends its prompt and the code it reads to the company that makes the tool, under your own login.</dd>
    </dl>
  </section>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* The box of Settings, Project, so the two pages read alike. */
  .box {
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .box > header {
    display: flex;
    align-items: center;
    min-height: 44px;
    box-sizing: border-box;
    padding: 6px 14px;
    border-bottom: 1px solid var(--line);
  }

  h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink);
  }

  /* The muted token and not an opacity: faint text loses the contrast rule. */
  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .pad {
    padding: 12px 14px 4px;
  }

  a {
    color: var(--blue);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .groups > li {
    border-top: 1px solid var(--line);
  }

  .groups > li:first-child {
    border-top: 0;
  }

  summary {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr) auto;
    gap: 4px 20px;
    align-items: baseline;
    padding: 11px 14px;
    font-size: var(--text-sm);
    list-style: none;
    cursor: pointer;
  }

  /* The native marker would sit on a line of its own in a grid, so the count says it opens instead. */
  summary::-webkit-details-marker {
    display: none;
  }

  .name {
    font-weight: 500;
    color: var(--ink);
  }

  .line {
    color: var(--ink-2);
  }

  .count {
    font-size: var(--text-xs);
    color: var(--muted);
    white-space: nowrap;
  }

  /* The empty alt text keeps a screen reader from reading the arrow out; the browser already says
     whether the row is open. A browser without it keeps the first line. */
  .count::after {
    content: ' ▸';
    content: ' ▸' / '';
  }

  details[open] .count::after {
    content: ' ▾';
    content: ' ▾' / '';
  }

  .paths {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 14px 12px 234px;
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  /* No gap and no side padding on the list, so each divider runs the full width as in the box above. */
  dl {
    display: grid;
    grid-template-columns: 214px minmax(0, 1fr);
    margin: 0;
  }

  dt,
  dd {
    margin: 0;
    padding: 11px 14px;
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  dd {
    padding-left: 20px;
  }

  dt:first-of-type,
  dt:first-of-type + dd {
    border-top: 0;
  }

  dt {
    font-weight: 500;
    color: var(--ink);
  }

  dd {
    color: var(--ink-2);
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink);
  }

  /* Narrow: the name, the line and the count stack, and the paths lose their indent. */
  @media (max-width: 760px) {
    summary,
    dl {
      grid-template-columns: minmax(0, 1fr);
    }

    .paths {
      padding-left: 14px;
    }

    dd {
      padding-top: 0;
      padding-left: 14px;
      border-top: 0;
    }
  }
</style>
