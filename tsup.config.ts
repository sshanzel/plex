import { defineConfig } from 'tsup';

/**
 * Bundle the CLI and MCP server to self-contained ESM that runs under plain `node`
 * (ADR-17: node is stable with the Kùzu native addon; tsx is not). Native/heavy deps
 * stay external and resolve from node_modules at runtime. The FalkorDB child worker
 * (ADR-16) is copied next to the output so falkor.ts can spawn it.
 */
export default defineConfig({
  entry: {
    plex: 'packages/cli/src/index.ts',
    'plex-mcp': 'packages/mcp-server/src/index.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  bundle: true,
  // Bundle only our own workspace source; every third-party dep (esp. the native Kùzu
  // CJS addon, which cannot be ESM-bundled) stays external and resolves from node_modules.
  noExternal: [/^@plex\//],
  external: ['kuzu', 'falkordb', 'typescript', '@modelcontextprotocol/sdk', 'zod', 'parse-diff'],
  outDir: 'dist',
  clean: true,
  onSuccess: 'cp packages/neighborhood/src/falkor-worker.mjs dist/falkor-worker.mjs',
});
