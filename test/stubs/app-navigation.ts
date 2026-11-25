// What `$app/navigation` gives a component under the SvelteKit vite plugin. A mounted test has no
// router, so `goto` goes nowhere. A test that needs to know where a page went spies on it.
export async function goto(): Promise<void> {}

// The card page reads its tabs again with it when the board says the card's state moved. A mounted
// card page has no load to run again.
export async function invalidateAll(): Promise<void> {}
