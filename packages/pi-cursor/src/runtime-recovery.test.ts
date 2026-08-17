import { clampThinkingLevel, type Context, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({
  connectToProxy:
    vi.fn<(sessionId: string, accessToken: string | null) => Promise<{ port: number; pid: number; models: [] }>>(),
  exitListener: undefined as ((event: { port: number; childPid: number }) => void) | undefined,
  isProxyHealthy: vi.fn<(port: number, signal?: AbortSignal) => Promise<boolean>>(),
  pushToken: vi.fn<(port: number, accessToken: string, signal?: AbortSignal) => Promise<boolean>>(),
}))

const delegatedStream = vi.hoisted(() =>
  vi.fn<(model: Model<'openai-completions'>, context: Context, options?: SimpleStreamOptions) => AsyncIterable<never>>(
    () => ({
      async *[Symbol.asyncIterator]() {},
    }),
  ),
)

vi.mock('node:os', () => ({ homedir: () => '/nonexistent/pi-cursor-runtime-recovery-test' }))
vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai')>()),
  streamSimple: delegatedStream,
}))
vi.mock('./proxy-lifecycle.ts', () => ({
  connectToProxy: lifecycle.connectToProxy,
  getActivePort: () => null,
  isProxyHealthy: lifecycle.isProxyHealthy,
  onProxyExit: (listener: (event: { port: number; childPid: number }) => void) => {
    lifecycle.exitListener = listener
    return () => {
      lifecycle.exitListener = undefined
    }
  },
  pushToken: lifecycle.pushToken,
  readPortFile: () => ({ port: 4100, pid: 41 }),
  stopHeartbeat: vi.fn<() => void>(),
}))

import cursorExtension from './index.ts'

beforeEach(() => {
  lifecycle.connectToProxy.mockReset().mockResolvedValue({ port: 4100, pid: 41, models: [] })
  lifecycle.isProxyHealthy.mockReset().mockResolvedValue(true)
  lifecycle.pushToken.mockReset().mockResolvedValue(true)
  lifecycle.exitListener = undefined
  delegatedStream.mockClear()
})

