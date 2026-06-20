/** Kùzu file-lock contention: the SAME data dir is already open read-write (embedded store is single-writer). */
export class RepoBusyError extends Error {
  constructor(public readonly dir: string) {
    super(
      `Plex is already reviewing or indexing this path in another process (${dir}). ` +
        `Separate repos and worktrees run in parallel fine — this only happens when the SAME path ` +
        `is opened twice at once. Wait for the other run to finish, then retry.`,
    );
    this.name = 'RepoBusyError';
  }
}

/** Is this a Kùzu file-lock contention? Matches kuzu 0.11.x's message; kept narrow so it never masks an unrelated IO error. */
export function isLockError(e: unknown): boolean {
  return e instanceof Error && /could not set lock on file/i.test(e.message);
}
