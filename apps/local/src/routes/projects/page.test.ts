import { expect, it } from 'vitest';
import { load } from './+page.server.ts';

// A link or a bookmark to the old Projects page lands on Settings, Project.
it('sends the old address to Settings, Project', () => {
  let thrown: unknown = null;
  try {
    load({} as never);
  } catch (redirect) {
    thrown = redirect;
  }

  expect(thrown).toMatchObject({ status: 308, location: '/settings/project' });
});
