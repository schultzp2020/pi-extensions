/**
 * Proxy lifecycle management.
 *
 * Manages the cursor-proxy child process from the extension side:
 * spawn, discover via port file, reconnect, heartbeat, shutdown.
 *
 * Multiple Pi sessions share one proxy via the port file at
 * ~/.pi/agent/cursor-proxy.json. Each session sends heartbeats;
 * the proxy self-exits once heartbeats stop (timeout and sleep-resume
 * grace rules live in proxy/internal-api.ts).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { captureProxyStderr } from './proxy-stderr.ts'
import { isDebugLoggingEnabled, logProxyStderr } from './proxy/debug-logger.ts'
import type { CursorModel } from './proxy/models.ts'

const PORT_FILE = join(homedir(), '.pi', 'agent', 'cursor-proxy.json')
const LIFECYCLE_FILE = join(homedir(), '.pi', 'agent', 'cursor-proxy-lifecycle.json')
const PROXY_ENTRY = resolve(import.meta.dirname, 'proxy', 'main.js')
const HEARTBEAT_INTERVAL_MS = 10_000
const PROXY_STARTUP_TIMEOUT_MS = 15_000
const PROXY_STDERR_DRAIN_TIMEOUT_MS = 1_000
const PROXY_SIGTERM_GRACE_MS = 1_000
const PROXY_SIGKILL_WAIT_MS = 250
const HEALTH_CHECK_TIMEOUT_MS = 2_000
const HEARTBEAT_TIMEOUT_MS = 2_000
const TOKEN_PUSH_TIMEOUT_MS = 2_000
const MODEL_REFRESH_TIMEOUT_MS = 10_000

interface ProxyInfo {
  port: number
  pid: number
}

interface ProxyConnection {
  port: number
  pid: number
  heartbeatTimer: NodeJS.Timeout
}

type StartupOutcome = { ready: true; line: string } | { ready: false; message: string; cause?: Error }

export interface ProxyExitEvent {
  port: number
  childPid: number
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
}

interface ProxyLifecycleRecord {
  timestamp: string
  childPid: number
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  restartOutcome: 'not-attempted' | 'succeeded' | 'failed'
}

export interface ProxyConnectOptions {
  portFilePath?: string
  lifecycleFilePath?: string
  proxyEntry?: string
}

let activeConnection: ProxyConnection | null = null
let pendingRestart: { record: ProxyLifecycleRecord; lifecycleFilePath: string } | null = null
const proxyExitListeners = new Set<(event: ProxyExitEvent) => void>()

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = existence check only
    return true
  } catch {
    return false
  }
}

/**
 * Read the port file. Returns proxy info if the file exists and the
 * process is still alive, otherwise cleans up the stale file.
 */
export function readPortFile(portFilePath = PORT_FILE): ProxyInfo | null {
  try {
    if (!existsSync(portFilePath)) {
      return null
    }
    const data = JSON.parse(readFileSync(portFilePath, 'utf8')) as ProxyInfo
    if (data.port && data.pid && isProcessAlive(data.pid)) {
      return data
    }
    // Stale port file — clean up
    try {
      unlinkSync(portFilePath)
    } catch {
      // ignore cleanup errors
    }
    return null
  } catch {
    return null
  }
}

function writePortFile(info: ProxyInfo, portFilePath: string): void {
  mkdirSync(resolve(portFilePath, '..'), { recursive: true })
  writeFileSync(portFilePath, JSON.stringify(info))
}

export async function isProxyHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${String(port)}/internal/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

function persistLifecycleRecord(record: ProxyLifecycleRecord, lifecycleFilePath: string): void {
  try {
    mkdirSync(resolve(lifecycleFilePath, '..'), { recursive: true })
    writeFileSync(lifecycleFilePath, JSON.stringify(record))
  } catch {
    // Diagnostics must never interfere with recovery.
  }
}

function completePendingRestart(restartOutcome: 'succeeded' | 'failed'): void {
  if (!pendingRestart) {
    return
  }
  pendingRestart.record.restartOutcome = restartOutcome
  persistLifecycleRecord(pendingRestart.record, pendingRestart.lifecycleFilePath)
  pendingRestart = null
}

function removeOwnedPortFile(portFilePath: string, childPid: number): void {
  try {
    const info = JSON.parse(readFileSync(portFilePath, 'utf8')) as ProxyInfo
    if (info.pid === childPid) {
      unlinkSync(portFilePath)
    }
  } catch {
    // The file may already be absent or may belong to a replacement proxy.
  }
}

