import { beforeAll, describe, expect, it } from 'vitest';
import { initPython, parsePython } from './parser';

// Doubles as the web-tree-sitter-under-vitest canary: unlike the Kùzu addon (ADR-17), the wasm
// runtime must survive worker teardown — this suite existing at all pins that.
beforeAll(async () => {
  await initPython();
});

describe('python parser', () => {
  it('parses a module and frees the tree', () => {
    const tree = parsePython('def f():\n    pass\n');
    try {
      expect(tree.rootNode.type).toBe('module');
      expect(tree.rootNode.hasError).toBe(false);
    } finally {
      tree.delete();
    }
  });

  it('re-init is idempotent', async () => {
    await initPython();
    const tree = parsePython('x = 1\n');
    try {
      expect(tree.rootNode.hasError).toBe(false);
    } finally {
      tree.delete();
    }
  });

  it('a broken file still yields a tree (error-tolerant)', () => {
    const tree = parsePython('def f(:\n');
    try {
      expect(tree.rootNode.hasError).toBe(true);
    } finally {
      tree.delete();
    }
  });

  it('refuses sources above the parse cap (wasm memory never shrinks)', async () => {
    const { MAX_PY_SOURCE_BYTES } = await import('./parser');
    const oversized = 'x = 1\n'.repeat(Math.ceil((MAX_PY_SOURCE_BYTES + 1) / 6));
    expect(() => parsePython(oversized)).toThrow(/parse cap/);
    // …and the refusal flows through the extractor as a throw the per-file guards catch upstream.
    const { extractPythonSource } = await import('./extract-py');
    expect(() => extractPythonSource('big.py', oversized)).toThrow(/parse cap/);
  });
});
