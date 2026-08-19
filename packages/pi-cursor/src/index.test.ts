import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Mock } from 'vitest'
import { describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  // No stored credentials and no model cache: the extension must register
  // without touching a proxy, so no network or child process is needed.
  existsSync: vi.fn<() => boolean>(() => false),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, existsSync: fsMocks.existsSync }
})

const lifecycleMocks = vi.hoisted(() => ({
  connectToProxy: vi.fn<() => Promise<{ port: number; models: unknown[] }>>(),
  pushToken: vi.fn<() => Promise<void>>(),
  readPortFile: vi.fn<() => null>(() => null),
  stopHeartbeat: vi.fn<() => void>(),
}))

vi.mock('./proxy-lifecycle.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    connectToProxy: lifecycleMocks.connectToProxy,
    pushToken: lifecycleMocks.pushToken,
    readPortFile: lifecycleMocks.readPortFile,
    stopHeartbeat: lifecycleMocks.stopHeartbeat,
  }
})

const debugLoggerMocks = vi.hoisted(() => ({
  initDebugLogger: vi.fn<() => void>(),
  logLifecycle: vi.fn<(sessionId: string, requestId: string, payload: { event: string }) => void>(),
  flushDebugLogger: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}))

vi.mock('./proxy/debug-logger.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    initDebugLogger: debugLoggerMocks.initDebugLogger,
    logLifecycle: debugLoggerMocks.logLifecycle,
    flushDebugLogger: debugLoggerMocks.flushDebugLogger,
  }
})

import extensionEntry, { formatTokenCount } from './index.ts'

describe('formatTokenCount', () => {
  it('formats millions', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(2_000_000)).toBe('2M')
  })

  it('formats thousands', () => {
    expect(formatTokenCount(200_000)).toBe('200K')
    expect(formatTokenCount(272_000)).toBe('272K')
    expect(formatTokenCount(500_000)).toBe('500K')
  })

  it('returns raw number for non-round values', () => {
    expect(formatTokenCount(123_456)).toBe('123456')
    expect(formatTokenCount(999)).toBe('999')
  })
})

describe('extension session shutdown', () => {
  it('awaits the bounded debug log flush before the shutdown handler resolves', async () => {
    const handlers = new Map<string, unknown[]>()
    const pi = {
      registerProvider: vi.fn<(id: string, config: unknown) => void>(),
      registerCommand: vi.fn<(name: string, command: unknown) => void>(),
      on: vi.fn<(name: string, handler: unknown) => void>((name, handler) => {
        handlers.set(name, [handler])
      }),
    } as unknown as ExtensionAPI

    await extensionEntry(pi)

    expect(lifecycleMocks.connectToProxy).not.toHaveBeenCalled()
    const shutdown = handlers.get('session_shutdown')?.[0] as () => Promise<void>
    expect(typeof shutdown).toBe('function')

    // Hold the flush open: the handler must stay pending on it.
    let release!: () => void
    const deferred = new Promise<void>((resolve) => {
      release = resolve
    })
    debugLoggerMocks.flushDebugLogger.mockReturnValueOnce(deferred)

    let settled = false
    const handler = shutdown().then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(debugLoggerMocks.flushDebugLogger).toHaveBeenCalledTimes(1))

    // The flush is the handler's last step and still holds it open, with
    // the exact shutdown bound as its deadline.
    expect(settled).toBeFalsy()
    expect(debugLoggerMocks.flushDebugLogger).toHaveBeenCalledWith(1_000)

    release()
    await handler
    expect(settled).toBeTruthy()

    expect(debugLoggerMocks.logLifecycle).toHaveBeenCalledWith(expect.any(String), '', {
      event: 'session_shutdown',
    })
    expect(lifecycleMocks.stopHeartbeat).toHaveBeenCalledTimes(1)
    // The flush is the last shutdown step, after the heartbeat stops.
    expect(debugLoggerMocks.flushDebugLogger.mock.invocationCallOrder[0]).toBeGreaterThan(
      lifecycleMocks.stopHeartbeat.mock.invocationCallOrder[0],
    )
    // Every handler registered through the typed API surface.
    expect((pi.on as Mock).mock.calls.length).toBeGreaterThan(0)
  })
})
