import type { Readable } from 'node:stream'

const DEFAULT_STARTUP_STDERR_LIMIT = 8 * 1024

export interface ProxyStderrCapture {
  finishStartup(): void
  startupError(error: unknown): Error
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

  stream.on('data', (chunk: Buffer | string) => {
    const output = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    options.onOutput?.(output.toString())

    if (!captureStartup) {
      return
    }

    const next = Buffer.concat([startupBuffer, output])
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
