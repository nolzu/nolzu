// The end of an id on a Changes group. The project folder keeps the plain ids it always had. A
// folder name can hold a space, and aria-labelledby splits on spaces, so only safe characters stay.
export const repoSuffix = (repo: string): string => (repo === '.' ? '' : `-${repo.replace(/[^A-Za-z0-9_-]/g, '_')}`);
