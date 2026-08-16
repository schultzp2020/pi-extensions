import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn<() => boolean>(() => false),
  readFileSync: vi.fn<() => string>(() => '{}'),
  writeFileSync: vi.fn<() => void>(),
  mkdirSync: vi.fn<() => void>(),
  unlinkSync: vi.fn<() => void>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    existsSync: fsMocks.existsSync,
    readFileSync: fsMocks.readFileSync,
    writeFileSync: fsMocks.writeFileSync,
    mkdirSync: fsMocks.mkdirSync,
    unlinkSync: fsMocks.unlinkSync,
  }
})

const spawnMock = vi.hoisted(() => vi.fn<() => unknown>())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, spawn: spawnMock }
})

const logProxyStderrMock = vi.hoisted(() => vi.fn<(sessionId: string, output: string) => void>())

vi.mock('./proxy/debug-logger.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    isDebugLoggingEnabled: () => true,
    logProxyStderr: logProxyStderrMock,
  }
})

import { connectToProxy, stopHeartbeat } from './proxy-lifecycle.ts'
import { logProxyStderr } from './proxy/debug-logger.ts'

const HEARTBEAT_INTERVAL_MS = 10_000
const BOOTSTRAP_SESSION_ID = '00000000-0000-4000-8000-000000000000'
const REAL_SESSION_ID = '11111111-1111-4111-8111-111111111111'

const recorded: { url: string; body: string | null }[] = []

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.href
  }
  return input.url
}

const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Response>((input, init) => {
  const url = requestUrl(input)
  recorded.push({ url, body: typeof init?.body === 'string' ? init.body : null })
  if (url.endsWith('/internal/models')) {
    return { ok: true, json: () => Promise.resolve({ models: [] }) } as Response
  }
  return { ok: true } as Response
})

function heartbeatBodies(): string[] {
  return recorded.filter((entry) => entry.url.endsWith('/internal/heartbeat')).map((entry) => entry.body ?? '')
}

function makeFakeChild(pid: number): {
  child: ChildProcess
  stdout: PassThrough
  stderr: PassThrough
} {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = {
    stdin: new PassThrough(),
    stdout,
    stderr,
    pid,
    unref: vi.fn<() => void>(),
    on: vi.fn<(event: string, listener: (...args: unknown[]) => void) => void>(),
  } as unknown as ChildProcess
  return { child, stdout, stderr }
}

describe('proxy-lifecycle session ID resolution', () => {
  beforeEach(() => {
    // Fake only the timer APIs the heartbeat uses; keep streams and readline on real timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.stubGlobal('fetch', fetchMock)
    fsMocks.existsSync.mockReturnValue(false)
    fsMocks.readFileSync.mockReturnValue('{}')
  })

  afterEach(() => {
    stopHeartbeat()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    recorded.length = 0
  })

  it('sends later heartbeats with the current session ID after reconnecting to an existing proxy', async () => {
    fsMocks.existsSync.mockReturnValue(true)
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ port: 45678, pid: process.pid }))

    let currentId = BOOTSTRAP_SESSION_ID
    const result = await connectToProxy(() => currentId, null)
    expect(result.port).toBe(45678)

    // The immediate heartbeat uses the ID current at connect time (bootstrap).
    expect(heartbeatBodies()).toEqual([JSON.stringify({ sessionId: BOOTSTRAP_SESSION_ID })])

    currentId = REAL_SESSION_ID
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

    expect(heartbeatBodies().at(-1)).toBe(JSON.stringify({ sessionId: REAL_SESSION_ID }))
  })

  it('sends later heartbeats with the current session ID after spawning a proxy', async () => {
    const { child, stdout } = makeFakeChild(4242)
    spawnMock.mockReturnValue(child)

    let currentId = BOOTSTRAP_SESSION_ID
    const pending = connectToProxy(() => currentId, 'access-token')
    stdout.write(`${JSON.stringify({ type: 'ready', port: 45679, models: [] })}\n`)
    const result = await pending
    expect(result.port).toBe(45679)

    currentId = REAL_SESSION_ID
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

    expect(heartbeatBodies().at(-1)).toBe(JSON.stringify({ sessionId: REAL_SESSION_ID }))
  })

  it('logs proxy stderr with the current session ID after it changes', async () => {
    const { child, stdout, stderr } = makeFakeChild(4243)
    spawnMock.mockReturnValue(child)

    let currentId = BOOTSTRAP_SESSION_ID
    const pending = connectToProxy(() => currentId, 'access-token')
    stdout.write(`${JSON.stringify({ type: 'ready', port: 45680, models: [] })}\n`)
    await pending

    currentId = REAL_SESSION_ID
    stderr.write('proxy warning\n')
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })

    expect(logProxyStderr).toHaveBeenCalledWith(REAL_SESSION_ID, 'proxy warning\n')
    expect(logProxyStderr).not.toHaveBeenCalledWith(BOOTSTRAP_SESSION_ID, 'proxy warning\n')
  })
})
