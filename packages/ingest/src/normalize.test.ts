import { describe, it, expect } from 'vitest';
import { normalizeUnifiedDiff, groupRanges } from './normalize';
import type { DiffFile } from '@plex/core';

describe('groupRanges', () => {
  it('groups contiguous lines into inclusive ranges', () => {
    expect(groupRanges([3, 4, 5, 9, 10, 12])).toEqual([
      { start: 3, end: 5 },
      { start: 9, end: 10 },
      { start: 12, end: 12 },
    ]);
  });
  it('handles empty and unsorted input', () => {
    expect(groupRanges([])).toEqual([]);
    expect(groupRanges([7, 2, 3])).toEqual([
      { start: 2, end: 3 },
      { start: 7, end: 7 },
    ]);
  });
});

// Single-file unified diff — the parser handles this cleanly.
const SINGLE = `diff --git a/src/user.ts b/src/user.ts
index 1111111..2222222 100644
--- a/src/user.ts
+++ b/src/user.ts
@@ -10,7 +10,8 @@ export class UserService {
   save(user: User) {
-    this.repo.insert(user);
+    if (!user.id) throw new Error('missing id');
+    this.repo.insert(user);
   }
 }
`;

describe('normalizeUnifiedDiff', () => {
  it('extracts file, status and changed new-side line ranges', () => {
    const diff = normalizeUnifiedDiff(SINGLE, 'main');
    expect(diff.baseRef).toBe('main');
    expect(diff.files).toHaveLength(1);
    const f = diff.files[0]!;
    expect(f.path).toBe('src/user.ts');
    expect(f.status).toBe('modified');
    // Two inserted lines starting at new line 11 (newStart 10 + 1 context line).
    expect(f.hunks[0]!.newRanges).toEqual([{ start: 11, end: 12 }]);
  });
});
