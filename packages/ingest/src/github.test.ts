import { describe, it, expect } from 'vitest';
import { getPrDiff } from './github';

// getPrDiff validates the PR number through prArg() BEFORE spawning `gh` — so a malicious value
// (option-injection, e.g. `gh pr diff -x`) is rejected without ever reaching the subprocess. This
// runs with no `gh` installed/auth: the throw happens before the spawn. (The best-effort getters —
// getPrMeta/getPrHeadSha/getPrState — swallow the same throw to '' / {}, so they're not asserted here.)
describe('getPrDiff — rejects an unsafe pr before any gh spawn', () => {
  it('throws on an option-injection pr number', async () => {
    await expect(getPrDiff({ pr: '-x', cwd: '/tmp' })).rejects.toThrow(/unsafe pr number/);
    await expect(getPrDiff({ pr: '1 --json', cwd: '/tmp' })).rejects.toThrow(/unsafe pr number/);
  });
});
