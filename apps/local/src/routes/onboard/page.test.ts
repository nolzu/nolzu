import { expect, it } from 'vitest';
import { load } from './+page.server.ts';

// A link or a bookmark to the old first run lands on New project.
it('sends the old address to New project', () => {
  let thrown: unknown = null;
  try {
    load({} as never);
  } catch (redirect) {
    thrown = redirect;
  }

  expect(thrown).toMatchObject({ status: 307, location: '/new' });
});
