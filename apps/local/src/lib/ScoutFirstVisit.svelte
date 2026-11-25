<script lang="ts">
  import { Button } from '@nolzu/ui';
  import type { ComponentProps } from 'svelte';
  import ScoutSources from '$lib/ScoutSources.svelte';
  import type { ScoutSection } from '$lib/scout-sources.ts';

  // Scout with no source yet: three source buttons and a paste box
  // ready to use. Paste a log is picked, because it needs no login, and one paste with Check now shows
  // the first finding. GitHub and Sentry open the Add a source dialog on their kind, and More kinds on
  // the first one. Closing the dialog picks Paste a log again.
  type Pick = 'github' | 'sentry' | 'paste' | 'more';
  // `owner` is the owner of the project's GitHub remote. The load does not wait for the git call, so it
  // may come as a promise, and a project with no GitHub remote names nobody.
  let { scout, problem = null, owner = null }: { scout: ScoutSection; problem?: string | null; owner?: Promise<string | null> | string | null } = $props();

  let picked = $state<Pick | null>(null);
  // What Add a source held when it last closed without a save, so the next open shows it again.
  let draft = $state<ComponentProps<typeof ScoutSources>['draft']>(null);
  const shown = $derived(picked ?? 'paste');

  const BIGS: readonly { id: Pick; title: string; needs: string; icon: readonly string[] }[] = [
    { id: 'github', title: 'GitHub issues and failed CI', needs: 'Uses your gh login', icon: ['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18Z', 'M12 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2Z'] },
    { id: 'sentry', title: 'Sentry', needs: 'Needs a read-only token', icon: ['M12 3 2 20h20L12 3Z', 'M12 10v4M12 17h.01'] },
    { id: 'paste', title: 'Paste a log', needs: 'Needs nothing', icon: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z', 'M14 3v5h5', 'M9 13h6M9 17h4'] },
  ];
  // The kind each pick opens the dialog on.
  const FORM_OF: Readonly<Record<Pick, string>> = { github: 'tickets-github', sentry: 'sentry', paste: 'paste', more: 'tickets-gitlab' };

  // Cmd or Ctrl and Enter checks the paste, as the cap on the button says.
  function onkeydown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
</script>

<div class="wrap">
  <p class="lede">Scout reads your issues, errors and logs, and tells you early when something breaks.</p>

  <!-- An old /settings/scout link lands here at #sources while there is no source yet. -->
  <div class="bigs" role="group" aria-label="Add a source" id="sources">
    {#each BIGS as big (big.id)}
      <button class="big" type="button" aria-pressed={shown === big.id} onclick={() => (picked = big.id)}>
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{#each big.icon as d (d)}<path {d}></path>{/each}</svg>
        <b>{big.title}</b>
        <span
          >{big.needs}{#if big.id === 'github'}{#await owner then who}{#if who}{` · ${who}`}{/if}{/await}{/if}</span
        >
      </button>
    {/each}
  </div>
  <p class="more">
    GitLab, Jira, Linear or a log query? <button class="link" type="button" aria-pressed={shown === 'more'} onclick={() => (picked = 'more')}>More kinds</button>
  </p>

  <!-- A plain post: the box comes back empty when the page renders again, because the text is not
       answered back. -->
  <form method="POST" action="?/firstPaste" class="paste">
    <label for="first-paste">Paste a log</label>
    <textarea id="first-paste" name="text" required placeholder="A stack trace, an error message or a few log lines" {onkeydown}></textarea>
    <div class="go-row">
      <Button type="submit" variant="primary" key="⌘↵">Check now</Button>
      <span class="sub">Stays on this machine.</span>
    </div>
    {#if problem !== null}<p class="refused" role="alert">{problem}</p>{/if}
  </form>
</div>

{#if shown !== 'paste'}
  <ScoutSources forms={scout.forms} kind={FORM_OF[shown]} onclose={() => (picked = null)} bind:draft />
{/if}

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 28px;
    padding: 72px 32px 48px;
  }

  .lede {
    margin: 0;
    font-size: var(--text-md);
    color: var(--muted);
  }

  .bigs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .big {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    box-sizing: border-box;
    min-height: 118px;
    padding: 18px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-xl);
    background: var(--card);
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  /* Picked is a ring in the second ink, not a colour: picking a source starts nothing. */
  .big[aria-pressed='true'] {
    border-color: var(--ink-2);
    box-shadow: inset 0 0 0 1px var(--ink-2);
  }

  .big b {
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .big span {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .ico {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: var(--ink-2);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .more {
    margin: -16px 0 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--blue);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .paste {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  label {
    font-size: var(--text-sm);
    font-weight: 600;
  }

  textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 220px;
    padding: 14px var(--space-4);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-xl);
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
    line-height: 1.6;
    resize: vertical;
  }

  .go-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  .sub {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .refused {
    margin: 0;
    padding-left: 10px;
    box-shadow: inset 2px 0 0 var(--red);
    font-size: var(--text-xs);
    color: var(--ink);
  }

  @media (max-width: 760px) {
    .wrap {
      padding: var(--space-6) var(--space-4);
    }

    .bigs {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
