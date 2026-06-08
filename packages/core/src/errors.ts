/**
 * Raised when Kùzu can't acquire its file lock because another process already holds this data
 * dir open read-write (the embedded store is single-writer). Repos and worktrees have SEPARATE
 * data dirs (`repoId` hashes the absolute path), so they never collide — this only fires when the
 * SAME path is reviewed/indexed twice at once. We translate Kùzu's raw lock IOException into a
 * clear, actionable message instead of leaking a cryptic native error to the agent or CLI.
 */
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

/**
 * Does this error look like a Kùzu file-lock contention (another process holds the DB open)?
 * Matches Kùzu's "IO exception: Could not set lock on file : <dir>" — the empirically-confirmed
 * message (kuzu 0.11.x). Kept narrow so it never masks an unrelated IO error as "busy".
 */
export function isLockError(e: unknown): boolean {
  return e instanceof Error && /could not set lock on file/i.test(e.message);
}
