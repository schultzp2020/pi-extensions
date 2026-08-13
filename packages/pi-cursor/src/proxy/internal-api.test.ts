import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { configureInternalApi, handleInternalRequest, startHeartbeatMonitor } from './internal-api.ts'

const START_MS = Date.UTC(2026, 7, 13)
const HEARTBEAT_MONITOR_INTERVAL_MS = 10_000

interface InternalApi {
  configureInternalApi: typeof configureInternalApi
  handleInternalRequest: typeof handleInternalRequest
  startHeartbeatMonitor: typeof startHeartbeatMonitor
}

let internalApi: InternalApi

async function sendHeartbeat(sessionId: string): Promise<void> {
  const stream = new PassThrough()
  const req = Object.assign(stream, { method: 'POST' }) as unknown as IncomingMessage
  const res = {
    writeHead: vi.fn<() => void>(),
    end: vi.fn<() => void>(),
  } as unknown as ServerResponse

  const response = internalApi.handleInternalRequest(req, res, '/internal/heartbeat')
  stream.end(JSON.stringify({ sessionId }))
  await response
}

async function getSessionCount(): Promise<number> {
  const req = Object.assign(new PassThrough(), { method: 'GET' }) as unknown as IncomingMessage
  let responseBody = ''
  const res = {
    writeHead: vi.fn<() => void>(),
    end: vi.fn<(body: string) => void>((body) => {
      responseBody = body
    }),
  } as unknown as ServerResponse

  await internalApi.handleInternalRequest(req, res, '/internal/health')
  return (JSON.parse(responseBody) as { sessions: number }).sessions
}

async function advanceMonitorAfterGap(gapMs: number): Promise<void> {
  vi.setSystemTime(Date.now() + gapMs - HEARTBEAT_MONITOR_INTERVAL_MS)
  await vi.advanceTimersToNextTimerAsync()
}

beforeEach(async () => {
  vi.useFakeTimers({ now: START_MS })
  vi.resetModules()
  internalApi = await import('./internal-api.ts')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('startHeartbeatMonitor', () => {
  it('preserves clients when the monitor resumes after a long suspension', async () => {
    const onShutdown = vi.fn<() => void>()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    internalApi.configureInternalApi({ initialToken: null, initialModels: [], onShutdown })
    await sendHeartbeat('session-a')
    await sendHeartbeat('session-b')
    internalApi.startHeartbeatMonitor()

    await advanceMonitorAfterGap(40_000)

    expect(onShutdown).not.toHaveBeenCalled()
    expect(await getSessionCount()).toBe(2)
    expect(consoleError).toHaveBeenCalledWith(
      '[proxy] Heartbeat monitor resumed after 40000ms; granting active sessions a fresh heartbeat window',
    )
  })

  it('preserves a stale client after a shorter monitor suspension', async () => {
    const onShutdown = vi.fn<() => void>()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    internalApi.configureInternalApi({ initialToken: null, initialModels: [], onShutdown })
    await sendHeartbeat('session-a')
    internalApi.startHeartbeatMonitor()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MONITOR_INTERVAL_MS)

    await advanceMonitorAfterGap(22_000)

    expect(onShutdown).not.toHaveBeenCalled()
    expect(await getSessionCount()).toBe(1)
    expect(consoleError).toHaveBeenCalledWith(
      '[proxy] Heartbeat monitor resumed after 22000ms; granting active sessions a fresh heartbeat window',
    )
  })

  it('shuts down after a long monitor gap when no clients are registered', async () => {
    const onShutdown = vi.fn<() => void>()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    internalApi.configureInternalApi({ initialToken: null, initialModels: [], onShutdown })
    internalApi.startHeartbeatMonitor()

    await advanceMonitorAfterGap(40_000)

    expect(onShutdown).toHaveBeenCalledOnce()
  })

  it('evicts a client after an ordinary heartbeat timeout', async () => {
    const onShutdown = vi.fn<() => void>()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    internalApi.configureInternalApi({ initialToken: null, initialModels: [], onShutdown })
    await sendHeartbeat('session-a')
    internalApi.startHeartbeatMonitor()

    await vi.advanceTimersByTimeAsync(40_000)

    expect(onShutdown).toHaveBeenCalledOnce()
  })

  it('later evicts an orphan that received a resume grace window', async () => {
    const onShutdown = vi.fn<() => void>()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    internalApi.configureInternalApi({ initialToken: null, initialModels: [], onShutdown })
    await sendHeartbeat('session-a')
    internalApi.startHeartbeatMonitor()

    await advanceMonitorAfterGap(40_000)
    expect(onShutdown).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(onShutdown).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10_000)

    expect(onShutdown).toHaveBeenCalledOnce()
  })
})
