import { describe, expect, it, vi } from 'vitest'

import { createShutdownController, DEBUG_FLUSH_SHUTDOWN_TIMEOUT_MS } from './shutdown.ts'

function deferredFlush() {
  let release!: () => void
  const flushPromise = new Promise<void>((resolve) => {
    release = resolve
  })
  const flush = vi.fn<(timeoutMs: number) => Promise<void>>(() => flushPromise)
  return { flush, release }
}

describe('proxy shutdown controller', () => {
  it('flushes once with the shutdown bound and exits only after the flush settles', async () => {
    const { flush, release } = deferredFlush()
    const exit = vi.fn<(code: number) => void>()
    const requestShutdown = createShutdownController(flush, exit)

    requestShutdown()

    expect(DEBUG_FLUSH_SHUTDOWN_TIMEOUT_MS).toBe(1_000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith(DEBUG_FLUSH_SHUTDOWN_TIMEOUT_MS)
    // Exit waits for the flush settlement (or its deadline), never before.
    expect(exit).not.toHaveBeenCalled()

    release()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1))
    expect(exit).toHaveBeenCalledWith(0)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('treats repeated requests as one: one flush, one exit', async () => {
    const { flush, release } = deferredFlush()
    const exit = vi.fn<(code: number) => void>()
    const requestShutdown = createShutdownController(flush, exit)

    requestShutdown()
    requestShutdown()
    requestShutdown()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()

    release()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1))

    // A request after the exit stays ignored: no second flush, no second exit.
    requestShutdown()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })
})
