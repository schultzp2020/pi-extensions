import type * as ChildProcessModule from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type * as DebugLoggerModule from './proxy/debug-logger.ts'

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

const spawnMock = vi.hoisted(() => vi.fn<SpawnFn>())

// The real spawn, captured by the child_process mock factory so the
// real-child test can delegate to it.
const realSpawnRef = vi.hoisted(() => ({ current: null as SpawnFn | null }))

// Captured at module load, before any fake-timer activation, so tests can
// schedule real-time bounds while timers are faked. The fake clearTimeout
// must never see a real timer handle, so both functions are captured.
const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  realSpawnRef.current = actual.spawn
  return { ...actual, spawn: spawnMock }
})

const logProxyStderrMock = vi.hoisted(() => vi.fn<(sessionId: string, output: string) => void>())

vi.mock('./proxy/debug-logger.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof DebugLoggerModule>()
  return {
    ...actual,
    isDebugLoggingEnabled: () => true,
    logProxyStderr: logProxyStderrMock,
  }
})

import {
  connectToProxy,
  getActivePort,
  isProxyHealthy,
  onProxyExit,
  pushToken,
  stopHeartbeat,
} from './proxy-lifecycle.ts'
import { removeOwnedProxyPortFileWithLock } from './proxy-port-file.ts'
import { logProxyStderr } from './proxy/debug-logger.ts'

const HEARTBEAT_INTERVAL_MS = 10_000
const PROXY_STARTUP_TIMEOUT_MS = 15_000
const STDERR_DRAIN_TIMEOUT_MS = 1_000
const SIGTERM_GRACE_MS = 1_000
const SIGKILL_WAIT_MS = 250
const BOOTSTRAP_SESSION_ID = '00000000-0000-4000-8000-000000000000'
const REAL_SESSION_ID = '11111111-1111-4111-8111-111111111111'
const SIGTERM_RESISTANT_FIXTURE = resolve(import.meta.dirname, 'test-fixtures', 'sigterm-resistant-child.js')
// Real-time deadline for observing the real-child startup promise. Stacked
// on the 5 s boot deadline and the 5 s exit bound, the worst-case cleanup
// path stays below Vitest's 20 s test timeout while the deadline still sits
// far above the real settlement time.
const REAL_PENDING_DEADLINE_MS = 8_000

const recorded: { url: string; body: string | null }[] = []

let testTempDir = ''

beforeEach(() => {
  testTempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-unit-'))
})

afterEach(() => {
  rmSync(testTempDir, { recursive: true, force: true })
})

function connectToTestProxy(
  sessionId: string | (() => string),
  accessToken: string | null,
): ReturnType<typeof connectToProxy> {
  return connectToProxy(sessionId, accessToken, {
    portFilePath: join(testTempDir, 'cursor-proxy.json'),
    lifecycleFilePath: join(testTempDir, 'cursor-proxy-lifecycle.json'),
  })
}

function expectTestPortUnpublished(): void {
  expect(existsSync(join(testTempDir, 'cursor-proxy.json'))).toBeFalsy()
}

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

// Bounded real-time exit wait for a real child. Uses the real timer
// functions captured before fake-timer activation; resolves false when the
// deadline passes without an observed exit.
function awaitRealExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve) => {
    let settled = false
    const onExit = (): void => {
      settle(true)
    }
    const timer = realSetTimeout(() => {
      settle(false)
    }, timeoutMs)
    const settle = (confirmed: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      realClearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(confirmed)
    }
    child.once('exit', onExit)
  })
}

// Bounds an awaited observation with a rejecting real-time deadline. A raw
// await would hang until Vitest's wrapper timeout rejects the test without
// unwinding the test callback, so a defensive finally would never run and a
// stalled observation could leak its child. The deadline timer uses the
// real timer functions, clears itself when either side settles, and stays
// unref'd so it cannot retain the test process.
function withRealDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = realSetTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      reject(new Error(`${label} did not settle within ${String(timeoutMs)} ms`))
    }, timeoutMs)
    timer.unref()
    const settle = (deliver: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      realClearTimeout(timer)
      deliver()
    }
    void promise.then((value) => settle(() => resolve(value))).catch((error) => settle(() => reject(error)))
  })
}

function makeFakeChild(pid: number): {
  child: ChildProcess
  events: EventEmitter
  stdout: PassThrough
  stderr: PassThrough
  killMock: Mock<(signal?: NodeJS.Signals) => boolean>
  unrefMock: Mock<() => void>
} {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  // Real EventEmitter semantics: registration, removal, and listenerCount
  // behave like a real ChildProcess, so tests can verify listener cleanup.
  // oxlint-disable-next-line unicorn/prefer-event-target -- ChildProcess extends EventEmitter; the fake must mirror on/removeListener
  const events = new EventEmitter()
  const killMock = vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true)
  const unrefMock = vi.fn<() => void>(() => {})
  const child = {
    stdin: new PassThrough(),
    stdout,
    stderr,
    pid,
    exitCode: null,
    signalCode: null,
    unref: unrefMock,
    kill: killMock,
    on: events.on.bind(events),
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
  } as unknown as ChildProcess
  return { child, events, stdout, stderr, killMock, unrefMock }
}

function mockFakeChildSpawn(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolveSpawned) => {
    spawnMock.mockImplementation(() => {
      resolveSpawned()
      return child
    })
  })
}

