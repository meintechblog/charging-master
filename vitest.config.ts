import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    // Use jsdom for component (.tsx) tests; node-default tests opt out via
    // // @vitest-environment node header. jsdom is required by RTL-based
    // tests added in Plan 11-04 (soc-band-indicator, charging-settings).
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
