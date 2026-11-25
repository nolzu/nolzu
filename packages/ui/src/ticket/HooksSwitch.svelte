<script lang="ts">
  // Nolzu's own commit and push skip the repository's git hooks. An agent wrote the work, and a hook it
  // planted, such as .husky/pre-commit, would run with the person's full rights outside the wall. The
  // tick turns them on for one press only, so the owner of the component resets it after that press.
  let { checked = $bindable(false), id }: { checked?: boolean; id: string } = $props();
</script>

<div class="hooks" data-hooks>
  <p class="quiet">Git hooks are skipped, because an agent wrote these changes.</p>
  <label for={id}><input type="checkbox" {id} bind:checked data-run-hooks />Run hooks</label>
</div>

<style>
  .hooks {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-3);
  }

  .quiet {
    margin: 0;
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--ink);
    font-size: var(--text-xs);
  }

  input {
    accent-color: var(--accent);
  }
</style>
