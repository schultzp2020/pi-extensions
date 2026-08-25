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
  connectToProxy: vi.fn<() => Promise<{ port: number; pid: number; generation: string; models: unknown[] }>>(),
  getActivePort: vi.fn<() => number | null>(() => null),
  isProxyConnectionCurrent: vi.fn<() => boolean>(() => true),
  isProxyHealthy: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
  pushToken: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
  readPortFile: vi.fn<() => null>(() => null),
  stopHeartbeat: vi.fn<() => void>(),
}))

vi.mock('./proxy-lifecycle.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    connectToProxy: lifecycleMocks.connectToProxy,
    getActivePort: lifecycleMocks.getActivePort,
    isProxyConnectionCurrent: lifecycleMocks.isProxyConnectionCurrent,
    isProxyHealthy: lifecycleMocks.isProxyHealthy,
    pushToken: lifecycleMocks.pushToken,
    readPortFile: lifecycleMocks.readPortFile,
    stopHeartbeat: lifecycleMocks.stopHeartbeat,
  }
})

const compatMocks = vi.hoisted(() => ({
  streamSimple: vi.fn<
    (model: { api: string; provider: string; id: string }) => {
      [Symbol.asyncIterator](): AsyncGenerator<never, void, unknown>
      result(): Promise<unknown>
    }
  >(),
}))

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, streamSimple: compatMocks.streamSimple }
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

describe('host stream adapter selection', () => {
  it('does not inject the legacy xhigh map into the Pi 0.84 compat adapter', async () => {
    const providers: unknown[] = []
    const handlers = new Map<string, unknown>()
    const pi = {
      registerProvider: vi.fn<(_id: string, provider: unknown) => void>((_id, provider) => {
        providers.push(provider)
      }),
      registerCommand: vi.fn<(...args: unknown[]) => void>(),
      on: vi.fn<(name: string, handler: unknown) => void>((name, handler) => {
        handlers.set(name, handler)
      }),
    } as unknown as ExtensionAPI
    lifecycleMocks.connectToProxy.mockResolvedValue({
      port: 4567,
      pid: process.pid,
      generation: new Date().toISOString(),
      models: [],
    })
    compatMocks.streamSimple.mockImplementation((model: { api: string; provider: string; id: string }) => ({
      async *[Symbol.asyncIterator]() {},
      result: () =>
        Promise.resolve({
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: Date.now(),
        }),
    }))

    await extensionEntry(pi)
    const provider = providers.at(-1) as {
      streamSimple: (
        model: Record<string, unknown>,
        context: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => { result: () => Promise<unknown> }
    }
    const model = {
      id: 'gpt-5.4-test',
      name: 'GPT 5.4 Test',
      provider: 'cursor',
      api: 'cursor-openai-completions',
      baseUrl: 'http://localhost:0/v1',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    }

    await provider
      .streamSimple(model, { systemPrompt: '', messages: [], tools: [] }, { apiKey: 'request-token' })
      .result()

    expect(compatMocks.streamSimple).toHaveBeenCalledOnce()
    expect(compatMocks.streamSimple.mock.calls[0]?.[0]).toMatchObject({
      id: model.id,
      api: 'openai-completions',
      baseUrl: 'http://localhost:4567/v1',
      thinkingLevelMap: undefined,
    })

    await (handlers.get('session_shutdown') as () => Promise<void>)()
  })
})
