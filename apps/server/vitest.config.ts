import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests talk to real MySQL/Redis and WebSockets; the 5 s default is too tight
    // when the whole workspace runs in parallel.
    testTimeout: 15_000,
  },
});
