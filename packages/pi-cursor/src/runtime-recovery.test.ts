import type { Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({
  connectToProxy:
    vi.fn<(sessionId: string, accessToken: string | null) => Promise<{ port: number; pid: number; models: [] }>>(),
  exitListener: undefined as ((event: { port: number; childPid: number }) => void) | undefined,
  isProxyHealthy: vi.fn<(port: number) => Promise<boolean>>(),
  pushToken: vi.fn<(port: number, accessToken: string) => Promise<void>>(),
}))

const delegatedStream = vi.hoisted(() =>
  vi.fn<(model: Model<'openai-completions'>) => AsyncIterable<never>>(() => ({
    async *[Symbol.asyncIterator]() {
      // The recovery assertions only require delegation to begin.
    },
  })),
)

vi.mock('node:os', () => ({ homedir: () => '/nonexistent/pi-cursor-runtime-recovery-test' }))
vi.mock('@earendil-works/pi-ai/api/openai-completions', () => ({ streamSimple: delegatedStream }))
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
  lifecycle.pushToken.mockReset().mockResolvedValue()
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

    const model: Model<'openai-completions'> = {
      id: 'cursor-test',
      name: 'Cursor Test',
      provider: 'cursor',
      api: 'openai-completions',
      baseUrl: 'http://localhost:4100/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }
    const initialProvider = registrations.at(-1)
    expect(initialProvider?.baseUrl).toBe('http://localhost:4100/v1')
    initialProvider?.streamSimple?.(model, { systemPrompt: '', messages: [], tools: [] }, { apiKey: 'stale-access' })
    await vi.waitFor(() => expect(delegatedStream).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(lifecycle.isProxyHealthy).toHaveBeenCalledWith(4100))

    lifecycle.exitListener?.({ port: 4100, childPid: 41 })
    expect(registrations.at(-1)?.baseUrl).toBe('http://localhost:0/v1')

    lifecycle.connectToProxy.mockResolvedValueOnce({ port: 4200, pid: 42, models: [] })
    initialProvider?.streamSimple?.(model, { systemPrompt: '', messages: [], tools: [] }, { apiKey: 'fresh-access' })

    await vi.waitFor(() => expect(delegatedStream).toHaveBeenCalledTimes(2))
    expect(lifecycle.connectToProxy).toHaveBeenLastCalledWith(expect.any(String), 'fresh-access')
    expect(registrations.at(-1)?.baseUrl).toBe('http://localhost:4200/v1')
    expect(delegatedStream.mock.calls[1]?.[0]).toMatchObject({ baseUrl: 'http://localhost:4200/v1' })

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
    const model: Model<'openai-completions'> = {
      id: 'cursor-test',
      name: 'Cursor Test',
      provider: 'cursor',
      api: 'openai-completions',
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
    const model: Model<'openai-completions'> = {
      id: 'cursor-test',
      name: 'Cursor Test',
      provider: 'cursor',
      api: 'openai-completions',
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
})