describe('proxy-lifecycle session ID resolution', () => {
  beforeEach(() => {
    // Fake only the timer APIs the heartbeat uses; keep streams and readline on real timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    stopHeartbeat()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    recorded.length = 0
  })

  it('sends later heartbeats with the current session ID after reconnecting to an existing proxy', async () => {
    writeFileSync(
      join(testTempDir, 'cursor-proxy.json'),
      JSON.stringify({ port: 45678, pid: process.pid, generation: new Date().toISOString() }),
    )

    let currentId = BOOTSTRAP_SESSION_ID
    const result = await connectToTestProxy(() => currentId, null)
    expect(result.port).toBe(45678)

    // The immediate heartbeat uses the ID current at connect time (bootstrap).
    expect(heartbeatBodies()).toEqual([JSON.stringify({ sessionId: BOOTSTRAP_SESSION_ID })])

    currentId = REAL_SESSION_ID
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

    expect(heartbeatBodies().at(-1)).toBe(JSON.stringify({ sessionId: REAL_SESSION_ID }))
  })

  it('sends later heartbeats with the current session ID after spawning a proxy', async () => {
    const { child, stdout } = makeFakeChild(process.pid)
    const spawned = mockFakeChildSpawn(child)

    let currentId = BOOTSTRAP_SESSION_ID
    const pending = connectToTestProxy(() => currentId, 'access-token')
    await spawned
    stdout.write(`${JSON.stringify({ type: 'ready', port: 45679, models: [] })}\n`)
    const result = await pending
    expect(result.port).toBe(45679)

    currentId = REAL_SESSION_ID
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

    expect(heartbeatBodies().at(-1)).toBe(JSON.stringify({ sessionId: REAL_SESSION_ID }))
  })

  it('logs proxy stderr with the current session ID after it changes', async () => {
    const { child, stdout, stderr } = makeFakeChild(process.pid)
    const spawned = mockFakeChildSpawn(child)

    let currentId = BOOTSTRAP_SESSION_ID
    const pending = connectToTestProxy(() => currentId, 'access-token')
    await spawned
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

describe('proxy-lifecycle startup failures', () => {
  beforeEach(() => {
    // Fake only the timer APIs the startup path uses; keep stream events on the real loop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    stopHeartbeat()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    recorded.length = 0
  })

  it('includes stderr that Node delivers after the child exit event in the startup error', async () => {
    const { child, stderr, events } = makeFakeChild(4244)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    // Keep the eventual rejection handled while the deferred stderr arrives.
    void pending.catch(() => {})
    await spawned
    // The child exits first; the final stderr data reaches the parent later,
    // after the exit event's microtasks ran (real child-process ordering).
    events.emit('exit', 1, null)
    setImmediate(() => {
      stderr.write('[proxy] accessToken is required\n')
      stderr.end()
    })

    await expect(pending).rejects.toThrow('Proxy exited with code 1\nProxy stderr:\n[proxy] accessToken is required')
  })

  it('escalates a timed-out child that never exits from SIGTERM to SIGKILL and disposes every resource', async () => {
    const { child, stdout, stderr, events, killMock, unrefMock } = makeFakeChild(4245)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    // Keep the eventual rejection handled while the timers advance.
    void pending.catch(() => {})
    await spawned
    await vi.advanceTimersByTimeAsync(PROXY_STARTUP_TIMEOUT_MS)
    // The hung child writes diagnostics but never exits and never ends stderr.
    stderr.write('[proxy] accessToken is required\n')
    await vi.advanceTimersByTimeAsync(STDERR_DRAIN_TIMEOUT_MS + SIGKILL_WAIT_MS)

    await expect(pending).rejects.toThrow('Proxy startup timeout\nProxy stderr:\n[proxy] accessToken is required')
    // One SIGTERM when the timeout fires, one SIGKILL after the grace deadline.
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
    // Every pipe wrapper is disposed and the child cannot retain the loop.
    expect(child.stdin?.destroyed).toBeTruthy()
    expect(stdout.destroyed).toBeTruthy()
    expect(stderr.destroyed).toBeTruthy()
    expect(unrefMock).toHaveBeenCalledTimes(1)
    // Termination was never confirmed, so the persistent error sink must
    // stay attached: the child can still emit errors.
    expect(events.listenerCount('error')).toBe(1)
  })

  it('waits the full SIGTERM grace after stderr ends before escalating a child that never exits', async () => {
    const { child, stdout, stderr, killMock, unrefMock } = makeFakeChild(4246)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    // Keep the eventual rejection handled while the stream ends.
    void pending.catch(() => {})
    await spawned
    await vi.advanceTimersByTimeAsync(PROXY_STARTUP_TIMEOUT_MS)
    // The killed child flushes final diagnostics and closes stderr, but it
    // never exits. Stderr completion settles the drain early; it must not
    // shorten the process grace, so no SIGKILL can land yet.
    stderr.write('[proxy] accessToken is required\n')
    stderr.end()
    await vi.advanceTimersByTimeAsync(STDERR_DRAIN_TIMEOUT_MS / 2)
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM'])
    // The full grace expires without an exit; cleanup escalates once and
    // bounds the post-SIGKILL wait.
    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS / 2 + SIGKILL_WAIT_MS)

    await expect(pending).rejects.toThrow('Proxy startup timeout\nProxy stderr:\n[proxy] accessToken is required')
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
    expect(unrefMock).toHaveBeenCalledTimes(1)
    expect(stdout.destroyed).toBeTruthy()
  })

  it('never escalates a SIGTERM-responsive child that closes stderr before it exits', async () => {
    const { child, stderr, events, killMock, unrefMock } = makeFakeChild(4255)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    await spawned
    await vi.advanceTimersByTimeAsync(PROXY_STARTUP_TIMEOUT_MS)
    // The responsive child closes its stderr immediately but exits only
    // later, inside the grace window. Stderr completion must never trigger
    // an early SIGKILL against a child that is still shutting down.
    stderr.write('[proxy] shutting down\n')
    stderr.end()
    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS / 2)
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM'])
    events.emit('exit', null, 'SIGTERM')

    await expect(pending).rejects.toThrow('Proxy startup timeout\nProxy stderr:\n[proxy] shutting down')
    // The child exited within the grace window: SIGTERM only, termination
    // confirmed, no SIGKILL and no unref safety needed.
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM'])
    expect(unrefMock).not.toHaveBeenCalled()
    expectTestPortUnpublished()
    expect(heartbeatBodies()).toEqual([])
  })

  it('cleans up a still-live child when the ready payload is invalid', async () => {
    const { child, stdout, stderr, killMock, unrefMock } = makeFakeChild(4252)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    await spawned
    stdout.write(`${JSON.stringify({ type: 'nope', port: 45684, models: [] })}\n`)
    // The child stays live and its stderr never ends: cleanup escalates.
    await vi.advanceTimersByTimeAsync(STDERR_DRAIN_TIMEOUT_MS + SIGKILL_WAIT_MS)

    await expect(pending).rejects.toThrow('Unexpected proxy output')
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
    expect(stdout.destroyed).toBeTruthy()
    expect(stderr.destroyed).toBeTruthy()
    expect(unrefMock).toHaveBeenCalledTimes(1)
  })

  it('cleans up a still-live child when the ready line is malformed JSON', async () => {
    const { child, stdout, killMock } = makeFakeChild(4254)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    await spawned
    stdout.write('{oops}\n')
    await vi.advanceTimersByTimeAsync(STDERR_DRAIN_TIMEOUT_MS + SIGKILL_WAIT_MS)

    await expect(pending).rejects.toThrow(/JSON/)
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('fails a bounded startup when the child errors without exiting, like a failed spawn', async () => {
    const { child, stdout, stderr, events, killMock, unrefMock } = makeFakeChild(4256)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    await spawned
    // A spawn failure emits 'error' and then 'close', never 'exit'. The
    // error must claim the startup failure instead of crashing the parent.
    events.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }))
    events.emit('close', null, null)
    // The failed spawn closed its pipes; the drain settles through the
    // stream end without any timer advance.
    stderr.end()

    const failure = (await pending.catch((error: Error) => error)) as Error & { cause?: unknown }
    // The original error message is preserved and the original error object
    // travels as the startup cause.
    expect(failure.message).toBe('Proxy process error: spawn node ENOENT')
    expect((failure.cause as Error).message).toBe('spawn node ENOENT')
    // The errored child never started, so cleanup signals nothing and still
    // confirms termination without the unref safety.
    expect(killMock).not.toHaveBeenCalled()
    expect(unrefMock).not.toHaveBeenCalled()
    expect(child.stdin?.destroyed).toBeTruthy()
    expect(stdout.destroyed).toBeTruthy()
    expect(stderr.destroyed).toBeTruthy()
    expect(events.listenerCount('error')).toBe(0)
    expectTestPortUnpublished()
    expect(heartbeatBodies()).toEqual([])
  })

  it('keeps a kill error during termination handled without restarting or extending cleanup', async () => {
    const { child, stdout, stderr, events, killMock, unrefMock } = makeFakeChild(4257)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    await spawned
    await vi.advanceTimersByTimeAsync(PROXY_STARTUP_TIMEOUT_MS)
    // The SIGTERM delivery fails while the grace window is still running.
    // The persistent error sink must swallow the event; it must not claim a
    // second failure or confirm termination.
    events.emit('error', new Error('kill failed'))
    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS + SIGKILL_WAIT_MS)

    const failure = (await pending.catch((error: Error) => error)) as Error
    expect(failure.message).toBe('Proxy startup timeout')
    // The kill error did not shorten the grace or skip the escalation.
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
    expect(unrefMock).toHaveBeenCalledTimes(1)
    // Termination was never confirmed, so the error sink stays attached.
    expect(events.listenerCount('error')).toBe(1)
    expect(stdout.destroyed).toBeTruthy()
    expect(stderr.destroyed).toBeTruthy()
    expectTestPortUnpublished()
    expect(heartbeatBodies()).toEqual([])
  })

  it('captures final stderr that arrives after the post-SIGKILL exit event', async () => {
    const { child, stderr, events, killMock } = makeFakeChild(4258)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    await spawned
    await vi.advanceTimersByTimeAsync(PROXY_STARTUP_TIMEOUT_MS)
    // The child ignores SIGTERM and keeps stderr open, so the initial drain
    // and the grace both expire before the escalation.
    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS)
    // The killed child exits inside the post-kill window, but its final
    // stderr data and close arrive after the exit event. Exit alone must
    // not end the stderr capture.
    events.emit('exit', null, 'SIGKILL')
    stderr.write('[proxy] final diagnostics\n')
    stderr.end()

    await expect(pending).rejects.toThrow('Proxy startup timeout\nProxy stderr:\n[proxy] final diagnostics')
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('bounds the post-SIGKILL stderr drain when the killed child exits but stderr never closes', async () => {
    const { child, stderr, events, killMock, unrefMock } = makeFakeChild(4259)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    await spawned
    await vi.advanceTimersByTimeAsync(PROXY_STARTUP_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS)
    // The child exits inside the post-kill window but its stderr never
    // ends: the shared post-kill deadline, not stderr completion, bounds
    // the cleanup.
    events.emit('exit', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(SIGKILL_WAIT_MS)

    await expect(pending).rejects.toThrow('Proxy startup timeout')
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
    // The exit was observed, so no unref safety is needed.
    expect(unrefMock).not.toHaveBeenCalled()
    // Destruction runs after disposal; the retained final sink leaves once
    // close proves the queued destruction events completed.
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    expect(stderr.listenerCount('error')).toBe(0)
    expect(stderr.listenerCount('close')).toBe(0)
    expect(stderr.listenerCount('data')).toBe(0)
    expect(stderr.listenerCount('end')).toBe(0)
  })

  it('keeps a stderr error queued across the exit event handled through cleanup', async () => {
    const { child, stderr, events, killMock, unrefMock } = makeFakeChild(4260)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    await spawned
    await vi.advanceTimersByTimeAsync(PROXY_STARTUP_TIMEOUT_MS)
    // The SIGTERM-responsive child exits inside the grace window and its
    // stderr transport fails in the same turn: destroy(error) queues the
    // 'error' and 'close' emissions for the next ticks while cleanup still
    // has to finish and dispose. Nothing may crash and nothing may stay
    // attached afterward.
    events.emit('exit', null, 'SIGTERM')
    stderr.destroy(new Error('stderr transport failed'))

    await expect(pending).rejects.toThrow('Proxy startup timeout')
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM'])
    expect(unrefMock).not.toHaveBeenCalled()
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    expect(stderr.listenerCount('error')).toBe(0)
    expect(stderr.listenerCount('close')).toBe(0)
    expect(stderr.listenerCount('data')).toBe(0)
    expect(stderr.listenerCount('end')).toBe(0)
  })
})

describe('proxy-lifecycle startup terminal state', () => {
  beforeEach(() => {
    // Fake only the timer APIs the startup path uses; keep stream events on the real loop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    stopHeartbeat()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    recorded.length = 0
  })

  it('rejects a ready line that arrives after the child exited, without publishing the proxy', async () => {
    const { child, stdout, stderr, events } = makeFakeChild(4247)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    // Keep the eventual rejection handled while the buffered ready line arrives.
    void pending.catch(() => {})
    await spawned
    events.emit('exit', 1, null)
    // Buffered stdout still reaches the parent while stderr drains; the exit
    // already claimed the terminal state, so the ready line changes nothing.
    stdout.write(`${JSON.stringify({ type: 'ready', port: 45681, models: [] })}\n`)
    stderr.end()

    await expect(pending).rejects.toThrow('Proxy exited with code 1')
    expectTestPortUnpublished()
    expect(heartbeatBodies()).toEqual([])
  })

  it('rejects a ready line that arrives after the startup timeout, killing the child once', async () => {
    const { child, stdout, stderr, events, killMock } = makeFakeChild(4248)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    await spawned
    await vi.advanceTimersByTimeAsync(PROXY_STARTUP_TIMEOUT_MS)
    // The killed child's buffered ready line arrives while stderr drains.
    stdout.write(`${JSON.stringify({ type: 'ready', port: 45682, models: [] })}\n`)
    // The kill makes the child exit; the startup already detached that
    // listener, so the exit event adds no second failure path.
    events.emit('exit', null, 'SIGTERM')
    stderr.end()

    await expect(pending).rejects.toThrow('Proxy startup timeout')
    expect(killMock).toHaveBeenCalledTimes(1)
    expect(killMock.mock.calls[0]?.[0]).toBe('SIGTERM')
    expectTestPortUnpublished()
    expect(heartbeatBodies()).toEqual([])
  })

  it('starts one drain, keeps one kill, and skips SIGKILL when the timeout and the resulting exit interleave', async () => {
    const { child, stderr, events, killMock, unrefMock } = makeFakeChild(4249)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    await spawned
    await vi.advanceTimersByTimeAsync(PROXY_STARTUP_TIMEOUT_MS)

    // Exactly one drain runs: the capture's persistent end listener plus one
    // transient drain listener. A second drain would add another listener.
    expect(stderr.listenerCount('end')).toBe(2)
    // The startup exit listener was detached when the timeout claimed the
    // outcome. Cleanup keeps its own exit watcher alive, and the concurrent
    // grace wait adds one more so termination is observed during the window.
    expect(events.listenerCount('exit')).toBe(2)
    events.emit('exit', null, 'SIGTERM')
    // The observed exit does not start a second drain or a second failure.
    expect(stderr.listenerCount('end')).toBe(2)

    stderr.end()
    await expect(pending).rejects.toThrow('Proxy startup timeout')
    // The child exited during the grace window: cleanup sent SIGTERM only,
    // never escalated to SIGKILL, and confirmed termination, so it did not
    // need the unref safety either. Disposal removes every listener.
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM'])
    expect(unrefMock).not.toHaveBeenCalled()
    expect(events.listenerCount('exit')).toBe(0)
    expect(events.listenerCount('close')).toBe(0)
    expect(stderr.listenerCount('end')).toBe(0)
  })

  it('replaces the startup exit listener with the post-ready lifecycle listener', async () => {
    const { child, stdout, events } = makeFakeChild(process.pid)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    await spawned
    expect(events.listenerCount('exit')).toBe(1)

    stdout.write(`${JSON.stringify({ type: 'ready', port: 45683, models: [] })}\n`)
    const result = await pending

    expect(result.port).toBe(45683)
    expect(events.listenerCount('exit')).toBe(1)
  })

  it('keeps the stderr capture attached after a successful startup', async () => {
    const { child, stdout, stderr } = makeFakeChild(process.pid)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    await spawned
    stdout.write(`${JSON.stringify({ type: 'ready', port: 45685, models: [] })}\n`)
    const result = await pending

    expect(result.port).toBe(45685)
    // The capture keeps its persistent listeners so post-startup stderr
    // still flows to the debug logger; only failed startups dispose it.
    expect(stderr.listenerCount('data')).toBe(1)
    expect(stderr.listenerCount('error')).toBe(1)
  })

  it('bounds the startup error when the stderr stream itself fails', async () => {
    const { child, stderr } = makeFakeChild(4251)
    const spawned = mockFakeChildSpawn(child)

    const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    await spawned
    // The transport fails before any ready line. The queued error must stay
    // handled, and the startup must still fail within its deadlines: the
    // early drain settlement must not shorten the grace of the still-live
    // child, so the advance must cover grace plus the post-SIGKILL wait.
    stderr.destroy(new Error('stderr transport failed'))
    await vi.advanceTimersByTimeAsync(PROXY_STARTUP_TIMEOUT_MS + SIGTERM_GRACE_MS + SIGKILL_WAIT_MS)

    await expect(pending).rejects.toThrow('Proxy startup timeout')
  })
})

describe('proxy-lifecycle real-child startup cleanup', () => {
  beforeEach(() => {
    // Fake only the timer APIs the startup path uses; the real child, its
    // pipes, and its signals all run on the real event loop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    stopHeartbeat()
    spawnMock.mockReset()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    recorded.length = 0
  })

  // Windows collapses Unix signal distinctions in ChildProcess.kill, so the
  // initial SIGTERM can terminate the fixture and the expected
  // SIGTERM-then-SIGKILL sequence becomes unobservable there. Only this
  // real-fixture test is skipped; the fake-child escalation tests cover
  // the policy on every platform.
  it.skipIf(process.platform === 'win32')(
    'forcibly terminates a real child that ignores SIGTERM and keeps stderr open',
    async () => {
      const spawnReal = realSpawnRef.current
      if (spawnReal === null) {
        throw new Error('the child_process mock did not capture the real spawn')
      }
      const kills: string[] = []
      let baselineExitListeners = 0
      let baselineErrorListeners = 0
      // The spawn mock resolves this promise synchronously while
      // connectToProxy spawns, so the test gets a properly typed real child.
      const spawnedPromise = new Promise<ChildProcess>((resolveSpawned) => {
        spawnMock.mockImplementation((_command, _args, options) => {
          // Delegate to the real spawn but point it at the fixture instead of
          // the proxy entrypoint; production keeps its own stdio handling.
          const spawned = spawnReal('node', [SIGTERM_RESISTANT_FIXTURE], options)
          baselineExitListeners = spawned.listenerCount('exit')
          baselineErrorListeners = spawned.listenerCount('error')
          const originalKill = spawned.kill.bind(spawned)
          spawned.kill = (signal?: NodeJS.Signals | number): boolean => {
            kills.push(String(signal ?? 'SIGTERM'))
            return originalKill(signal)
          }
          resolveSpawned(spawned)
          return spawned
        })
      })

      const pending = connectToTestProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
      // Keep the eventual rejection handled while the fixture boots.
      void pending.catch(() => {})

      const spawned = await spawnedPromise
      // Defensive scope starts immediately after the child handle arrives:
      // every path below funnels into a finally that bounds the child's
      // lifetime even when an assertion fails or exit observation stalls.
      let cleanupFailure = false
      try {
        // The fixture installs its SIGTERM handler before it announces itself
        // on stderr, so once stderr arrives the test knows SIGTERM will be
        // ignored. The deadline keeps the wait bounded on the real loop.
        const announced = new Promise<void>((resolve) => {
          spawned.stderr?.once('data', resolve)
        })
        const bootDeadline = new Promise<void>((resolve) => {
          realSetTimeout(resolve, 5_000).unref()
        })
        await Promise.race([announced, bootDeadline])

        // Startup timeout fires (fake time): SIGTERM is ignored, the drain and
        // the independent grace expire with stderr still open, then SIGKILL
        // lands.
        await vi.advanceTimersByTimeAsync(PROXY_STARTUP_TIMEOUT_MS + SIGTERM_GRACE_MS + SIGKILL_WAIT_MS)
        // The rejection is observed through a local real-time deadline: a
        // stalled pending would otherwise hang until Vitest's 20 s wrapper
        // timeout, which rejects its own wrapper without unwinding this
        // callback, so the finally below would never run and the child
        // would leak. The deadline makes the failure local and bounded.
        await expect(withRealDeadline(pending, REAL_PENDING_DEADLINE_MS, 'real-child proxy startup')).rejects.toThrow(
          'Proxy startup timeout',
        )

        // Exactly one SIGTERM, then exactly one SIGKILL because the fixture
        // never exited during the grace window. Forced termination is
        // confirmed through the child's own exit, raced against a real-time
        // deadline shorter than the test timeout.
        expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
        expect(await awaitRealExit(spawned, 5_000)).toBeTruthy()
        expect(spawned.signalCode).toBe('SIGKILL')
        // Pipe wrappers are disposed and capture listeners removed, so the
        // failed startup cannot retain the test process through any handle.
        // Confirmed termination also removes the persistent error sink.
        expect(spawned.stdout?.destroyed).toBeTruthy()
        expect(spawned.stderr?.destroyed).toBeTruthy()
        expect(spawned.stderr?.listenerCount('data')).toBe(0)
        expect(spawned.listenerCount('exit')).toBe(baselineExitListeners)
        // The error sink is removed only when termination was confirmed before
        // disposal. Whether the real exit lands inside the bounded 250 ms
        // post-SIGKILL window is a real-time race, so both contract states are
        // valid here; the fake-child tests pin each one deterministically.
        expect([baselineErrorListeners, baselineErrorListeners + 1]).toContain(spawned.listenerCount('error'))
      } finally {
        // Defensive cleanup: a failed assertion must not leak the child. Kill
        // errors are caught; a bounded real-time exit wait decides whether the
        // cleanup succeeded, so no path can wait indefinitely.
        if (spawned.exitCode === null && spawned.signalCode === null) {
          try {
            spawned.kill('SIGKILL')
          } catch {
            // The kill can fail when the child is already gone; the bounded
            // exit wait below decides what to do.
          }
          const confirmed = await awaitRealExit(spawned, 5_000)
          if (!confirmed) {
            // Exit observation stalled: destroy every pipe and drop the
            // handle's event-loop reference; the failure is reported after
            // the finally instead of thrown from it.
            spawned.stdin?.destroy()
            spawned.stdout?.destroy()
            spawned.stderr?.destroy()
            spawned.unref()
            cleanupFailure = true
          }
        }
      }
      if (cleanupFailure) {
        throw new Error('real-child cleanup failed: exit was never observed')
      }
    },
    20_000,
  )
})

describe('real-time observation deadline', () => {
  it('rejects a stalled observation promptly instead of hanging until the test timeout', async () => {
    const neverSettles = new Promise<string>(() => {})
    const startedAt = Date.now()

    await expect(withRealDeadline(neverSettles, 25, 'stalled observation')).rejects.toThrow(
      'stalled observation did not settle within 25 ms',
    )
    // The local deadline must reject far below Vitest's 20 s test timeout.
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('passes a settled observation through unchanged in both directions', async () => {
    await expect(withRealDeadline(Promise.resolve('value'), 25, 'observation')).resolves.toBe('value')
    await expect(withRealDeadline(Promise.reject(new Error('inner failure')), 25, 'observation')).rejects.toThrow(
      'inner failure',
    )
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error('Timed out waiting for proxy lifecycle state')
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10)
    })
  }
}

async function waitForProxyUnreachable(port: number, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (await isProxyHealthy(port)) {
    if (performance.now() >= deadline) {
      throw new Error('Timed out waiting for proxy to become unreachable')
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10)
    })
  }
}

describe('pushToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not fetch when the caller signal is already aborted', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    const delivered = await pushToken(3456, 'token', controller.signal)
    expect(delivered).toBeFalsy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('combines the caller signal with the push timeout', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({ ok: true } as Response)
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const delivered = await pushToken(3456, 'token', controller.signal)

    expect(delivered).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBeFalsy()
  })

  it('reports an unreachable token endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection lost'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(pushToken(3456, 'token')).resolves.toBeFalsy()
  })
})

