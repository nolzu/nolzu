import type { IncomingMessage, ServerResponse } from 'node:http';

// Chrome asks for this file on every page load while DevTools is open, and SvelteKit logs each miss.
// It is never served: it would offer Chrome write access to the project folder.
export const DEVTOOLS_PROBE = '/.well-known/appspecific/com.chrome.devtools.json';

// The same empty 404 for `vite dev`, where SvelteKit's middleware answers this path with a body before
// any hook runs. vite.config.ts puts this in front of it. The built app answers in hooks.server.ts.
export function quietProbe(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (req.url?.split('?')[0] !== DEVTOOLS_PROBE) return next();
  res.statusCode = 404;
  res.end();
}
