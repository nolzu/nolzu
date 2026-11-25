// What `$app/state` gives a component under the SvelteKit vite plugin, for a test that mounts a page.
// One plain page, which a test fills in before it mounts, the way the router would. It is not
// reactive: a test that needs the address to change mounts the page again.
export const page: { url: URL; params: Record<string, string | undefined>; route: { id: string | null }; data: Record<string, unknown> } = {
  url: new URL('http://localhost/'),
  params: {},
  route: { id: '/' },
  data: {},
};
