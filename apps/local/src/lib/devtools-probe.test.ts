import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { quietProbe } from './devtools-probe.ts';

// Under vite dev this answers before SvelteKit, which would send a "not found" body.
describe('quietProbe', () => {
  const call = (url: string) => {
    const res = { statusCode: 200, end: vi.fn() };
    const next = vi.fn();
    quietProbe({ url } as IncomingMessage, res as unknown as ServerResponse, next);
    return { res, next };
  };

  it.each(['/.well-known/appspecific/com.chrome.devtools.json', '/.well-known/appspecific/com.chrome.devtools.json?x=1'])('answers %s with an empty 404', (url) => {
    const { res, next } = call(url);
    expect(res.statusCode).toBe(404);
    expect(res.end).toHaveBeenCalledWith();
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['/', '/.well-known/appspecific/com.chrome.devtools.json.bak', '/b/com.chrome.devtools.json'])('passes %s on', (url) => {
    const { res, next } = call(url);
    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});
