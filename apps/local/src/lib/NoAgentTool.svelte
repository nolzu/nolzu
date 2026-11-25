<script lang="ts">
  import { resolve } from '$app/paths';
  import { Button, type EveryPhaseHere, missingEngine } from '@nolzu/ui';
  import type { EngineInstall } from '@nolzu/runner';
  import { copyText } from './clipboard.ts';
  import { waitFor } from './gh-wait.ts';

  // `here` is the server's answer from the wall state: which engines run every phase on this machine.
  // Without it, Claude Code and Codex, which do with or without the wall. `found` is the server's own
  // first look on the PATH.
  let {
    tools,
    onfound,
    here = { engines: ['claude-code', 'codex'], wallProblem: null },
    found: firstLook = [],
  }: { tools: readonly EngineInstall[]; onfound: () => void; here?: EveryPhaseHere; found?: readonly string[] } = $props();

  // The three tools, in this order and with these names.
  const SHOWN = [
    ['claude-code', 'Claude Code'],
    ['codex', 'Codex CLI'],
    ['cursor', 'Cursor CLI'],
  ] as const;
  const rows = $derived(
    SHOWN.flatMap(([engine, name]) => {
      const tool = tools.find((one) => one.engine === engine);
      return tool === undefined ? [] : [{ ...tool, name }];
    }),
  );

  // The page load was the first look. Each look is a file check on `/api/tools`, and the look and the
  // clock stop when the page closes or moves on.
  let lastLook = $state(Date.now());
  let now = $state(Date.now());
  // The first look only: the polls below replace it.
  // svelte-ignore state_referenced_locally
  let found = $state<readonly string[]>(firstLook);
  // Shown only where it says more than the heading: an engine found that cannot run every phase here,
  // or a wall that cannot start, which narrows the engines that do.
  const why = $derived(found.length > 0 || here.wallProblem !== null ? missingEngine(found, here) : null);
  $effect(() => {
    const stop = waitFor(
      async () => (await (await fetch(resolve('/api/tools'))).json()) as string[],
      (seen) => {
        lastLook = Date.now();
        found = seen;
        if (missingEngine(seen, here) === null) onfound();
      },
      (seen) => missingEngine(seen, here) === null,
    );
    const clock = setInterval(() => (now = Date.now()), 1000);
    return () => {
      stop();
      clearInterval(clock);
    };
  });
  const ago = $derived(Math.max(0, Math.round((now - lastLook) / 1000)));

  let copied = $state<string | null>(null);
  const copy = async (command: string): Promise<void> => {
    copied = (await copyText(command)) ? 'Copied.' : 'The browser did not copy it. Select the command and copy it by hand.';
  };
</script>

<section class="ask" aria-labelledby="no-tool">
  <div class="hd">
    <h1 id="no-tool">Nolzu needs one agent tool to run cards</h1>
    <p class="sub">Install one and log in with your own account. This page moves on by itself.</p>
  </div>
  {#if why !== null}<p class="why">{why}</p>{/if}
  <div class="bd">
    <div class="panel">
      {#each rows as row (row.engine)}
        <div class="inst">
          <b>{row.name}</b>
          <!-- Only where the wall cannot start: there Cursor runs Implement only, and the chip tells the rows apart. -->
          {#if here.wallProblem !== null && here.engines.includes(row.engine)}<span class="chip">runs every phase here</span>{/if}
          {#if row.command !== null}
            {@const command = row.command}
            <code>{command}</code>
            <Button size="small" variant="ghost" aria-label="Copy the {row.name} install command" onclick={() => copy(command)}
              ><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"></path></svg></Button
            >
          {:else}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the tool maker's page, not a route of this app -->
            <a class="link" href={row.install} target="_blank" rel="noopener noreferrer" aria-label="{row.name} install page">Install page</a>
          {/if}
        </div>
      {/each}
    </div>
    {#if copied !== null}<p class="sub" role="status">{copied}</p>{/if}
    <p class="watch">
      <span class="pill"><span class="d" aria-hidden="true"></span>Watching</span>
      <span>Looking on your PATH every 2 seconds. Last look <span class="mono">{ago}s</span> ago.</span>
    </p>
  </div>
</section>

<style>
  /* The box, in the main column of the first run page. Nothing here is amber: no agent starts from it. */
  .ask {
    overflow: hidden;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-2xl);
    background: var(--card);
    box-shadow: var(--shadow);
  }

  .hd {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 18px var(--space-5) 6px;
  }

  h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .sub {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  /* A neutral box: it names a problem, and nothing here starts an agent. */
  .why {
    margin: 6px var(--space-5) 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  .bd {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 6px var(--space-5) var(--space-4);
  }

  .panel {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .inst {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 9px var(--space-3);
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .inst:first-child {
    border-top: 0;
  }

  .inst b {
    font-weight: 500;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    height: 19px;
    padding: 0 7px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--panel);
    color: var(--ink-2);
    font-size: var(--text-2xs);
  }

  code,
  .link {
    margin-left: auto;
  }

  code {
    padding: 0 4px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--card-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .inst svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
  }

  .link {
    color: var(--blue);
    font-size: var(--text-xs);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .watch {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  /* Blue on its own tint: information, a state and no action. The word says it too. */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 20px;
    padding: 0 var(--space-2);
    border-radius: 99px;
    background: var(--blue-bg);
    color: var(--blue);
    font-weight: 500;
  }

  .d {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }

  .mono {
    font-family: var(--font-mono);
  }
</style>
