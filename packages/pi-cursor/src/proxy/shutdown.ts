/**
 * Bounded shutdown coordination for the proxy process.
 *
 * The first request flushes queued debug-log entries under a hard deadline,
 * then exits. Exit never happens before the flush settles or its deadline
 * passes. Repeated requests are idempotent: one flush and one exit, so
 * stacked shutdown signals cannot stack exit continuations.
 */

/** Bounds the final debug-log flush at shutdown */
export const DEBUG_FLUSH_SHUTDOWN_TIMEOUT_MS = 1_000

/**
 * Create a shutdown request function. `flush` must never reject; `exit`
 * ends the process. The returned function is safe to call repeatedly.
 */
export function createShutdownController(
  flush: (timeoutMs: number) => Promise<void>,
  exit: (code: number) => void,
): () => void {
  let requested = false
  return function requestShutdown(): void {
    if (requested) {
      return
    }
    requested = true
    void flush(DEBUG_FLUSH_SHUTDOWN_TIMEOUT_MS).then(() => {
      exit(0)
    })
  }
}
