<script lang="ts">
  import { column, neverSent, NO_DATA } from './data-leaves.ts';

  // What goes to a hub, one box on Settings, Cloud: the lists per hub, then the never list folded.
  // What leaves another way is on Settings, Wall. `canSync` is whether this plan includes the cloud board, false by default,
  // so a screen built without the display document lists nothing a hub it may not have would carry.
  // `team` is whether this project joined a team.
  let { canSync = false, team = false }: { canSync?: boolean; team?: boolean } = $props();

  const own = column('hub');
  const shared = column('team');
  const never = neverSent();

  // Every promise here names the hub, because other things leave the machine another way (Settings,
  // Wall lists them). A bare "nothing leaves this machine" would be wider than the product keeps.
</script>

<section class="box" id="data" aria-labelledby="data-title">
  <header><h3 id="data-title">What goes to a hub</h3></header>

  {#if canSync}
    {#each [{ id: 'to-hub', title: 'Sent to your hub', line: 'Only what changed since the last send.', groups: own }, { id: 'to-team', title: 'Sent to the team hub', line: 'Only from a team project.', groups: shared }] as hub (hub.id)}
      <div class="hub">
        <h4>{hub.title} <span class="quiet">{hub.line}</span></h4>
        {#each hub.groups as group (group.name)}
          <p class="grp">{group.name}</p>
          {#each group.rows as row (row.type)}
            <div class="it" data-sends={hub.id === 'to-hub' ? row.type : undefined} data-team={hub.id === 'to-team' ? row.type : undefined}><code>{row.type}</code><span>{row.says}</span></div>
          {/each}
        {/each}
        {#if hub.id === 'to-team' && !team}<p class="quiet pad" data-no-team="data">Nothing today. This project is not a team project.</p>{/if}
      </div>
    {/each}
    <p class="quiet pad" data-frames="data">
      {#each NO_DATA as frame, at (frame)}{at === 0 ? '' : at === NO_DATA.length - 1 ? ' and ' : ', '}<code>{frame}</code>{/each} go to each hub this machine
      is connected to, and carry no data. They say a job arrived and the link is still there.
    </p>
  {:else}
    <!-- A plan without the cloud board has no hub that reads a frame: one that signed in is closed
         before it reads a message. -->
    <p class="pad" data-free="data">No hub: nothing is sent.</p>
  {/if}

  <details>
    <summary>Never sent <span class="quiet">To any hub, on every plan.</span></summary>
    <ul>
      {#each never as thing (thing)}
        <li data-never={thing}>{thing}</li>
      {/each}
    </ul>
  </details>
</section>

<style>
  /* The box of Settings, Project and Wall, so the pages read alike. */
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

  h3,
  h4 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink);
  }

  .hub {
    padding: 12px 14px 4px;
    border-bottom: 1px solid var(--line);
  }

  .pad {
    margin: 0;
    padding: 12px 14px;
    font-size: var(--text-sm);
    color: var(--ink-2);
  }

  .hub .pad {
    padding: 8px 0;
  }

  /* The muted token and not an opacity: faint text loses the contrast rule. */
  .quiet {
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--muted);
  }

  .grp {
    margin: 0;
    padding: 10px 0 2px;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--muted);
  }

  .it {
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr);
    gap: 2px 20px;
    padding: 7px 0;
    border-top: 1px solid var(--line);
    font-size: var(--text-xs);
    line-height: 1.45;
    color: var(--ink-2);
  }

  .grp + .it {
    border-top: 0;
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink);
  }

  /* A line above, so the fold reads apart from the line over it on every plan. */
  details {
    border-top: 1px solid var(--line);
  }

  summary {
    padding: 11px 14px;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink);
    list-style: none;
    cursor: pointer;
  }

  /* One fold marker across Settings, as on Wall: the arrow after the words, not the browser's
     triangle in front. The empty alt text keeps a screen reader from reading it out. */
  summary::-webkit-details-marker {
    display: none;
  }

  summary::after {
    content: ' ▸';
    content: ' ▸' / '';
    color: var(--muted);
  }

  details[open] > summary::after {
    content: ' ▾';
    content: ' ▾' / '';
  }

  ul {
    margin: 0;
    padding: 0 14px 8px;
    list-style: none;
  }

  li {
    padding: 7px 0;
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
    color: var(--ink);
  }

  @media (max-width: 760px) {
    .it {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
