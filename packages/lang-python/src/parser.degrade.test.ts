import { describe, expect, it, vi } from 'vitest';

// A mocked web-tree-sitter so a wasm-load failure is simulable — the REAL load path is covered by
// parser.test.ts; this file pins the degradation contract only.
const { initMock, loadMock } = vi.hoisted(() => ({ initMock: vi.fn(), loadMock: vi.fn() }));
vi.mock('web-tree-sitter', () => {
  class Parser {
    static init = (...args: unknown[]) => initMock(...args);
    setLanguage(): this {
      return this;
    }
    parse(): unknown {
      return { rootNode: { type: 'module' }, delete: () => {} };
    }
  }
  return { Parser, Language: { load: (...args: unknown[]) => loadMock(...args) } };
});

import { tryInitPython } from './parser';

describe('wasm-init degradation (never fail a review on a load error)', () => {
  it('a failed load reports false, and the rejection is NOT memoized — the next attempt retries', async () => {
    initMock.mockRejectedValueOnce(new Error('wasm boom'));
    loadMock.mockResolvedValue({});
    expect(await tryInitPython()).toBe(false);

    // The long-lived MCP server must recover once the transient cause clears.
    initMock.mockResolvedValueOnce(undefined);
    expect(await tryInitPython()).toBe(true);
    // And success IS memoized: no third init call on repeat use.
    expect(await tryInitPython()).toBe(true);
    expect(initMock).toHaveBeenCalledTimes(2);
  });
});
