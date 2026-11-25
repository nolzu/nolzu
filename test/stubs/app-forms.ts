// `use:enhance` without the client runtime. A server render never submits a form, so this only has
// to be a valid Svelte action for the route file to import and draw.
//
// It deliberately does nothing else: no submit, no callback, no form data. So a test that renders a
// settings form checks its markup and its `action="?/name"`, and can say nothing about what a submit
// does.
export const enhance = () => ({ destroy: () => {} });

// Settings, Models posts a pick to its form action with fetch and reads the answer with this. The
// real one reads `data` with devalue; here a mounted test answers with plain JSON.
export const deserialize = (text: string): unknown => JSON.parse(text);

// The Scout source dialog hands a success to the page with this, so the answer prints under the strip.
// A mounted test has no page to hand it to, so here it does nothing.
export const applyAction = async (): Promise<void> => {};
