import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

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
  const actual = (await importOriginal()) as Record<string, unknown>
  realSpawnRef.current = actual.spawn as SpawnFn
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
    unref: unrefMock,
    kill: killMock,
    on: events.on.bind(events),
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
  } as unknown as ChildProcess
  return { child, events, stdout, stderr, killMock, unrefMock }
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

describe('proxy-lifecycle startup failures', () => {
  beforeEach(() => {
    // Fake only the timer APIs the startup path uses; keep stream events on the real loop.
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

  it('includes stderr that Node delivers after the child exit event in the startup error', async () => {
    const { child, stderr, events } = makeFakeChild(4244)
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    // Keep the eventual rejection handled while the deferred stderr arrives.
    void pending.catch(() => {})
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
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    // Keep the eventual rejection handled while the timers advance.
    void pending.catch(() => {})
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
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    // Keep the eventual rejection handled while the stream ends.
    void pending.catch(() => {})
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
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
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
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled()
    expect(heartbeatBodies()).toEqual([])
  })

  it('cleans up a still-live child when the ready payload is invalid', async () => {
    const { child, stdout, stderr, killMock, unrefMock } = makeFakeChild(4252)
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
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
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
    stdout.write('{oops}\n')
    await vi.advanceTimersByTimeAsync(STDERR_DRAIN_TIMEOUT_MS + SIGKILL_WAIT_MS)

    await expect(pending).rejects.toThrow(/JSON/)
    expect(killMock.mock.calls.map((call) => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('fails a bounded startup when the child errors without exiting, like a failed spawn', async () => {
    const { child, stdout, stderr, events, killMock, unrefMock } = makeFakeChild(4256)
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
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
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled()
    expect(heartbeatBodies()).toEqual([])
  })

  it('keeps a kill error during termination handled without restarting or extending cleanup', async () => {
    const { child, stdout, stderr, events, killMock, unrefMock } = makeFakeChild(4257)
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
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
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled()
    expect(heartbeatBodies()).toEqual([])
  })

  it('captures final stderr that arrives after the post-SIGKILL exit event', async () => {
    const { child, stderr, events, killMock } = makeFakeChild(4258)
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
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
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
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
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
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

  it('rejects a ready line that arrives after the child exited, without publishing the proxy', async () => {
    const { child, stdout, stderr, events } = makeFakeChild(4247)
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    // Keep the eventual rejection handled while the buffered ready line arrives.
    void pending.catch(() => {})
    events.emit('exit', 1, null)
    // Buffered stdout still reaches the parent while stderr drains; the exit
    // already claimed the terminal state, so the ready line changes nothing.
    stdout.write(`${JSON.stringify({ type: 'ready', port: 45681, models: [] })}\n`)
    stderr.end()

    await expect(pending).rejects.toThrow('Proxy exited with code 1')
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled()
    expect(heartbeatBodies()).toEqual([])
  })

  it('rejects a ready line that arrives after the startup timeout, killing the child once', async () => {
    const { child, stdout, stderr, events, killMock } = makeFakeChild(4248)
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
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
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled()
    expect(heartbeatBodies()).toEqual([])
  })

  it('starts one drain, keeps one kill, and skips SIGKILL when the timeout and the resulting exit interleave', async () => {
    const { child, stderr, events, killMock, unrefMock } = makeFakeChild(4249)
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
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

  it('removes the child exit listener once the ready line claims success', async () => {
    const { child, stdout, events } = makeFakeChild(4250)
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    expect(events.listenerCount('exit')).toBe(1)

    stdout.write(`${JSON.stringify({ type: 'ready', port: 45683, models: [] })}\n`)
    const result = await pending

    expect(result.port).toBe(45683)
    expect(events.listenerCount('exit')).toBe(0)
  })

  it('keeps the stderr capture attached after a successful startup', async () => {
    const { child, stdout, stderr } = makeFakeChild(4253)
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
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
    spawnMock.mockReturnValue(child)

    const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
    void pending.catch(() => {})
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
    fsMocks.existsSync.mockReturnValue(false)
    fsMocks.readFileSync.mockReturnValue('{}')
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

      const pending = connectToProxy(() => BOOTSTRAP_SESSION_ID, 'access-token')
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
