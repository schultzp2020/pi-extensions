import type { Readable } from 'node:stream'

const DEFAULT_STARTUP_STDERR_LIMIT = 8 * 1024

export interface ProxyStderrCapture {
  finishStartup(): void
  startupError(error: unknown): Error
}

/** Drains proxy stderr while retaining only bounded startup diagnostics. */
export function captureProxyStderr(
  stream: Readable,
  startupLimitBytes = DEFAULT_STARTUP_STDERR_LIMIT,
): ProxyStderrCapture {
  let startupBuffer = Buffer.alloc(0)
  let captureStartup = true

  stream.on('data', (chunk: Buffer | string) => {
    if (!captureStartup) {
      return
    }

    const next = Buffer.concat([startupBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    startupBuffer = next.subarray(Math.max(0, next.length - startupLimitBytes))
  })

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
  }
}