describe('request-time proxy recovery', () => {
  it('moves the live provider off a dead child and delegates the next request to the respawned port', async () => {
    const registrations: ProviderConfig[] = []
    const pi = {
      on: vi.fn<(event: string, handler: (...args: unknown[]) => unknown) => void>(),
      registerCommand: vi.fn<(name: string, command: unknown) => void>(),
      registerProvider: vi.fn<(name: string, config: ProviderConfig) => void>((_name, config) => {
        registrations.push(config)
      }),
    }
    await cursorExtension(pi as unknown as ExtensionAPI)

    const model: Model<'cursor-openai-completions'> = {
      id: 'cursor-test',
      name: 'Cursor Test',
      provider: 'cursor',
      api: 'cursor-openai-completions',
      baseUrl: 'http://localhost:4100/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }
    const initialProvider = registrations.at(-1)
    expect(initialProvider?.api).toBe('cursor-openai-completions')
    expect(initialProvider?.baseUrl).toBe('http://localhost:4100/v1')
    initialProvider?.streamSimple?.(model, { systemPrompt: '', messages: [], tools: [] }, { apiKey: 'stale-access' })
    await vi.waitFor(() => expect(delegatedStream).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(lifecycle.isProxyHealthy).toHaveBeenCalledWith(4100, undefined))

    lifecycle.exitListener?.({ port: 4100, childPid: 41 })
    expect(registrations.at(-1)?.baseUrl).toBe('http://localhost:0/v1')

    lifecycle.connectToProxy.mockResolvedValueOnce({ port: 4200, pid: 42, models: [] })
    initialProvider?.streamSimple?.(model, { systemPrompt: '', messages: [], tools: [] }, { apiKey: 'fresh-access' })

    await vi.waitFor(() => expect(delegatedStream).toHaveBeenCalledTimes(2))
    expect(lifecycle.connectToProxy).toHaveBeenLastCalledWith(expect.any(String), 'fresh-access')
    expect(registrations.at(-1)?.baseUrl).toBe('http://localhost:4200/v1')
    expect(delegatedStream.mock.calls[1]?.[0]).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'http://localhost:4200/v1',
    })

    lifecycle.exitListener?.({ port: 4200, childPid: 42 })
    lifecycle.connectToProxy.mockResolvedValueOnce({ port: 4300, pid: 43, models: [] })
    registrations
      .at(-1)
      ?.streamSimple?.(model, { systemPrompt: '', messages: [], tools: [] }, { apiKey: 'cursor-proxy' })

    await vi.waitFor(() => expect(delegatedStream).toHaveBeenCalledTimes(3))
    expect(lifecycle.connectToProxy).toHaveBeenLastCalledWith(expect.any(String), 'fresh-access')
    expect(delegatedStream.mock.calls[2]?.[0]).toMatchObject({ baseUrl: 'http://localhost:4300/v1' })
  })

  it('health-checks a cached port and makes only one reconnect attempt when no exit event was observed', async () => {
    const registrations: ProviderConfig[] = []
    const pi = {
      on: vi.fn<(event: string, handler: (...args: unknown[]) => unknown) => void>(),
      registerCommand: vi.fn<(name: string, command: unknown) => void>(),
      registerProvider: vi.fn<(name: string, config: ProviderConfig) => void>((_name, config) => {
        registrations.push(config)
      }),
    }
    await cursorExtension(pi as unknown as ExtensionAPI)

    lifecycle.isProxyHealthy.mockReset().mockResolvedValue(false)
    lifecycle.connectToProxy.mockResolvedValueOnce({ port: 4300, pid: 43, models: [] })
    const model: Model<'cursor-openai-completions'> = {
      id: 'cursor-test',
      name: 'Cursor Test',
      provider: 'cursor',
      api: 'cursor-openai-completions',
      baseUrl: 'http://localhost:4100/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }
    registrations
      .at(-1)
      ?.streamSimple?.(model, { systemPrompt: '', messages: [], tools: [] }, { apiKey: 'fresh-access' })

    await vi.waitFor(() => expect(delegatedStream).toHaveBeenCalledOnce())
    expect(lifecycle.isProxyHealthy).toHaveBeenCalledOnce()
    expect(lifecycle.connectToProxy).toHaveBeenCalledTimes(2)
    expect(registrations.at(-1)?.baseUrl).toBe('http://localhost:4300/v1')
  })

  it('reconnects the same request when the healthy child exits during its token push', async () => {
    const registrations: ProviderConfig[] = []
    const pi = {
      on: vi.fn<(event: string, handler: (...args: unknown[]) => unknown) => void>(),
      registerCommand: vi.fn<(name: string, command: unknown) => void>(),
      registerProvider: vi.fn<(name: string, config: ProviderConfig) => void>((_name, config) => {
        registrations.push(config)
      }),
    }
    await cursorExtension(pi as unknown as ExtensionAPI)

    lifecycle.connectToProxy.mockResolvedValueOnce({ port: 4200, pid: 42, models: [] })
    lifecycle.pushToken.mockImplementationOnce(async (port) => {
      if (port === 4100) {
        lifecycle.exitListener?.({ port: 4100, childPid: 41 })
      }
      return true
    })
    const model: Model<'cursor-openai-completions'> = {
      id: 'cursor-test',
      name: 'Cursor Test',
      provider: 'cursor',
      api: 'cursor-openai-completions',
      baseUrl: 'http://localhost:4100/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }
    registrations
      .at(-1)
      ?.streamSimple?.(model, { systemPrompt: '', messages: [], tools: [] }, { apiKey: 'fresh-access' })

    await vi.waitFor(() => expect(delegatedStream).toHaveBeenCalledOnce())
    expect(lifecycle.connectToProxy).toHaveBeenCalledTimes(2)
    expect(registrations.at(-1)?.baseUrl).toBe('http://localhost:4200/v1')
    expect(delegatedStream.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: 'http://localhost:4200/v1',
    })
  })

  it('reconnects a cross-process proxy when request-time token delivery loses reachability', async () => {
    const registrations: ProviderConfig[] = []
    const pi = {
      on: vi.fn<(event: string, handler: (...args: unknown[]) => unknown) => void>(),
      registerCommand: vi.fn<(name: string, command: unknown) => void>(),
      registerProvider: vi.fn<(name: string, config: ProviderConfig) => void>((_name, config) => {
        registrations.push(config)
      }),
    }
    await cursorExtension(pi as unknown as ExtensionAPI)

    lifecycle.pushToken.mockResolvedValueOnce(false)
    lifecycle.connectToProxy.mockResolvedValueOnce({ port: 4200, pid: 42, models: [] })
    const model: Model<'cursor-openai-completions'> = {
      id: 'cursor-test',
      name: 'Cursor Test',
      provider: 'cursor',
      api: 'cursor-openai-completions',
      baseUrl: 'http://localhost:4100/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }
    registrations
      .at(-1)
      ?.streamSimple?.(model, { systemPrompt: '', messages: [], tools: [] }, { apiKey: 'fresh-access' })

    await vi.waitFor(() => expect(delegatedStream).toHaveBeenCalledOnce())
    expect(lifecycle.connectToProxy).toHaveBeenCalledTimes(2)
    expect(registrations.at(-1)?.baseUrl).toBe('http://localhost:4200/v1')
    expect(delegatedStream.mock.calls[0]?.[0]).toMatchObject({ baseUrl: 'http://localhost:4200/v1' })
  })

  it('cancels promptly while preserving an in-flight recovery for another request', async () => {
    const registrations: ProviderConfig[] = []
    const pi = {
      on: vi.fn<(event: string, handler: (...args: unknown[]) => unknown) => void>(),
      registerCommand: vi.fn<(name: string, command: unknown) => void>(),
      registerProvider: vi.fn<(name: string, config: ProviderConfig) => void>((_name, config) => {
        registrations.push(config)
      }),
    }
    await cursorExtension(pi as unknown as ExtensionAPI)

    lifecycle.isProxyHealthy.mockResolvedValue(false)
    let finishRecovery: ((result: { port: number; pid: number; models: [] }) => void) | undefined
    lifecycle.connectToProxy.mockImplementationOnce(
      async () =>
        await new Promise<{ port: number; pid: number; models: [] }>((resolve) => {
          finishRecovery = resolve
        }),
    )
    const model: Model<'cursor-openai-completions'> = {
      id: 'cursor-test',
      name: 'Cursor Test',
      provider: 'cursor',
      api: 'cursor-openai-completions',
      baseUrl: 'http://localhost:4100/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }
    const controller = new AbortController()
    const provider = registrations.at(-1)
    const cancelledStream = provider?.streamSimple?.(
      model,
      { systemPrompt: '', messages: [], tools: [] },
      { apiKey: 'fresh-access', signal: controller.signal },
    )
    if (!cancelledStream) {
      throw new Error('Cursor provider did not return a request stream')
    }
    await vi.waitFor(() => expect(lifecycle.connectToProxy).toHaveBeenCalledTimes(2))

    const sharedStream = provider?.streamSimple?.(
      model,
      { systemPrompt: '', messages: [], tools: [] },
      { apiKey: 'newer-access' },
    )
    if (!sharedStream) {
      throw new Error('Cursor provider did not return a shared request stream')
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

    controller.abort()
    let cancellationTimer: NodeJS.Timeout | undefined
    const cancelledResult = await Promise.race([
      cancelledStream.result(),
      new Promise<'timed-out'>((resolve) => {
        cancellationTimer = setTimeout(() => resolve('timed-out'), 100)
      }),
    ])
    clearTimeout(cancellationTimer)
    expect(cancelledResult).not.toBe('timed-out')
    expect(cancelledResult).toMatchObject({ stopReason: 'error' })
    expect(delegatedStream).not.toHaveBeenCalled()

    finishRecovery?.({ port: 4200, pid: 42, models: [] })

    await vi.waitFor(() => expect(delegatedStream).toHaveBeenCalledOnce())
    expect(lifecycle.connectToProxy).toHaveBeenCalledTimes(2)
    expect(delegatedStream.mock.calls[0]?.[0]).toMatchObject({ baseUrl: 'http://localhost:4200/v1' })
  })

  it('does not probe or reconnect for an already-cancelled request', async () => {
    const registrations: ProviderConfig[] = []
    const pi = {
      on: vi.fn<(event: string, handler: (...args: unknown[]) => unknown) => void>(),
      registerCommand: vi.fn<(name: string, command: unknown) => void>(),
      registerProvider: vi.fn<(name: string, config: ProviderConfig) => void>((_name, config) => {
        registrations.push(config)
      }),
    }
    await cursorExtension(pi as unknown as ExtensionAPI)

    const controller = new AbortController()
    controller.abort()
    const model: Model<'cursor-openai-completions'> = {
      id: 'cursor-test',
      name: 'Cursor Test',
      provider: 'cursor',
      api: 'cursor-openai-completions',
      baseUrl: 'http://localhost:4100/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }
    const stream = registrations
      .at(-1)
      ?.streamSimple?.(
        model,
        { systemPrompt: '', messages: [], tools: [] },
        { apiKey: 'fresh-access', signal: controller.signal },
      )
    if (!stream) {
      throw new Error('Cursor provider did not return a request stream')
    }

    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'error' })
    expect(lifecycle.isProxyHealthy).not.toHaveBeenCalled()
    expect(lifecycle.pushToken).not.toHaveBeenCalled()
    expect(lifecycle.connectToProxy).toHaveBeenCalledOnce()
    expect(delegatedStream).not.toHaveBeenCalled()
  })

  it('waits for a request before reconnecting after exit-driven OAuth projection', async () => {
    const registrations: ProviderConfig[] = []
    const pi = {
      on: vi.fn<(event: string, handler: (...args: unknown[]) => unknown) => void>(),
      registerCommand: vi.fn<(name: string, command: unknown) => void>(),
      registerProvider: vi.fn<(name: string, config: ProviderConfig) => void>((_name, config) => {
        registrations.push(config)
      }),
    }
    await cursorExtension(pi as unknown as ExtensionAPI)

    registrations.at(-1)?.oauth?.modifyModels?.([], {
      access: 'active-access',
      refresh: 'refresh',
      expires: Date.now() + 60_000,
    })
    expect(lifecycle.pushToken).toHaveBeenCalledWith(4100, 'active-access')
    expect(lifecycle.connectToProxy).toHaveBeenCalledOnce()

    lifecycle.exitListener?.({ port: 4100, childPid: 41 })
    const disconnectedProvider = registrations.at(-1)
    disconnectedProvider?.oauth?.modifyModels?.([], {
      access: 'fresh-access',
      refresh: 'refresh',
      expires: Date.now() + 60_000,
    })

    await Promise.resolve()
    expect(lifecycle.isProxyHealthy).not.toHaveBeenCalled()
    expect(lifecycle.pushToken).toHaveBeenCalledOnce()
    expect(lifecycle.connectToProxy).toHaveBeenCalledOnce()
    expect(registrations.at(-1)?.baseUrl).toBe('http://localhost:0/v1')

    lifecycle.connectToProxy.mockResolvedValueOnce({ port: 4400, pid: 44, models: [] })
    const model: Model<'cursor-openai-completions'> = {
      id: 'cursor-test',
      name: 'Cursor Test',
      provider: 'cursor',
      api: 'cursor-openai-completions',
      baseUrl: 'http://localhost:4100/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }
    disconnectedProvider?.streamSimple?.(
      model,
      { systemPrompt: '', messages: [], tools: [] },
      { apiKey: 'fresh-access' },
    )

    await vi.waitFor(() => expect(delegatedStream).toHaveBeenCalledOnce())
    expect(lifecycle.connectToProxy).toHaveBeenCalledTimes(2)
    expect(registrations.at(-1)?.baseUrl).toBe('http://localhost:4400/v1')
  })

  it('preserves legacy xhigh support when Pi omits model thinking metadata', async () => {
    const registrations: ProviderConfig[] = []
    const pi = {
      on: vi.fn<(event: string, handler: (...args: unknown[]) => unknown) => void>(),
      registerCommand: vi.fn<(name: string, command: unknown) => void>(),
      registerProvider: vi.fn<(name: string, config: ProviderConfig) => void>((_name, config) => {
        registrations.push(config)
      }),
    }
    await cursorExtension(pi as unknown as ExtensionAPI)

    const model: Model<'cursor-openai-completions'> = {
      id: 'gpt-5.4',
      name: 'GPT-5.4',
      provider: 'cursor',
      api: 'cursor-openai-completions',
      baseUrl: 'http://localhost:4100/v1',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    }
    const context = { systemPrompt: '', messages: [], tools: [] }
    const options = { apiKey: 'cursor-proxy', reasoning: 'xhigh' as const }
    registrations.at(-1)?.streamSimple?.(model, context, options)

    await vi.waitFor(() => expect(delegatedStream).toHaveBeenCalledOnce())
    const delegatedModel = delegatedStream.mock.calls[0]?.[0]
    expect(delegatedModel).toMatchObject({
      api: 'openai-completions',
      thinkingLevelMap: { xhigh: 'xhigh' },
    })
    expect(delegatedModel && clampThinkingLevel(delegatedModel, 'xhigh')).toBe('xhigh')
    expect(delegatedStream.mock.calls[0]?.[1]).toBe(context)
    expect(delegatedStream.mock.calls[0]?.[2]).toBe(options)
  })
})
