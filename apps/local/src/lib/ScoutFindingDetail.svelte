<script lang="ts">
  import { Button, StatePill } from '@nolzu/ui';
  import type { ScoutFindingDetail } from '$lib/scout-detail.ts';

  // The right pane of the Scout inbox: the selected finding. The whole
  // view is worked out by scoutFindingDetail, so this file only draws.
  //
  // The two messages and the assessment are drawn as text. Never through {@html} and never into an
  // attribute: a collected line is text from a machine nobody vetted and can hold a real token, and an
  // assessment is a file a run wrote.
  //
  // `self` is the address of this finding's own page. Every button posts there, so after the post the
  // page shows this finding and its answer, even when the list has moved under it. Empty posts to the
  // page on show. The card address comes in too, because resolve() only works in the app.
  let {
    detail,
    cardHref,
    self = '',
    said = '',
    problem = null,
  }: { detail: ScoutFindingDetail; cardHref: (key: string) => string; self?: string; said?: string; problem?: string | null } = $props();

  const row = $derived(detail.row);
  // The five parts, each under the heading the skill wrote it with, so the page names them the way the
  // file does.
  const parts = $derived(
    detail.assessment === null
      ? []
      : [
          { heading: 'The evidence', text: detail.assessment.evidence },
          { heading: 'The likely cause', text: detail.assessment.cause },
          { heading: 'The proposal', text: detail.assessment.proposal },
          { heading: 'The effort', text: detail.assessment.effort },
          { heading: 'The risks', text: detail.assessment.risks },
        ],
  );
  const lines = $derived(row.lastMessage.split('\n').length);
</script>

