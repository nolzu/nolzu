<script lang="ts" module>
  import type { BoardKind } from '@nolzu/protocol';

  // One sentence per board, all in the shape PR reviews had first: what goes here, how to add one and
  // the key to press. The words of the Add button are the page's own (`addLabel` in BoardPage).
  // owner/repo#number and not repo#number on PR reviews: the server reads the short form only when the
  // project has a GitHub remote to take the owner from, so the short form is the one that fails on a
  // machine with none. A link names its owner too.
  const SAYS: Readonly<Record<BoardKind, string>> = {
    delivery: 'This board has no card on it. Press N, or Add card, and type a title or a ticket key. Drag the card one column on and an agent starts on this machine.',
    epics: 'This board has no epic on it. Press N, or Add epic, and type the idea or a ticket key. Drag it one column on and an agent plans it into tasks for Delivery.',
    prreview: 'This board has no pull request on it. Press N, or Add pull request, and type the pull request as owner/repo#number or paste its link from GitHub.',
    // Questions and investigations are one Research board, which adds a card through its own box.
    questions: 'This board has no question or investigation on it. Press N, or click the box above, and type a question or what to look into.',
    investigations: 'This board has no question or investigation on it. Press N, or click the box above, and type a question or what to look into.',
  };
</script>

<script lang="ts">
  let { kind }: { kind: BoardKind } = $props();
</script>

<p>{SAYS[kind]}</p>

<style>
  p {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }
</style>