function handleProxyExit(event: ProxyExitEvent, portFilePath: string, lifecycleFilePath: string): void {
  const record: ProxyLifecycleRecord = {
    timestamp: new Date().toISOString(),
    childPid: event.childPid,
    exitCode: event.exitCode,
    exitSignal: event.exitSignal,
    restartOutcome: 'not-attempted',
  }
  pendingRestart = { record, lifecycleFilePath }
  persistLifecycleRecord(record, lifecycleFilePath)
  removeOwnedPortFile(portFilePath, event.childPid)

  if (activeConnection?.pid !== event.childPid || activeConnection.port !== event.port) {
    return
  }
  stopHeartbeat()
  for (const listener of proxyExitListeners) {
    listener(event)
  }
}

export function onProxyExit(listener: (event: ProxyExitEvent) => void): () => void {
  proxyExitListeners.add(listener)
  return () => proxyExitListeners.delete(listener)
}

async function sendHeartbeat(port: number, sessionId: string): Promise<void> {
  try {
    await fetch(`http://localhost:${String(port)}/internal/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    })
  } catch {
    // Heartbeat failures are non-fatal — proxy may be temporarily busy
  }
}

export async function pushToken(port: number, accessToken: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return
  }
  try {
    const timeout = AbortSignal.timeout(TOKEN_PUSH_TIMEOUT_MS)
    await fetch(`http://localhost:${String(port)}/internal/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access: accessToken }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch {
    // Token push failures are non-fatal — will retry on next request
  }
}

async function getModels(port: number): Promise<CursorModel[]> {
  const res = await fetch(`http://localhost:${String(port)}/internal/models`, {
    signal: AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
  })
  const data = (await res.json()) as { models: CursorModel[] }
  return data.models
}

/**
 * Connect to an existing proxy or spawn a new one.
 *
 * 1. Checks the port file for a running proxy and validates via health check.
 * 2. If no healthy proxy exists, spawns a new child process.
 * 3. Starts the heartbeat timer; each heartbeat resolves the current session ID.
 */
export async function connectToProxy(
  sessionId: string | (() => string),
  accessToken: string | null,
  options: ProxyConnectOptions = {},
): Promise<{ port: number; pid: number; models: CursorModel[] }> {
  const getSessionId = typeof sessionId === 'function' ? sessionId : () => sessionId
  const portFilePath = options.portFilePath ?? PORT_FILE
  const lifecycleFilePath = options.lifecycleFilePath ?? LIFECYCLE_FILE
  try {
    // 1. Try existing proxy via port file
    const existing = readPortFile(portFilePath)
    if (existing && (await isProxyHealthy(existing.port))) {
      if (accessToken) {
        await pushToken(existing.port, accessToken)
      }
      startHeartbeat(existing.port, existing.pid, getSessionId)
      const models = await getModels(existing.port)
      completePendingRestart('succeeded')
      return { port: existing.port, pid: existing.pid, models }
    }
    // 2. No existing proxy — need to spawn
    if (!accessToken) {
      throw new Error('No access token and no existing proxy')
    }
    const result = await spawnProxy(getSessionId, accessToken, {
      portFilePath,
      lifecycleFilePath,
      proxyEntry: options.proxyEntry ?? PROXY_ENTRY,
    })
    completePendingRestart('succeeded')
    return result
  } catch (error) {
    completePendingRestart('failed')
    throw error
  }
}

async function spawnProxy(
  getSessionId: () => string,
  accessToken: string,
  options: Required<ProxyConnectOptions>,
): Promise<{ port: number; pid: number; models: CursorModel[] }> {
  const child = spawn('node', [options.proxyEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
    windowsHide: true,
  })

  // Persistent ChildProcess error sink, registered immediately after spawn.
  // Spawn failures (ENOENT, EMFILE, EAGAIN) emit 'error' — often without any
  // 'exit' — and a failed kill can emit 'error' during termination. An
  // unhandled EventEmitter error would crash the whole Pi process, so this
  // sink observes every child error for the child's lifetime. The startup
  // state machine below decides whether an error claims the startup.
  const sinkChildError = (error: Error): void => {
    void error
  }
  child.on('error', sinkChildError)

  // Send config on stdin
  // stdio: ['pipe','pipe','pipe'] guarantees these are non-null
  const { stdin, stdout, stderr } = child
  const childPid = child.pid
  if (!childPid) {
    throw new Error('Proxy child did not receive a process ID')
  }
  // Resolve the session ID at event time so stderr logs use the real ID
  // after session_start replaces the bootstrap UUID.
  const stderrCapture = captureProxyStderr(stderr, {
    onOutput: isDebugLoggingEnabled() ? (output) => logProxyStderr(getSessionId(), output) : undefined,
  })
  stdin.write(`${JSON.stringify({ accessToken })}\n`)
  stdin.end()

  // kill() only confirms signal delivery and child.killed only records the
  // request. Termination is confirmed solely by the child's own exit/close
  // events, tracked through this flag and the cleanup watchers below.
  let childTerminated = false
  const markTerminated = (): void => {
    childTerminated = true
  }

  // Read ready signal from stdout
  const rl = createInterface({ input: stdout })
  // Escalates termination of a still-running child: one SIGTERM, an
  // independent grace window, one SIGKILL if no exit was observed, then a
  // bounded wait for exit confirmation and final stderr. Disposes every
  // startup resource and returns the startup error with the stderr snapshot
  // taken before disposal.
  async function cleanupFailedStartup(error: unknown): Promise<Error> {
    // Keep observing exit/close while cleanup runs; the startup exit
    // listener was detached when the failure claimed the outcome.
    child.on('exit', markTerminated)
    child.on('close', markTerminated)
    try {
      // Stderr drain and process grace run independently: a child can close
      // stderr long before it exits, so stderr completion must never
      // shorten the SIGTERM grace, and a hung stderr stream must never
      // extend the grace. Both windows are bounded by their own deadlines.
      const drained = stderrCapture.drain(PROXY_STDERR_DRAIN_TIMEOUT_MS)
      let termination = Promise.resolve()
      if (!childTerminated) {
        sendSignal('SIGTERM')
        termination = waitForTermination(PROXY_SIGTERM_GRACE_MS)
      }
      await drained
      await termination
      if (!childTerminated) {
        sendSignal('SIGKILL')
        // Exit alone is not proof the pipes drained: the child can write
        // final stderr after its exit event. A fresh bounded drain runs
        // concurrently with the exit wait, and both share the post-kill
        // deadline, so cleanup stays bounded either way.
        const postKillDrained = stderrCapture.drain(PROXY_SIGKILL_WAIT_MS)
        await Promise.all([waitForTermination(PROXY_SIGKILL_WAIT_MS), postKillDrained])
      }
      // Snapshot the diagnostics before disposal clears the capture state.
      return stderrCapture.startupError(error)
    } finally {
      disposeStartupResources()
    }
  }

  function sendSignal(signal: NodeJS.Signals): void {
    try {
      child.kill(signal)
    } catch {
      // A failed signal (the pid may already be gone) must not block
      // cleanup; the watchers and the unref fallback still bound it.
    }
  }

  // Bounded wait for exit/close after SIGKILL. Resolves on the first event
  // or the deadline, so cleanup finishes even if no event ever arrives.
  function waitForTermination(timeoutMs: number): Promise<void> {
    if (childTerminated) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let settled = false
      const onDone = (): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        child.removeListener('exit', onDone)
        child.removeListener('close', onDone)
        resolve()
      }
      const timer = setTimeout(onDone, timeoutMs)
      child.once('exit', onDone)
      child.once('close', onDone)
    })
  }

  // Disposal of every failed-startup resource: cleanup watchers, readline,
  // all three pipe wrappers, and the stderr capture listeners. Idempotent
  // through each part's own guards. The child error sink is removed only
  // once termination is confirmed: an unconfirmed child can still emit
  // errors, and an unhandled one would crash the parent. The stderr capture
  // keeps one inert error sink past its own disposal until the stream
  // closes, so the destroy below can never expose a queued destroy(error)
  // emission as an unhandled error.
  function disposeStartupResources(): void {
    child.removeListener('exit', markTerminated)
    child.removeListener('close', markTerminated)
    if (childTerminated) {
      child.removeListener('error', sinkChildError)
    }
    rl.close()
    stdin.destroy()
    stdout.destroy()
    stderrCapture.dispose()
    stderr.destroy()
    if (!childTerminated) {
      // Last safety: cleanup could not confirm termination, so the child
      // handle must not be able to retain the parent event loop.
      child.unref()
    }
  }

  let ready: { type: string; port: number; models?: CursorModel[] }
  try {
    const outcome = await new Promise<StartupOutcome>((resolve) => {
      // Startup terminal state. The first of ready line, startup timeout,
      // pre-ready child exit, or child process error claims the outcome
      // synchronously; every later terminal callback does nothing, so a
      // delayed ready line can never override a claimed failure and no
      // terminal path runs twice.
      let state: 'pending' | 'succeeded' | 'failed' = 'pending'

      const onExit = (code: number | null): void => {
        if (state !== 'pending') {
          return
        }
        state = 'failed'
        childTerminated = true
        detachStartupWatch()
        resolve({ ready: false, message: `Proxy exited with code ${String(code)}` })
      }
      // A spawn failure (ENOENT, EMFILE, EAGAIN) can emit 'error' without
      // any 'exit'. The error claims the startup failure and the original
      // error travels as the startup cause. Errors after the claim only hit
      // the persistent sink; they never restart cleanup.
      const onChildError = (error: Error): void => {
        if (state !== 'pending') {
          return
        }
        state = 'failed'
        // The errored child never started or is already gone, so cleanup
        // must not signal it again.
        childTerminated = true
        detachStartupWatch()
        resolve({ ready: false, message: `Proxy process error: ${error.message}`, cause: error })
      }
      const onTimeout = (): void => {
        if (state !== 'pending') {
          return
        }
        state = 'failed'
        detachStartupWatch()
        resolve({ ready: false, message: 'Proxy startup timeout' })
      }
      const onLine = (line: string): void => {
        if (state !== 'pending') {
          return
        }
        state = 'succeeded'
        detachStartupWatch()
        resolve({ ready: true, line })
      }

      const startupTimeout = setTimeout(onTimeout, PROXY_STARTUP_TIMEOUT_MS)
      child.on('exit', onExit)
      child.on('error', onChildError)
      rl.once('line', onLine)

      // Clears the startup timeout and detaches every startup listener once a
      // terminal state is claimed. Idempotent.
      function detachStartupWatch(): void {
        clearTimeout(startupTimeout)
        child.removeListener('exit', onExit)
        child.removeListener('error', onChildError)
        rl.removeListener('line', onLine)
      }
    })

    if (!outcome.ready) {
      throw new Error(outcome.message, { cause: outcome.cause })
    }
    ready = JSON.parse(outcome.line) as { type: string; port: number; models?: CursorModel[] }
    if (ready.type !== 'ready' || !ready.port || !childPid) {
      throw new Error(`Unexpected proxy output: ${outcome.line}`)
    }
    stderrCapture.finishStartup()
  } catch (error) {
    // Single failure funnel: startup timeout, pre-ready exit, pre-ready
    // child process error, malformed ready JSON, and invalid ready payload
    // all land here. The child is only killed on failure paths; a
    // successfully validated proxy never reaches this catch.
    const failure = await cleanupFailedStartup(error)
    throw failure
  } finally {
    rl.close()
  }

  child.once('exit', (code, signal) => {
    handleProxyExit(
      { port: ready.port, childPid, exitCode: code, exitSignal: signal },
      options.portFilePath,
      options.lifecycleFilePath,
    )
  })
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `Proxy exited after readiness with code ${String(child.exitCode)} signal ${String(child.signalCode)}`,
    )
  }

  // Write port file for other sessions to discover
  writePortFile({ port: ready.port, pid: childPid }, options.portFilePath)

  // Start heartbeat
  startHeartbeat(ready.port, childPid, getSessionId)

  // Don't let the child keep the parent alive
  child.unref()

  return { port: ready.port, pid: childPid, models: ready.models ?? [] }
}

function startHeartbeat(port: number, pid: number, getSessionId: () => string): void {
  stopHeartbeat()
  // Resolve the session ID at each send so heartbeats follow session_start updates.
  void sendHeartbeat(port, getSessionId()) // immediate first heartbeat
  const timer = setInterval(() => {
    void sendHeartbeat(port, getSessionId())
  }, HEARTBEAT_INTERVAL_MS)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
  activeConnection = { port, pid, heartbeatTimer: timer }
}

export function stopHeartbeat(): void {
  if (activeConnection) {
    clearInterval(activeConnection.heartbeatTimer)
    activeConnection = null
  }
}

export function getActivePort(): number | null {
  return activeConnection?.port ?? null
}
