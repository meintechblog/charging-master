import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // React plugin enables JSX/TSX parsing in component tests added by Plan 11-04.
  // Node-default tests are unaffected (they don't contain JSX).
  plugins: [react()],
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
