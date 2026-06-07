import { describe, it, expect } from 'vitest';
import { normalizeUnifiedDiff, groupRanges, addedTextByFile } from './normalize';
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

const ADDED = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;
const DELETED = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 1111111..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const a = 1;
-export const b = 2;
`;
const RENAMED = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
index 1111111..2222222 100644
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,2 +1,2 @@
 export const a = 1;
-export const b = 2;
+export const b = 3;
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

  it('classifies an added file (path from to-side, no oldPath)', () => {
    const f = normalizeUnifiedDiff(ADDED, 'main').files[0]!;
    expect(f.status).toBe('added');
    expect(f.path).toBe('src/new.ts');
    expect(f.oldPath).toBeUndefined();
    expect(f.hunks[0]!.newRanges).toEqual([{ start: 1, end: 2 }]);
  });

  it('classifies a deleted file (path from from-side, no new ranges)', () => {
    const f = normalizeUnifiedDiff(DELETED, 'main').files[0]!;
    expect(f.status).toBe('deleted');
    expect(f.path).toBe('src/old.ts');
    expect(f.hunks[0]!.newRanges).toEqual([]);
  });

  it('classifies a rename and records the old path', () => {
    const f = normalizeUnifiedDiff(RENAMED, 'main').files[0]!;
    expect(f.status).toBe('renamed');
    expect(f.path).toBe('src/new.ts');
    expect(f.oldPath).toBe('src/old.ts');
  });

  it('returns no files for an empty diff and passes headRef through', () => {
    const d = normalizeUnifiedDiff('', 'main', 'feat');
    expect(d.files).toEqual([]);
    expect(d.headRef).toBe('feat');
  });
});

describe('addedTextByFile', () => {
  it('returns the added-line span and joined text per file', () => {
    const [a] = addedTextByFile(ADDED);
    expect(a).toMatchObject({ file: 'src/new.ts', start: 1, end: 2 });
    expect(a!.text).toBe('export const a = 1;\nexport const b = 2;');
  });

  it('skips files with no added lines (pure deletions)', () => {
    expect(addedTextByFile(DELETED)).toEqual([]);
  });

  it('caps the joined text at 4000 chars', () => {
    const big = `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,1 @@\n+${'z'.repeat(9000)}\n`;
    expect(addedTextByFile(big)[0]!.text.length).toBe(4000);
  });

  it('handles a file with a very large number of added lines without overflowing the stack', () => {
    // Regression: Math.min(...lines)/Math.max(...lines) spread overflowed on ~100k+ adds.
    const N = 150_000;
    const body = Array.from({ length: N }, () => '+x').join('\n');
    const huge = `diff --git a/big.ts b/big.ts\nnew file mode 100644\n--- /dev/null\n+++ b/big.ts\n@@ -0,0 +1,${N} @@\n${body}\n`;
    const [r] = addedTextByFile(huge);
    expect(r!.start).toBe(1);
    expect(r!.end).toBe(N);
  });
});
