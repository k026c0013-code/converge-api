import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // The web app is a client of Converge API; in dev the API runs separately on :3000.
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      // Realtime endpoint (ADR-0009). The browser Origin (this dev server) is on the API's allowlist.
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
  },
});
