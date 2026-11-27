import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The fast-check convergence property runs many random scenarios; 5 s is too tight on a busy machine.
    testTimeout: 30_000,
  },
});
