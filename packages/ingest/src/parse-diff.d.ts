/**
 * Minimal ambient types for `parse-diff` (ships no types of its own).
 * Only the subset we consume is declared.
 */
declare module 'parse-diff' {
  export interface Change {
    type: 'add' | 'del' | 'normal';
    /** New-side line number for `add`; old-side for `del`. */
    ln?: number;
    /** Old-side line for `normal`. */
    ln1?: number;
    /** New-side line for `normal`. */
    ln2?: number;
    content: string;
  }
  export interface Chunk {
    content: string;
    changes: Change[];
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
  }
  export interface File {
    chunks: Chunk[];
    deletions: number;
    additions: number;
    from?: string;
    to?: string;
    new?: boolean;
    deleted?: boolean;
    index?: string[];
  }
  export default function parseDiff(input: string): File[];
}
