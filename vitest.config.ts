import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests live next to the pure modules they cover — in src/ for the
    // app, in tools/ for the build scripts (the offline manifest decides what
    // works with the network unplugged, so it is not "just a script").
    // The Playwright suite owns tests/local/ and runs via `npm test`.
    include: ['src/**/*.test.ts', 'tools/**/*.test.mjs'],
  },
});
