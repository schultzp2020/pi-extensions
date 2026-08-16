import type { Readable } from 'node:stream'

const DEFAULT_STARTUP_STDERR_LIMIT = 8 * 1024

export interface ProxyStderrCapture {
  finishStartup(): void
  startupError(error: unknown): Error
  drain(timeoutMs: number): Promise<void>
  /**
   * Stops output routing, clears the startup buffer, and settles every active
   * drain. Retains one inert error sink until stream close proves queued
   * destruction errors completed. Idempotent.
   */
  dispose(): void
}

export interface ProxyStderrCaptureOptions {
  startupLimitBytes?: number
  onOutput?: (output: string) => void
}

/** Drains proxy stderr while retaining only bounded startup diagnostics. */
export function captureProxyStderr(stream: Readable, options: ProxyStderrCaptureOptions = {}): ProxyStderrCapture {
  const startupLimitBytes = options.startupLimitBytes ?? DEFAULT_STARTUP_STDERR_LIMIT
  let startupBuffer = Buffer.alloc(0)
  let captureStartup = true
  let disposed = false
  // Every active drain's settlement function. dispose() settles all of them
  // so no drain can leave its transient listeners or its timer behind after
  // the capture is gone. Each settlement removes itself once it runs.
  const activeDrains = new Set<() => void>()
  // Terminal stream state, recorded by the persistent listeners below.
  // The flags let drain() decide immediately and safely; reading
  // stream.destroyed instead would race errors Node has queued but not
  // emitted yet.
  let ended = false
  let closed = false
  let errored = false

  // Persistent listeners for the capture lifetime: an stderr transport
  // failure must never crash the parent with an unhandled 'error' event,
  // before, during, or after a drain. dispose() removes the output routing
  // and the end tracker through these named references. The inert error
  // sink stays until the stream's own close: destroy(error) can queue an
  // 'error' emission that a later no-arg destroy does not cancel, and only
  // 'close' proves that queue drained.
  const onError = (): void => {
    errored = true
  }
  const onEnd = (): void => {
    ended = true
  }
  const onClose = (): void => {
    closed = true
    if (disposed) {
      // Close proves every queued destruction error completed, so the
      // final inert error sink can leave now.
      stream.removeListener('error', onError)
      stream.removeListener('close', onClose)
    }
  }
  const onData = (chunk: Buffer | string): void => {
    const output = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    options.onOutput?.(output.toString())

    if (!captureStartup) {
      return
    }

    const next = Buffer.concat([startupBuffer, output])
    startupBuffer = next.subarray(Math.max(0, next.length - startupLimitBytes))
  }

  stream.on('error', onError)
  stream.on('end', onEnd)
  stream.on('close', onClose)
  stream.on('data', onData)

  return {
    finishStartup(): void {
      captureStartup = false
      startupBuffer = Buffer.alloc(0)
    },
    startupError(error: unknown): Error {
      captureStartup = false
      const message = error instanceof Error ? error.message : String(error)
      const diagnostics = startupBuffer.toString().trim()
      if (!diagnostics) {
        return error instanceof Error ? error : new Error(message)
      }
      return new Error(`${message}\nProxy stderr:\n${diagnostics}`, { cause: error })
    },
    /**
     * Waits until the stream ends, closes, or errors, or until the deadline.
     * The child can write its final stderr after its `exit` event, so callers
     * drain before they snapshot the startup buffer. Never rejects.
     */
    drain(timeoutMs: number): Promise<void> {
      if (disposed || ended || closed || errored) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        let settled = false
        // Transient listeners; removed on every settlement path, including
        // disposal and the deadline, before the promise resolves.
        const onEnd = (): void => {
          ended = true
          settle()
        }
        const onClose = (): void => {
          closed = true
          settle()
        }
        const onError = (): void => {
          errored = true
          settle()
        }
        const settle = (): void => {
          if (settled) {
            return
          }
          settled = true
          activeDrains.delete(settle)
          clearTimeout(timer)
          stream.removeListener('end', onEnd)
          stream.removeListener('close', onClose)
          stream.removeListener('error', onError)
          resolve()
        }
        activeDrains.add(settle)
        // settle only runs after this synchronous block completes, so the
        // const timer it clears is always initialized by then.
        const timer = setTimeout(settle, timeoutMs)
        stream.once('end', onEnd)
        stream.once('close', onClose)
        stream.once('error', onError)
      })
    },
    /**
     * Stops output routing, clears the startup buffer, and settles every
     * active drain, so none keeps a transient listener or timer. Callers
     * must snapshot diagnostics with startupError() before disposing.
     * Retains one inert error sink until the stream's own close proves
     * queued destruction errors completed; close also removes that sink.
     * If close never comes, the sink stays: an unhandled stream error would
     * crash the parent. Idempotent; drains after disposal settle
     * immediately.
     */
    dispose(): void {
      if (disposed) {
        return
      }
      disposed = true
      captureStartup = false
      startupBuffer = Buffer.alloc(0)
      // Settle every active drain before removing the persistent listeners:
      // each settlement clears its timer, removes its own transient
      // listeners, unregisters itself, and resolves exactly once.
      for (const settle of activeDrains) {
        settle()
      }
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      if (closed) {
        // Close already fired, so no queued destruction error can remain.
        stream.removeListener('error', onError)
        stream.removeListener('close', onClose)
      }
    },
  }
}