<article class="fd" aria-labelledby="fd-t">
  <header class="fd-h">
    <div class="fd-r">
      <StatePill state={row.pill.state} word={row.pill.word} detail={row.pill.detail} />
      {#if row.source !== ''}<span>{row.source}</span>{/if}
    </div>
    <h2 class="fd-t" id="fd-t">{row.title}</h2>
  </header>

  <section class="sec" aria-labelledby="ev-t">
    <h3 id="ev-t">What Scout saw <span class="n">{lines === 1 ? '1 line' : `${lines} lines`}</span></h3>
    <!-- An event seen once has one line and one time, so the second block would print the same line
         again under a heading saying the two differ. -->
    {#if row.firstMessage !== row.lastMessage || row.first !== row.last}
      <p class="quiet">Scout reads past the numbers and the ids in a line, so the two lines below are one finding.</p>
      <p class="label">First line seen, {row.first}</p>
      <pre>{row.firstMessage}</pre>
      <p class="label">Newest line seen, {row.last}</p>
      <pre>{row.lastMessage}</pre>
    {:else}
      <p class="label">The line seen, {row.last}</p>
      <pre>{row.lastMessage}</pre>
    {/if}
    <p class="quiet">{row.seen}{row.source === '' ? '' : ` Found by ${row.source}.`}</p>
    {#if row.location !== ''}
      <p class="quiet">Where it happens: <code>{row.location}</code></p>
    {/if}
    <p class="quiet">Its id across checks is <code>{row.fingerprint}</code>.</p>
  </section>

  <section class="sec" aria-labelledby="as-t">
    <h3 id="as-t">Assessment {#if detail.run !== null}<span class="n">{detail.run}</span>{/if}</h3>
    {#if detail.note !== null}
      <!-- A file that cannot be read is marked with a bar and not with red alone. A finding nobody
           assessed is no refusal, so it is drawn as the quiet line it is. -->
      {#if detail.note.refused}
        <p class="refused" role="alert">{detail.note.text}</p>
      {:else}
        <p class="quiet">{detail.note.text}</p>
      {/if}
    {/if}
    <!-- The note and the parts together, not one or the other: while a second run is going the parts
         are the round before it, and the line above says so. -->
    {#if parts.length > 0}
      <dl class="as">
        {#each parts as part (part.heading)}
          <dt>{part.heading}</dt>
          <dd>{part.text}</dd>
        {/each}
      </dl>
    {/if}
  </section>

  <!-- The anchor every button comes back to, so the answer is in view after the post reloads the page. -->
  <div class="acts-w" id="actions-title">
    <!-- The card this finding was started as, named by its key. A key with no card behind it is a card
         somebody removed by hand, and it is said rather than linked: the link would answer nothing,
         and Start is offered again below. -->
    {#if row.card !== null}
      {#if row.card.here}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the route resolve()s this address and hands it in -->
        <p class="quiet">Started as card <a href={cardHref(row.card.key)}>{row.card.key}</a> in {row.card.stage} on the {row.card.board} board.</p>
      {:else}
        <p class="quiet">The card {row.card.key} it was started as is no longer on the board.</p>
      {/if}
    {/if}
    <!-- The ticket key this finding carries cannot be a card key, so Start is not drawn. The key itself
         is not printed: it comes out of a ticket system's answer and can hold anything, the way the two
         collected lines can. -->
    {#if row.cardProblem !== null}
      <p class="quiet">No card can be made from this finding. Its ticket key cannot be a card key. {row.cardProblem}</p>
    {/if}
    <!-- Every button posts the finding id, the field all four writers read. The page is about one finding
         and its heading says which, so no button needs a name of its own. -->
    <div class="acts">
      <!-- Assess on a finding nobody has assessed yet, because the status writer only moves one out of
           New. It starts a read-only run, so it is the one amber button. -->
      {#if row.canAssess}
        <form method="POST" action="{self}?/assess#actions-title">
          <input type="hidden" name="id" value={row.id} />
          <Button type="submit" variant="go">Assess</Button>
        </form>
      {/if}
      <!-- Both starts make a card and start nothing. The Delivery card is the main step once Assess is
           behind the finding. -->
      {#if row.canStart}
        <form method="POST" action="{self}?/start#actions-title">
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="board" value="delivery" />
          <Button type="submit" variant={row.canAssess ? 'default' : 'primary'}>Start as Delivery card</Button>
        </form>
        <form method="POST" action="{self}?/start#actions-title">
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="board" value="investigations" />
          <Button type="submit">Start as investigation</Button>
        </form>
      {/if}
      {#if detail.canDismiss}
        <form method="POST" action="{self}?/dismiss#actions-title">
          <input type="hidden" name="id" value={row.id} />
          <Button type="submit" variant="ghost">Dismiss</Button>
        </form>
      {/if}
      {#if detail.canUnmute}
        <form method="POST" action="{self}?/unmute#actions-title">
          <input type="hidden" name="id" value={row.id} />
          <Button type="submit">Unmute</Button>
        </form>
      {/if}
    </div>
    {#if row.canStart}<p class="note">Starting a card runs nothing. It lands in Inbox.</p>{/if}
    {#if problem !== null}<p class="refused" role="alert">{problem}</p>{/if}
    <p class="quiet" role="status">{said}</p>
  </div>
</article>

<style>
  .fd {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 26px;
    min-width: 0;
    padding: 22px 32px 32px;
  }

  .fd-h {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .fd-r {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  /* The card key a started finding carries is a key, so it is set in mono. */
  .fd-r :global(.detail) {
    font-family: var(--font-mono);
  }

  .fd-t {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }

  .sec {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  h3 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  h3 .n {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    font-weight: 400;
    color: var(--muted);
  }

  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .label {
    margin: 0;
    font-size: var(--text-2xs);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* A collected line can be a whole stack trace, so it wraps rather than pushing the page sideways. */
  pre {
    margin: 0;
    padding: var(--space-3) 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    line-height: 1.75;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .as {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 10px var(--space-4);
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  dt {
    color: var(--muted);
  }

  /* A part is text a run wrote, with its own line breaks. */
  dd {
    margin: 0;
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .acts-w {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 18px;
    border-top: 1px solid var(--line);
  }

  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .note {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .quiet a {
    color: var(--ink-2);
  }

  .refused {
    margin: 0;
    padding-left: 10px;
    box-shadow: inset 2px 0 0 var(--red);
    font-size: var(--text-xs);
    color: var(--ink);
  }

  @media (max-width: 760px) {
    .fd {
      padding: var(--space-5) var(--space-4);
    }

    .as {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
