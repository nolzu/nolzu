<script lang="ts">
  import { PROJECT_BOXES, SECTIONS } from './settings-sections.ts';

  // The menu on every settings page. The hrefs come in from the layout, because resolve() needs the
  // running app and this menu is server rendered by a test.
  let {
    current,
    href,
    features = [],
    engines = null,
  }: {
    // The section open now, or null on the menu page itself.
    current: string | null;
    href: (id: string) => string;
    // A feature's settings block, which stays on the menu page under its own anchor.
    features?: readonly { id: string; title: string; href: string }[];
    // How many engine tools sit on the PATH, from the settings layout's look. Null draws no count.
    engines?: number | null;
  } = $props();

  // On Project the menu lists its boxes too, and marks the one in view. A box counts as in view while
  // it crosses the top third of the window; of those, the first in page order wins.
  let inView = $state<string | null>(null);
  // The box picked in the menu. A box near the foot of the page never reaches the top third, so the
  // pick stays marked until it is at the top or the person scrolls on their own.
  let picked: string | null = null;
  function pick(id: string): void {
    picked = id;
    inView = id;
  }
  // What a person scrolls with. A press on the menu fires this before its click, which picks again.
  const SCROLLED_BY_HAND = ['wheel', 'touchmove', 'keydown', 'pointerdown'];
  const unpick = () => (picked = null);
  $effect(() => {
    if (current !== 'project') return;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- the observer's own notes; only inView is drawn
    const seen = new Set<string>();
    const boxes = PROJECT_BOXES.map((box) => document.getElementById(box.id)).filter((element) => element !== null);
    // A short last box never reaches the top third, so at the foot of a scrolled page the last one is
    // marked.
    const mark = () => {
      const atEnd = scrollY > 0 && innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      const top = PROJECT_BOXES.find((box) => seen.has(box.id))?.id;
      // On the way there the pick stays marked, so the mark does not run down the menu.
      if (picked !== null) {
        if (top === picked) picked = null;
        return;
      }
      inView = (atEnd ? boxes.at(-1)?.id : top) ?? inView;
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) seen.add(entry.target.id);
          else seen.delete(entry.target.id);
        }
        mark();
      },
      { rootMargin: '0px 0px -66% 0px' },
    );
    for (const element of boxes) observer.observe(element);
    addEventListener('scroll', mark, { passive: true });
    for (const event of SCROLLED_BY_HAND) addEventListener(event, unpick, { passive: true });
    return () => {
      observer.disconnect();
      removeEventListener('scroll', mark);
      for (const event of SCROLLED_BY_HAND) removeEventListener(event, unpick);
    };
  });
</script>

<nav aria-label="Settings sections">
  {#each SECTIONS as section (section.id)}
    {@const found = section.id === 'engines' && engines !== null ? (engines === 0 ? 'None found' : `${engines} found`) : null}
    <!-- The block wraps the whole link, so a section with no count keeps its plain text. -->
    {#if found === null}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the layout resolve()s this address and hands it in -->
      <a href={href(section.id)} aria-current={section.id === current ? 'page' : undefined}>{section.title}</a>
      {#if section.id === 'project' && current === 'project'}
        {#each PROJECT_BOXES as box (box.id)}
          <a class="sub" href="#{box.id}" onclick={() => pick(box.id)} aria-current={box.id === inView ? 'location' : undefined}>{box.title}</a>
        {/each}
      {/if}
    {:else}
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the layout resolve()s this address and hands it in -->
      <a href={href(section.id)} aria-current={section.id === current ? 'page' : undefined}>{section.title}<span class="n">{found}</span></a>
    {/if}
  {/each}
  {#each features as block (block.id)}
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the layout resolve()s this address and hands it in -->
    <a href={block.href}>{block.title}</a>
  {/each}
</nav>

<style>
  /* A column of plain rows beside the section. The page's own top
     padding, so the menu stays where it started when the page scrolls. */
  nav {
    position: sticky;
    top: 16px;
    flex: 0 0 200px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  a {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--ink-2);
    text-decoration: none;
  }

  /* The quiet "2 found": a fact, not something waiting. */
  .n {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  a:hover {
    color: var(--ink);
    background: var(--card);
  }

  /* A box of Project, set in under its section. */
  .sub {
    min-height: 26px;
    padding-left: 22px;
    font-size: var(--text-xs);
  }

  /* The box in view: a bar at the left and the ink, so it is not colour alone. */
  .sub[aria-current='location'] {
    box-shadow: inset 2px 0 0 var(--ink);
    color: var(--ink);
  }

  /* The open section is said by the attribute, the ring and the ink, so it is not colour alone. */
  a[aria-current='page'] {
    box-shadow: inset 0 0 0 1px var(--line);
    background: var(--card);
    color: var(--ink);
  }

  @media (max-width: 640px) {
    /* The menu is a row of links up top here, and nine more would push the page down. */
    .sub {
      display: none;
    }

    nav {
      position: static;
      flex: 1 1 100%;
      flex-direction: row;
      flex-wrap: wrap;
    }
  }
</style>
