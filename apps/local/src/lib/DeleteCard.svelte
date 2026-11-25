<script lang="ts">
  import { resolve } from '$app/paths';
  import { DeleteCardDialog } from '@nolzu/ui';
  import { cardDeleted } from './board-page.ts';
  import type { DeleteCheck, Deleted } from './delete-card.ts';
  import { toastStack } from './toast-stack.svelte.ts';

  // Delete card for the card page and the peek: asks the server what would go as it opens, sends the
  // delete, and raises "Deleted KEY." with what stayed. Put on the page only while it is open.
  let { cardKey, onclose, ondeleted }: { cardKey: string; onclose: () => void; ondeleted: () => void } = $props();

  let check = $state<DeleteCheck | null>(null);
  let problem = $state<string | null>(null);
  let held = $state(false);
  const address = $derived(resolve('/api/card/[key]/delete', { key: encodeURIComponent(cardKey) }));
  const refusal = async (answer: Response) => ((await answer.json().catch(() => null)) as { message?: string } | null)?.message ?? `The local app answered ${answer.status}.`;

  // Asked as the confirm opens, again on Check again after a refusal, and again after a refused delete,
  // so the confirm always shows what the checkout holds now.
  async function read(): Promise<void> {
    try {
      const answer = await fetch(address);
      if (answer.ok) check = (await answer.json()) as DeleteCheck;
      else problem = await refusal(answer);
    } catch {
      problem = 'The card could not be read. The local app is not answering.';
    }
  }
  $effect(() => {
    void address;
    void read();
  });

  async function again(): Promise<void> {
    problem = null;
    await read();
  }

  async function confirm(folder: boolean): Promise<void> {
    held = true;
    problem = null;
    try {
      // What the confirm showed goes with the delete, so the server refuses when the checkout holds more.
      const answer = await fetch(address, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder, seen: check?.seen ?? [] }) });
      if (!answer.ok) {
        const said = await refusal(answer);
        await read();
        problem = said;
        return;
      }
      const done = (await answer.json()) as Deleted;
      toastStack.state = cardDeleted(toastStack.state, cardKey, done.said, done.stays, done.failed);
      ondeleted();
    } catch {
      problem = 'The delete could not be sent. The local app is not answering.';
    } finally {
      held = false;
    }
  }
</script>

<DeleteCardDialog {cardKey} {check} {problem} {held} onconfirm={confirm} onrecheck={again} {onclose} />