describe('post-ready child exit recovery', () => {
  beforeEach(() => {
    const realSpawn = realSpawnRef.current
    if (!realSpawn) {
      throw new Error('test mocks did not capture the real Node modules')
    }
    spawnMock.mockImplementation(realSpawn)
  })

  it('publishes one replacement across concurrent module instances', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-shared-reconnect-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyLockPath = `${portFilePath}.lock`
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const childPids = new Set<number>()
    let stopAlternateHeartbeat: (() => void) | undefined

    try {
      writeFileSync(proxyLockPath, '')
      utimesSync(proxyLockPath, new Date(0), new Date(0))
      vi.resetModules()
      const alternateLifecycle = await import('./proxy-lifecycle.ts')
      stopAlternateHeartbeat = alternateLifecycle.stopHeartbeat
      const [first, second] = await Promise.all([
        connectToProxy('first-session', 'first-secret', { portFilePath, lifecycleFilePath, proxyEntry }),
        alternateLifecycle.connectToProxy('second-session', 'second-secret', {
          portFilePath,
          lifecycleFilePath,
          proxyEntry,
        }),
      ])
      childPids.add(first.pid)
      childPids.add(second.pid)

      expect(second).toMatchObject({ port: first.port, pid: first.pid })
      expect(JSON.parse(readFileSync(portFilePath, 'utf8'))).toEqual({
        port: first.port,
        pid: first.pid,
        generation: first.generation,
      })
    } finally {
      stopHeartbeat()
      stopAlternateHeartbeat?.()
      for (const pid of childPids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      await waitFor(() =>
        [...childPids].every((pid) => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }),
      )
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('waits for an earlier chooser to publish its lock ticket', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-choosing-lock-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyLockPath = `${portFilePath}.lock`
    const choosingPath = join(proxyLockPath, 'paused-owner.choosing')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    let childPid: number | undefined

    try {
      mkdirSync(proxyLockPath)
      writeFileSync(
        choosingPath,
        JSON.stringify({ ownerPid: process.pid, ownerId: 'paused-owner', acquiredAt: Date.now() }),
      )
      const connectionPromise = connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      const state = await Promise.race([
        connectionPromise.then(() => 'connected' as const),
        new Promise<'waiting'>((resolve) => {
          setTimeout(() => resolve('waiting'), 250)
        }),
      ])
      expect(state).toBe('waiting')
      expect(existsSync(portFilePath)).toBeFalsy()

      unlinkSync(choosingPath)
      const connection = await connectionPromise
      childPid = connection.pid
      expect(JSON.parse(readFileSync(portFilePath, 'utf8'))).toMatchObject({ pid: connection.pid })
    } finally {
      stopHeartbeat()
      if (childPid !== undefined) {
        const pid = childPid
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
        await waitFor(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        })
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('releases a queued recovery when its cancellation signal aborts', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-cancelled-lock-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyLockPath = `${portFilePath}.lock`
    const choosingPath = join(proxyLockPath, 'blocking-owner.choosing')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const controller = new AbortController()

    try {
      mkdirSync(proxyLockPath)
      writeFileSync(
        choosingPath,
        JSON.stringify({ ownerPid: process.pid, ownerId: 'blocking-owner', acquiredAt: Date.now() }),
      )
      const connection = connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
        signal: controller.signal,
      })
      await Promise.resolve()

      controller.abort()

      // Cancellation may surface either the lock wait or AbortSignal error, depending on timing.
      // oxlint-disable-next-line vitest/require-to-throw-message
      await expect(connection).rejects.toThrow()
      expect(existsSync(portFilePath)).toBeFalsy()
    } finally {
      try {
        unlinkSync(choosingPath)
      } catch {}
      stopHeartbeat()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects adoption when a proxy begins shutting down during the shared handshake', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-shutdown-handshake-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const generation = new Date().toISOString()
    let healthChecks = 0
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/internal/health')) {
        healthChecks += 1
        return Promise.resolve(
          new Response(JSON.stringify({ status: healthChecks === 1 ? 'ok' : 'shutting-down' }), {
            status: healthChecks === 1 ? 200 : 503,
          }),
        )
      }
      if (url.endsWith('/internal/heartbeat')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      }
      if (url.endsWith('/internal/models')) {
        return Promise.resolve(new Response(JSON.stringify({ models: [] }), { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      writeFileSync(portFilePath, JSON.stringify({ port: 4500, pid: process.pid, generation }))

      await expect(connectToProxy('test-session', null, { portFilePath, lifecycleFilePath })).rejects.toThrow(
        'No access token and no existing proxy',
      )
      expect(healthChecks).toBe(2)
      expect(getActivePort()).toBeNull()
      expect(existsSync(portFilePath)).toBeFalsy()
      const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
      expect(record).toMatchObject({
        childPid: process.pid,
        exitCode: null,
        exitSignal: null,
        restartOutcome: 'failed',
      })
      expect(Date.parse(String(record.timestamp))).toBeGreaterThanOrEqual(Date.parse(generation))
    } finally {
      stopHeartbeat()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('merges an eventual child exit into its failed alive-but-unreachable recovery attempt', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-alive-unreachable-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    let childPid: number | undefined

    try {
      const connection = await connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPid = connection.pid
      await fetch(`http://localhost:${String(connection.port)}/test/disconnect`)
      await waitForProxyUnreachable(connection.port)
      expect(() => process.kill(connection.pid, 0)).not.toThrow()

      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(connection.generation) - 60_000)
      await expect(
        connectToProxy('test-session', null, { portFilePath, lifecycleFilePath, proxyEntry }),
      ).rejects.toThrow('No access token and no existing proxy')
      expect(getActivePort()).toBeNull()
      const observedRecord = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
      expect(observedRecord).toMatchObject({
        generation: connection.generation,
        childPid: connection.pid,
        exitCode: null,
        exitSignal: null,
        restartOutcome: 'failed',
      })
      expect(Date.parse(String(observedRecord.timestamp))).toBeLessThan(Date.parse(connection.generation))

      vi.setSystemTime(Date.parse(connection.generation) - 59_000)
      process.kill(connection.pid, 'SIGKILL')
      await waitFor(() => {
        try {
          const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
          return record.exitSignal === 'SIGKILL' && record.restartOutcome === 'failed'
        } catch {
          return false
        }
      })
      const exitRecord = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
      expect(exitRecord).toMatchObject({
        generation: connection.generation,
        childPid: connection.pid,
        exitCode: null,
        exitSignal: 'SIGKILL',
        restartOutcome: 'failed',
      })
      expect(Date.parse(String(exitRecord.timestamp))).toBeGreaterThanOrEqual(
        Date.parse(String(observedRecord.timestamp)),
      )
    } finally {
      vi.useRealTimers()
      stopHeartbeat()
      if (childPid !== undefined) {
        const pid = childPid
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
        await waitFor(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        })
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('records a failed reconnect against a dead shared proxy identity', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-shared-failure-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const staleChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    })

    try {
      await once(staleChild, 'spawn')
      const childPid = staleChild.pid
      if (childPid === undefined) {
        throw new Error('Stale proxy fixture did not receive a process ID')
      }
      staleChild.kill('SIGKILL')
      await once(staleChild, 'exit')
      writeFileSync(portFilePath, JSON.stringify({ port: 65_535, pid: childPid }))

      await expect(
        connectToProxy('test-session', null, { portFilePath, lifecycleFilePath, proxyEntry }),
      ).rejects.toThrow('No access token and no existing proxy')

      const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
      expect(record).toMatchObject({ childPid, restartOutcome: 'failed' })
    } finally {
      try {
        staleChild.kill('SIGKILL')
      } catch {}
      stopHeartbeat()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('does not inherit a restart outcome when a child PID is reused', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-reused-exit-pid-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const staleChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    })

    try {
      await once(staleChild, 'spawn')
      const childPid = staleChild.pid
      if (childPid === undefined) {
        throw new Error('Stale proxy fixture did not receive a process ID')
      }
      staleChild.kill('SIGKILL')
      await once(staleChild, 'exit')
      const previousGeneration = '2026-01-01T00:00:00.000Z'
      const currentGeneration = '2026-01-02T00:00:00.000Z'
      writeFileSync(
        lifecycleFilePath,
        JSON.stringify({
          timestamp: previousGeneration,
          generation: previousGeneration,
          childPid,
          exitCode: null,
          exitSignal: 'SIGKILL',
          restartOutcome: 'succeeded',
        }),
      )
      writeFileSync(portFilePath, JSON.stringify({ port: 65_535, pid: childPid, generation: currentGeneration }))

      await expect(
        connectToProxy('test-session', null, { portFilePath, lifecycleFilePath, proxyEntry }),
      ).rejects.toThrow('No access token and no existing proxy')

      const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
      expect(record).toMatchObject({
        childPid,
        restartOutcome: 'failed',
      })
      expect(Date.parse(String(record.timestamp))).toBeGreaterThan(Date.parse(currentGeneration))
    } finally {
      try {
        staleChild.kill('SIGKILL')
      } catch {}
      stopHeartbeat()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('allocates a later proxy generation when the wall clock moves backward', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-monotonic-generation-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const childPids: number[] = []
    const exits: number[] = []
    const stopObserving = onProxyExit((event) => exits.push(event.childPid))

    try {
      const first = await connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPids.push(first.pid)
      process.kill(first.pid, 'SIGKILL')
      await waitFor(() => exits.includes(first.pid))
      await waitFor(() => {
        try {
          const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
          return record.childPid === first.pid && record.exitSignal === 'SIGKILL'
        } catch {
          return false
        }
      })
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(first.generation) - 60_000)
      const second = await connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPids.push(second.pid)
      vi.useRealTimers()

      expect(Date.parse(second.generation)).toBeGreaterThan(Date.parse(first.generation))
    } finally {
      vi.useRealTimers()
      stopObserving()
      stopHeartbeat()
      for (const pid of childPids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      await waitFor(() =>
        childPids.every((pid) => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }),
      )
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('persists a later proxy exit when the wall clock moves backward', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-monotonic-observation-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const childPids: number[] = []

    try {
      const first = await connectToProxy('first-session', 'first-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPids.push(first.pid)
      process.kill(first.pid, 'SIGKILL')
      await waitFor(() => {
        try {
          const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
          return record.childPid === first.pid && record.exitSignal === 'SIGKILL'
        } catch {
          return false
        }
      })
      const firstRecord = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>

      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.parse(String(firstRecord.timestamp)) - 60_000)
      const second = await connectToProxy('second-session', 'second-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPids.push(second.pid)
      process.kill(second.pid, 'SIGKILL')
      await waitFor(() => {
        try {
          const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
          return record.childPid === second.pid && record.exitSignal === 'SIGKILL'
        } catch {
          return false
        }
      })
      await expect(
        connectToProxy('second-session', null, { portFilePath, lifecycleFilePath, proxyEntry }),
      ).rejects.toThrow('No access token and no existing proxy')
      const secondRecord = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>

      expect(secondRecord).toMatchObject({
        generation: second.generation,
        childPid: second.pid,
        exitCode: null,
        exitSignal: 'SIGKILL',
        restartOutcome: 'failed',
      })
      expect(Number(secondRecord.observation)).toBeGreaterThan(Number(firstRecord.observation))
      expect(Date.parse(String(secondRecord.timestamp))).toBeLessThan(Date.parse(String(firstRecord.timestamp)))
    } finally {
      vi.useRealTimers()
      stopHeartbeat()
      for (const pid of childPids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      await waitFor(() =>
        childPids.every((pid) => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }),
      )
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('reclaims locks from a different process incarnation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-reused-pid-lock-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyLockPath = `${portFilePath}.lock`
    const lifecycleLockPath = `${lifecycleFilePath}.lock`
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const lockOwner = {
      ownerPid: process.pid,
      ownerId: 'reused-process-owner',
      acquiredAt: Date.now(),
      processIdentity: 'different-process-incarnation',
    }
    let childPid: number | undefined

    try {
      writeFileSync(
        lifecycleFilePath,
        JSON.stringify({
          timestamp: new Date(0).toISOString(),
          generation: new Date(0).toISOString(),
          childPid: 999_999_999,
          exitCode: null,
          exitSignal: 'SIGKILL',
          restartOutcome: 'not-attempted',
        }),
      )
      writeFileSync(proxyLockPath, JSON.stringify(lockOwner))
      writeFileSync(lifecycleLockPath, JSON.stringify(lockOwner))

      const connection = await connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPid = connection.pid

      expect(JSON.parse(readFileSync(lifecycleFilePath, 'utf8'))).toMatchObject({ restartOutcome: 'succeeded' })
      expect(existsSync(proxyLockPath)).toBeFalsy()
      expect(existsSync(lifecycleLockPath)).toBeFalsy()
    } finally {
      stopHeartbeat()
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {}
      }
      try {
        unlinkSync(proxyLockPath)
      } catch {}
      try {
        unlinkSync(lifecycleLockPath)
      } catch {}
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('clears the dead connection, persists exit metadata, and records a successful respawn', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const childPids: number[] = []
    const exits: number[] = []
    const stopObserving = onProxyExit((event) => exits.push(event.childPid))
    let stopRecoveredHeartbeat: (() => void) | undefined

    try {
      const first = await connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPids.push(first.pid)
      expect(getActivePort()).toBe(first.port)

      process.kill(first.pid, 'SIGKILL')
      await waitFor(() => exits.includes(first.pid))

      expect(getActivePort()).toBeNull()
      const exitRecord = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
      expect(exitRecord).toMatchObject({
        childPid: first.pid,
        exitCode: null,
        exitSignal: 'SIGKILL',
        restartOutcome: 'not-attempted',
      })
      expect(typeof exitRecord.timestamp).toBe('string')

      vi.resetModules()
      const recoveringLifecycle = await import('./proxy-lifecycle.ts')
      stopRecoveredHeartbeat = recoveringLifecycle.stopHeartbeat
      await expect(
        recoveringLifecycle.connectToProxy('test-session', null, {
          portFilePath,
          lifecycleFilePath,
          proxyEntry,
        }),
      ).rejects.toThrow('No access token and no existing proxy')
      const failedRecord = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
      expect(failedRecord).toMatchObject({ childPid: first.pid, restartOutcome: 'failed' })

      const second = await recoveringLifecycle.connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPids.push(second.pid)
      expect(second.pid).not.toBe(first.pid)
      expect(recoveringLifecycle.getActivePort()).toBe(second.port)

      const recoveredRecordText = readFileSync(lifecycleFilePath, 'utf8')
      const recoveredRecord = JSON.parse(recoveredRecordText) as Record<string, unknown>
      expect(recoveredRecord).toMatchObject({ childPid: first.pid, restartOutcome: 'succeeded' })
      expect(recoveredRecordText).not.toContain('test-secret')
    } finally {
      stopObserving()
      stopHeartbeat()
      stopRecoveredHeartbeat?.()
      for (const pid of childPids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // The child already exited.
        }
      }
      await waitFor(() =>
        childPids.every((pid) => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }),
      )
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('records success when a live replacement predates exit observation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-replacement-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const replacementPortFilePath = join(tempDir, 'replacement-proxy.json')
    const replacementLifecycleFilePath = join(tempDir, 'replacement-proxy-lifecycle.json')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const childPids: number[] = []
    const exits: number[] = []
    const stopObserving = onProxyExit((event) => exits.push(event.childPid))
    let stopReplacementHeartbeat: (() => void) | undefined

    try {
      const first = await connectToProxy('test-session', 'first-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPids.push(first.pid)

      vi.resetModules()
      const replacementLifecycle = await import('./proxy-lifecycle.ts')
      stopReplacementHeartbeat = replacementLifecycle.stopHeartbeat
      const replacement = await replacementLifecycle.connectToProxy('replacement-session', 'replacement-secret', {
        portFilePath: replacementPortFilePath,
        lifecycleFilePath: replacementLifecycleFilePath,
        proxyEntry,
      })
      childPids.push(replacement.pid)
      writeFileSync(portFilePath, JSON.stringify({ port: replacement.port, pid: replacement.pid }))

      process.kill(first.pid, 'SIGKILL')
      await waitFor(() => exits.includes(first.pid))
      await waitFor(() => {
        try {
          const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
          return record.childPid === first.pid && record.restartOutcome === 'succeeded'
        } catch {
          return false
        }
      })

      const recordText = readFileSync(lifecycleFilePath, 'utf8')
      expect(JSON.parse(recordText)).toMatchObject({ childPid: first.pid, restartOutcome: 'succeeded' })
      expect(recordText).not.toContain('first-secret')
      expect(recordText).not.toContain('replacement-secret')
    } finally {
      stopObserving()
      stopHeartbeat()
      stopReplacementHeartbeat?.()
      for (const pid of childPids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      await waitFor(() =>
        childPids.every((pid) => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }),
      )
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('records the actual latest exit when an older generation outlives its replacement', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-latest-exit-'))
    const firstPortFilePath = join(tempDir, 'first-proxy.json')
    const secondPortFilePath = join(tempDir, 'second-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const childPids: number[] = []

    try {
      const first = await connectToProxy('first-session', 'first-secret', {
        portFilePath: firstPortFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPids.push(first.pid)
      const second = await connectToProxy('second-session', 'second-secret', {
        portFilePath: secondPortFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPids.push(second.pid)
      expect(Date.parse(second.generation)).toBeGreaterThan(Date.parse(first.generation))

      process.kill(second.pid, 'SIGKILL')
      await waitFor(() => {
        try {
          const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
          return record.childPid === second.pid && record.exitSignal === 'SIGKILL'
        } catch {
          return false
        }
      })
      const secondExitTimestamp = String(
        (JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>).timestamp,
      )
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 10)
      })

      process.kill(first.pid, 'SIGKILL')
      await waitFor(() => {
        try {
          const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
          return record.childPid === first.pid && record.exitSignal === 'SIGKILL'
        } catch {
          return false
        }
      })
      const latestRecord = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
      expect(Date.parse(String(latestRecord.timestamp))).toBeGreaterThan(Date.parse(secondExitTimestamp))
    } finally {
      stopHeartbeat()
      for (const pid of childPids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      await waitFor(() =>
        childPids.every((pid) => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }),
      )
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects a ready child that exits before connection completion', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-return-boundary-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const lockFilePath = `${lifecycleFilePath}.lock`
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const exits: number[] = []
    const stopObserving = onProxyExit((event) => exits.push(event.childPid))
    let childPid: number | undefined
    let connectionPromise: ReturnType<typeof connectToProxy> | undefined

    try {
      writeFileSync(
        lifecycleFilePath,
        JSON.stringify({
          timestamp: new Date(0).toISOString(),
          generation: new Date(0).toISOString(),
          childPid: 999_999_999,
          exitCode: null,
          exitSignal: 'SIGKILL',
          restartOutcome: 'not-attempted',
        }),
      )
      writeFileSync(
        lockFilePath,
        JSON.stringify({ ownerPid: process.pid, ownerId: 'return-boundary-owner', acquiredAt: Date.now() }),
      )
      connectionPromise = connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })

      await waitFor(() => {
        try {
          const info = JSON.parse(readFileSync(portFilePath, 'utf8')) as { pid?: unknown }
          if (typeof info.pid !== 'number') {
            return false
          }
          childPid = info.pid
          return true
        } catch {
          return false
        }
      })
      const pid = childPid
      if (pid === undefined) {
        throw new Error('Proxy child did not publish its process ID')
      }
      process.kill(pid, 'SIGKILL')
      await waitFor(() => exits.includes(pid))
      unlinkSync(lockFilePath)

      await expect(connectionPromise).rejects.toThrow('exited before connection completed')
      expect(existsSync(portFilePath)).toBeFalsy()
    } finally {
      stopObserving()
      stopHeartbeat()
      try {
        unlinkSync(lockFilePath)
      } catch {}
      await connectionPromise?.catch(() => undefined)
      if (childPid !== undefined) {
        const pid = childPid
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
        await waitFor(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        })
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('records failure when reconnect fails before exit persistence', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-pending-failure-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const lockFilePath = `${lifecycleFilePath}.lock`
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const exits: number[] = []
    const stopObserving = onProxyExit((event) => exits.push(event.childPid))
    let childPid: number | undefined

    try {
      const connection = await connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPid = connection.pid
      writeFileSync(
        lockFilePath,
        JSON.stringify({ ownerPid: process.pid, ownerId: 'pending-failure-owner', acquiredAt: Date.now() }),
      )
      process.kill(childPid, 'SIGKILL')
      await waitFor(() => exits.includes(connection.pid))

      // Keep the assertion pending while the lifecycle lock deliberately blocks completion.
      // oxlint-disable-next-line vitest/valid-expect
      const failedReconnect = expect(
        connectToProxy('test-session', null, { portFilePath, lifecycleFilePath, proxyEntry }),
      ).rejects.toThrow('No access token and no existing proxy')
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 20)
      })
      unlinkSync(lockFilePath)
      await failedReconnect
      await waitFor(() => {
        try {
          const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
          return record.childPid === connection.pid && record.restartOutcome === 'failed'
        } catch {
          return false
        }
      })
    } finally {
      stopObserving()
      stopHeartbeat()
      try {
        unlinkSync(lockFilePath)
      } catch {}
      if (childPid !== undefined) {
        const pid = childPid
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
        await waitFor(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        })
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('does not evict an aged lifecycle lock owned by a live process', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-live-lock-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const lockFilePath = `${lifecycleFilePath}.lock`
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const exits: number[] = []
    const stopObserving = onProxyExit((event) => exits.push(event.childPid))
    let childPid: number | undefined

    try {
      const connection = await connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPid = connection.pid
      writeFileSync(lockFilePath, JSON.stringify({ ownerPid: process.pid, ownerId: 'live-test-owner', acquiredAt: 1 }))
      utimesSync(lockFilePath, new Date(0), new Date(0))
      process.kill(childPid, 'SIGKILL')
      await waitFor(() => exits.includes(connection.pid))
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 50)
      })

      expect(JSON.parse(readFileSync(lockFilePath, 'utf8'))).toMatchObject({ ownerId: 'live-test-owner' })
      expect(existsSync(lifecycleFilePath)).toBeFalsy()
      unlinkSync(lockFilePath)
      await waitFor(() => {
        try {
          const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
          return record.childPid === connection.pid && record.restartOutcome === 'not-attempted'
        } catch {
          return false
        }
      })
    } finally {
      stopObserving()
      stopHeartbeat()
      try {
        unlinkSync(lockFilePath)
      } catch {}
      if (childPid !== undefined) {
        const pid = childPid
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
        await waitFor(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        })
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('reclaims an orphaned lifecycle lock before persisting a later exit', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-stale-lock-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const lockFilePath = `${lifecycleFilePath}.lock`
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    let childPid: number | undefined

    try {
      const connection = await connectToProxy('test-session', 'test-secret', {
        portFilePath,
        lifecycleFilePath,
        proxyEntry,
      })
      childPid = connection.pid
      writeFileSync(lockFilePath, '')

      process.kill(childPid, 'SIGKILL')
      await waitFor(() => {
        try {
          const record = JSON.parse(readFileSync(lifecycleFilePath, 'utf8')) as Record<string, unknown>
          return record.childPid === childPid && record.restartOutcome === 'not-attempted' && !existsSync(lockFilePath)
        } catch {
          return false
        }
      }, 4_000)

      const recordText = readFileSync(lifecycleFilePath, 'utf8')
      const record = JSON.parse(recordText) as Record<string, unknown>
      expect(Object.keys(record).sort()).toEqual(
        ['timestamp', 'generation', 'observation', 'childPid', 'exitCode', 'exitSignal', 'restartOutcome'].sort(),
      )
      expect(record).toMatchObject({
        childPid,
        exitCode: null,
        exitSignal: 'SIGKILL',
        restartOutcome: 'not-attempted',
      })
      expect(recordText).not.toContain('test-secret')
      expect(existsSync(lockFilePath)).toBeFalsy()
    } finally {
      stopHeartbeat()
      if (childPid !== undefined) {
        const pid = childPid
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
        await waitFor(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        })
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('proxy port ownership', () => {
  it('keeps a replacement discovery record when an older proxy shuts down', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-port-ownership-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const predecessor = { port: 4200, pid: 42, generation: '2026-01-01T00:00:00.000Z' }
    const replacement = { port: 4200, pid: 42, generation: '2026-01-02T00:00:00.000Z' }

    try {
      writeFileSync(portFilePath, JSON.stringify(replacement))

      expect(await removeOwnedProxyPortFileWithLock(portFilePath, predecessor)).toBeFalsy()
      expect(JSON.parse(readFileSync(portFilePath, 'utf8'))).toEqual(replacement)
      expect(await removeOwnedProxyPortFileWithLock(portFilePath, replacement)).toBeTruthy()
      expect(existsSync(portFilePath)).toBeFalsy()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
