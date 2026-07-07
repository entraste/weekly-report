import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [preact()],
  // GitHub Pages serves at /<repo-name>/
  base: '/weekly-report/',
  resolve: {
    alias: {
      // Single source of truth: the action's own schema module.
      '@schema': resolve(here, '../src/schema')
    }
  },
  server: {
    fs: { allow: [resolve(here, '..')] }
  },
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node'
  }
});
