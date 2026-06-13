/**
 * Shared retry policy for child-process spawns under resource pressure (ADR — silent-failure audit #1).
 *
 * Resource errnos that mean the child **never spawned** (the OS couldn't fork/exec under load) — as
 * opposed to a command that RAN and exited non-zero. Only the former is safe to retry: the command
 * never executed, so re-running it can't change a deterministic result; a non-zero exit (`code` is a
 * NUMBER — a bad ref, etc.) is a real failure and must surface. Under CI fork-storm (the kuzu E2Es), a
 * transient spawn failure here would otherwise silently make a git getter return '' → a review round
 * recorded with an empty `headSha` → round-over-round drift attribution AND reconcile (both keyed on
 * `lastHeadSha`) go dead. So the retry is a correctness fix, not just flake suppression.
 *
 * This lives in `@plex/core` (dependency-free) so BOTH `@plex/ingest` (`runGit`) and
 * `@plex/code-graph` (`headSha`) route their git spawns through the SAME tested policy — the audit
 * found `code-graph`'s `headSha` was an un-retried twin of the one `ingest` had already hardened.
 *
 * The set is exactly the errnos a fork/exec raises when the child never came to exist: EAGAIN/ENOMEM
 * (no process slot / memory to fork), ENFILE/EMFILE (fd table exhausted), ETXTBSY (the binary is being
 * written). NOT included: ENOENT (binary genuinely missing — retrying never helps) or ESRCH (signal to
 * a dead pid — a post-spawn signalling failure, not a failed fork).
 */
const TRANSIENT_SPAWN_ERRNOS = new Set(['EAGAIN', 'ENOMEM', 'ENFILE', 'EMFILE', 'ETXTBSY']);

/** True when a child-process rejection is a transient SPAWN failure (retryable), not a non-zero exit. */
export function isTransientSpawnError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && TRANSIENT_SPAWN_ERRNOS.has(code);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RetrySpawnOpts {
  /** Total attempts before giving up (default 5: the first try + 4 retries). */
  attempts?: number;
  /** Backoff base in ms; the nth retry waits `baseMs * n` (default 25). */
  baseMs?: number;
}

/**
 * Run `fn` (a child-process spawn returning a promise), retrying ONLY transient spawn failures with a
 * brief linear backoff. A non-zero exit or any non-spawn error propagates immediately on the first
 * occurrence — a real failure must not be masked by retries.
 */
export async function retryTransientSpawn<T>(fn: () => Promise<T>, opts: RetrySpawnOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseMs = opts.baseMs ?? 25;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < attempts - 1 && isTransientSpawnError(e)) {
        await delay(baseMs * (attempt + 1)); // the fork-capacity dip is momentary
        continue;
      }
      throw e; // non-zero exit (real failure) or retries exhausted
    }
  }
}
