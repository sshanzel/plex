import { defineConfig } from 'tsup';

/**
 * Bundle the CLI and MCP server to self-contained ESM that runs under plain `node`
 * (ADR-17: node is stable with the Kùzu native addon; tsx is not). Native/heavy deps
 * stay external and resolve from node_modules at runtime.
 */
export default defineConfig({
  entry: {
    plex: 'packages/cli/src/index.ts',
    'plex-mcp': 'packages/mcp-server/src/index.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  bundle: true,
  // Bundle only our own workspace source; every third-party dep (esp. the native Kùzu
  // CJS addon, which cannot be ESM-bundled) stays external and resolves from node_modules.
  noExternal: [/^@plex\//],
  // web-tree-sitter must also stay unbundled: its Emscripten glue locates web-tree-sitter.wasm
  // relative to its own module file — bundling re-anchors import.meta.url to dist/ and breaks it.
  external: ['kuzu', 'typescript', '@modelcontextprotocol/sdk', 'zod', 'parse-diff', 'web-tree-sitter', 'tree-sitter-python'],
  outDir: 'dist',
  clean: true,
});
