// npm answers 404 for a private scoped package it has no login for, and the agent then reports a
// missing package. The run uses the person's own npm setup (`engineEnv` passes the environment on),
// so the fix is a login on their side, and the sentence says so. No npmrc file is read here.
// pnpm reads the same npm login and prints its own form of the 404.
const SCOPED_404 = /(?:404 Not Found - |FETCH_404\s+)GET \S*?\/(@[\w.~-]+)(?:%2f|\/)/i;
const NOT_IN_REGISTRY = /'(@[\w.~-]+)\/[^'\s]+' is not in this registry/;

export function npmScopeRefusal(text: string): string | null {
  const scope = SCOPED_404.exec(text)?.[1] ?? NOT_IN_REGISTRY.exec(text)?.[1];
  if (scope === undefined) return null;
  return `The package registry refused ${scope}, so log in to npm for that scope where Nolzu runs (npm login --scope=${scope}) and run again. Runs use your own npm setup.`;
}
