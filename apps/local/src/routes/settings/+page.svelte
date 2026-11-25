<script lang="ts">
  import { goto } from '$app/navigation';
  import { addressFromHash } from '$lib/settings-sections.ts';

  // The rail links to Project itself, so this page only catches older addresses: /settings from a
  // bookmark, and /settings#<id> written before each section had its own page. The browser never
  // sends the hash to the server, so a server redirect would lose it; it is read here instead.
  $effect(() => {
    const to = addressFromHash(location.hash);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- an address from the section list, and this app has no base path
    void goto(to, { replaceState: true });
  });
</script>

<svelte:head><title>Settings · Nolzu</title></svelte:head>
