import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    // A server on 127.0.0.1 never needs the gzip and brotli copies, which only made the package bigger.
    adapter: adapter({ precompress: false }),
    // SvelteKit serves every environment variable with this prefix to any page that asks, at
    // /_app/env.script.js, before Nolzu's own checks. The app reads none, so the prefix is one nobody sets.
    env: { publicPrefix: 'NOLZU_NONE_IS_PUBLIC_' },
  },
};
