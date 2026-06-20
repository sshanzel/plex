/**
 * Shared child-process spawn retry policy. INVARIANT: retry ONLY errnos meaning the child NEVER
 * spawned (safe to re-run a deterministic command) — never a non-zero EXIT (a real failure must
 * surface). It's a correctness fix, not just flake suppression: an un-retried spawn failure makes a
 * git getter return '' → an empty `headSha` → drift attribution and reconcile (both keyed on it) go dead.
 *
 * The set is exactly the fork/exec "never came to exist" errnos: EAGAIN/ENOMEM (no slot/memory),
 * ENFILE/EMFILE (fd table full), ETXTBSY (binary being written). NOT ENOENT (missing binary — retry
 * never helps) or ESRCH (signal to a dead pid — post-spawn, not a failed fork).
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

/** Run `fn` (a spawn), retrying ONLY transient spawn failures (linear backoff); any other error propagates immediately. */
export async function retryTransientSpawn<T>(fn: () => Promise<T>, opts: RetrySpawnOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseMs = opts.baseMs ?? 25;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < attempts - 1 && isTransientSpawnError(e)) {
        await delay(baseMs * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}
