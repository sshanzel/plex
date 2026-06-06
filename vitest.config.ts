import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => resolve(root, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@plex/core': pkg('core'),
      '@plex/ingest': pkg('ingest'),
      '@plex/code-graph': pkg('code-graph'),
      '@plex/neighborhood': pkg('neighborhood'),
      '@plex/engine': pkg('engine'),
      '@plex/knowledge': pkg('knowledge'),
      '@plex/deterministic': pkg('deterministic'),
      '@plex/findings': pkg('findings'),
    },
  },
  test: {
    // Pure unit tests only. Kùzu-/subprocess-heavy integration tests run via tsx
    // (`pnpm test:integration`) because the Kùzu native addon crashes vitest's worker
    // teardown (the product code is unaffected — see packages/engine/integration.mts).
    include: ['packages/*/src/**/*.test.ts'],
  },
});
