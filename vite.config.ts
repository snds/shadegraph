/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// One config for both the dev server and the test runner, so tests resolve
// modules exactly like the app does. A separate vitest.config.ts would shadow
// this file wholesale and silently drop the React plugin.
export default defineConfig({
  plugins: [react()],
  // :5180 is a contract (AGENTS.md / Phase 1 acceptance criteria), so fail
  // loudly on a port clash instead of silently drifting to :5181.
  // host is pinned because Vite's default resolved `localhost` to IPv6 [::1]
  // only here, which made http://127.0.0.1:5180 connection-refused for
  // headless/automated browsers.
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  test: {
    // Phase 1 is model/store/registry logic — no DOM needed yet. A later task
    // that adds component tests should switch this to 'jsdom'.
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
