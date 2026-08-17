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
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { captureProxyStderr } from './proxy-stderr.ts'
import { isDebugLoggingEnabled, logProxyStderr } from './proxy/debug-logger.ts'
import { removeOwnedProxyPortFileUnderLock, withProxyPortLock } from './proxy-port-file.ts'
import {
  HEALTH_CHECK_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  LIFECYCLE_LOCK_MAX_WAIT_MS,
  MODEL_REFRESH_TIMEOUT_MS,
  PROXY_STARTUP_TIMEOUT_MS,
  TOKEN_PUSH_TIMEOUT_MS,
} from './proxy-timeouts.ts'
import type { CursorModel } from './proxy/models.ts'
import { withSharedLock } from './shared-lock.ts'

const PORT_FILE = join(homedir(), '.pi', 'agent', 'cursor-proxy.json')
const LIFECYCLE_FILE = join(homedir(), '.pi', 'agent', 'cursor-proxy-lifecycle.json')
const PROXY_ENTRY = resolve(import.meta.dirname, 'proxy', 'main.js')
const HEARTBEAT_INTERVAL_MS = 10_000
const PROXY_STDERR_DRAIN_TIMEOUT_MS = 1_000
const PROXY_SIGTERM_GRACE_MS = 1_000
const PROXY_SIGKILL_WAIT_MS = 250
const MAX_DATE_MS = 8_640_000_000_000_000

export interface ProxyInfo {
  port: number
  pid: number
  generation: string
}

interface ProxyConnection {
  port: number
  pid: number
  generation: string
  heartbeatTimer: NodeJS.Timeout
}

type StartupOutcome = { ready: true; line: string } | { ready: false; message: string; cause?: Error }

export interface ProxyExitEvent {
  port: number
  childPid: number
  generation: string
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

type ProxyLifecycleIdentity = Pick<ProxyLifecycleRecord, 'timestamp' | 'childPid'>

interface PendingProxyExit {
  record: ProxyLifecycleRecord
  persistence: Promise<void> | null
}

interface ParsedPortFile {
  info: ProxyInfo | null
  exists: boolean
}

export interface ProxyConnectOptions {
  portFilePath?: string
  lifecycleFilePath?: string
  proxyEntry?: string
  signal?: AbortSignal
}

interface SpawnProxyOptions {
  portFilePath: string
  lifecycleFilePath: string
  proxyEntry: string
  signal?: AbortSignal
}

let activeConnection: ProxyConnection | null = null
const proxyExitListeners = new Set<(event: ProxyExitEvent) => void>()
const pendingProxyExits = new Map<string, Map<string, PendingProxyExit>>()
let lastAllocatedGenerationMs = 0

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = existence check only
    return true
  } catch {
    return false
  }
}

function parsePortFile(portFilePath: string): ParsedPortFile {
  try {
    if (!existsSync(portFilePath)) {
      return { info: null, exists: false }
    }
    const stats = lstatSync(portFilePath)
    const value: unknown = JSON.parse(readFileSync(portFilePath, 'utf8'))
    if (typeof value !== 'object' || value === null) {
      return { info: null, exists: true }
    }
    const { port, pid, generation } = value as Record<string, unknown>
    if (
      typeof port !== 'number' ||
      !Number.isSafeInteger(port) ||
      port <= 0 ||
      port > 65_535 ||
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      (generation !== undefined &&
        (typeof generation !== 'string' || generation.length === 0 || !Number.isFinite(Date.parse(generation))))
    ) {
      return { info: null, exists: true }
    }
    const legacyTimestamp = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs
    return {
      info: {
        port,
        pid,
        generation: typeof generation === 'string' ? generation : new Date(legacyTimestamp).toISOString(),
      },
      exists: true,
    }
  } catch {
    return { info: null, exists: existsSync(portFilePath) }
  }
}

/**
 * Read the port file. Returns proxy info if the file exists and the
 * process is still alive.
 */
export function readPortFile(portFilePath = PORT_FILE): ProxyInfo | null {
  const parsed = parsePortFile(portFilePath)
  return parsed.info && isProcessAlive(parsed.info.pid) ? parsed.info : null
}

function writePortFile(info: ProxyInfo, portFilePath: string): void {
  mkdirSync(resolve(portFilePath, '..'), { recursive: true })
  writeFileSync(portFilePath, JSON.stringify(info))
}

export async function isProxyHealthy(port: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return false
  }
  try {
    const timeout = AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
    const res = await fetch(`http://localhost:${String(port)}/internal/health`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    return res.ok
  } catch {
    return false
  }
}

function persistLifecycleRecord(record: ProxyLifecycleRecord, lifecycleFilePath: string): void {
  const temporaryPath = `${lifecycleFilePath}.${String(process.pid)}.${randomUUID()}.tmp`
  try {
    mkdirSync(resolve(lifecycleFilePath, '..'), { recursive: true })
    writeFileSync(temporaryPath, JSON.stringify(record), { flag: 'wx' })
    renameSync(temporaryPath, lifecycleFilePath)
  } catch {
    // Diagnostics must never interfere with recovery.
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch {}
  }
}

async function withLifecycleRecordLock(lifecycleFilePath: string, update: () => void): Promise<void> {
  try {
    await withSharedLock(`${lifecycleFilePath}.lock`, LIFECYCLE_LOCK_MAX_WAIT_MS, update)
  } catch {}
}

function readLifecycleRecord(lifecycleFilePath: string): ProxyLifecycleRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(lifecycleFilePath, 'utf8'))
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const record = value as Record<string, unknown>
    const { timestamp, childPid, exitCode, exitSignal, restartOutcome } = record
    if (
      typeof timestamp !== 'string' ||
      !Number.isFinite(Date.parse(timestamp)) ||
      typeof childPid !== 'number' ||
      !Number.isSafeInteger(childPid) ||
      childPid <= 0 ||
      (exitCode !== null && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode))) ||
      (exitSignal !== null && typeof exitSignal !== 'string') ||
      (restartOutcome !== 'not-attempted' && restartOutcome !== 'succeeded' && restartOutcome !== 'failed')
    ) {
      return null
    }
    return {
      timestamp,
      childPid,
      exitCode,
      exitSignal: exitSignal as NodeJS.Signals | null,
      restartOutcome,
    }
  } catch {
    return null
  }
}

function hasSameLifecycleIdentity(left: ProxyLifecycleIdentity, right: ProxyLifecycleIdentity): boolean {
  return left.timestamp === right.timestamp && left.childPid === right.childPid
}

function getLifecycleIdentityKey(identity: ProxyLifecycleIdentity): string {
  return `${identity.timestamp}\0${String(identity.childPid)}`
}

function getPendingProxyExit(
  lifecycleFilePath: string,
  identity: ProxyLifecycleIdentity,
): PendingProxyExit | undefined {
  return pendingProxyExits.get(lifecycleFilePath)?.get(getLifecycleIdentityKey(identity))
}

function getLatestPendingProxyExit(lifecycleFilePath: string): ProxyLifecycleRecord | null {
  let latest: ProxyLifecycleRecord | null = null
  for (const pending of pendingProxyExits.get(lifecycleFilePath)?.values() ?? []) {
    if (!latest || isLifecycleRecordLater(pending.record, latest)) {
      latest = pending.record
    }
  }
  return latest
}

function mergeRestartOutcome(
  left: ProxyLifecycleRecord['restartOutcome'],
  right: ProxyLifecycleRecord['restartOutcome'],
): ProxyLifecycleRecord['restartOutcome'] {
  if (left === 'succeeded' || right === 'succeeded') {
    return 'succeeded'
  }
  if (left === 'failed' || right === 'failed') {
    return 'failed'
  }
  return 'not-attempted'
}

function isLifecycleRecordLater(left: ProxyLifecycleRecord, right: ProxyLifecycleRecord): boolean {
  if (left.timestamp !== right.timestamp) {
    return Date.parse(left.timestamp) > Date.parse(right.timestamp)
  }
  if (left.childPid !== right.childPid) {
    return left.childPid > right.childPid
  }
  const leftExitCode = left.exitCode ?? Number.MIN_SAFE_INTEGER
  const rightExitCode = right.exitCode ?? Number.MIN_SAFE_INTEGER
  if (leftExitCode !== rightExitCode) {
    return leftExitCode > rightExitCode
  }
  return (left.exitSignal ?? '') > (right.exitSignal ?? '')
}

async function completePendingRestart(
  restartOutcome: 'succeeded' | 'failed',
  lifecycleFilePath: string,
  expectedIdentity: ProxyLifecycleIdentity | null,
  isConnectionCurrent?: () => boolean,
  awaitPendingPersistence = true,
): Promise<boolean> {
  if (isConnectionCurrent && !isConnectionCurrent()) {
    return false
  }
  if (!expectedIdentity) {
    return isConnectionCurrent?.() ?? true
  }
  const pendingExit = getPendingProxyExit(lifecycleFilePath, expectedIdentity)
  if (pendingExit) {
    pendingExit.record.restartOutcome = mergeRestartOutcome(pendingExit.record.restartOutcome, restartOutcome)
    if (awaitPendingPersistence && pendingExit.persistence) {
      await pendingExit.persistence
    }
  }
  if (isConnectionCurrent && !isConnectionCurrent()) {
    return false
  }
  let connectionCurrent = true
  await withLifecycleRecordLock(lifecycleFilePath, () => {
    if (isConnectionCurrent && !isConnectionCurrent()) {
      connectionCurrent = false
      return
    }
    const persistedRecord = readLifecycleRecord(lifecycleFilePath)
    if (!persistedRecord || !hasSameLifecycleIdentity(expectedIdentity, persistedRecord)) {
      return
    }
    const nextOutcome = mergeRestartOutcome(persistedRecord.restartOutcome, restartOutcome)
    if (persistedRecord.restartOutcome !== nextOutcome) {
      persistLifecycleRecord({ ...persistedRecord, restartOutcome: nextOutcome }, lifecycleFilePath)
    }
  })
  return connectionCurrent && (isConnectionCurrent?.() ?? true)
}

function getPendingRestartIdentity(lifecycleFilePath: string): ProxyLifecycleIdentity | null {
  const persisted = readLifecycleRecord(lifecycleFilePath)
  const pending = getLatestPendingProxyExit(lifecycleFilePath)
  const latest =
    persisted && pending ? (isLifecycleRecordLater(pending, persisted) ? pending : persisted) : (pending ?? persisted)
  return latest && latest.restartOutcome !== 'succeeded'
    ? { timestamp: latest.timestamp, childPid: latest.childPid }
    : null
}

function allocateProxyGeneration(lifecycleFilePath: string, previousProxy: ProxyInfo | null): string {
  const persistedGeneration = readLifecycleRecord(lifecycleFilePath)?.timestamp
  const previousGenerationMs = previousProxy ? Date.parse(previousProxy.generation) : Number.NEGATIVE_INFINITY
  const persistedGenerationMs = persistedGeneration ? Date.parse(persistedGeneration) : Number.NEGATIVE_INFINITY
  const latestGenerationMs = Math.max(lastAllocatedGenerationMs, previousGenerationMs, persistedGenerationMs)
  if (latestGenerationMs >= MAX_DATE_MS) {
    throw new Error('Cannot allocate a later proxy generation')
  }
  const generationMs = Math.max(Date.now(), latestGenerationMs + 1)
  lastAllocatedGenerationMs = generationMs
  return new Date(generationMs).toISOString()
}

function hasSameProxyGeneration(left: ProxyInfo, right: ProxyInfo): boolean {
  return left.pid === right.pid && left.generation === right.generation
}

function hasExitDetail(record: ProxyLifecycleRecord): boolean {
  return record.exitCode !== null || record.exitSignal !== null
}

function isObservedLifecycleRecordForProxy(
  persistedRecord: ProxyLifecycleRecord,
  record: ProxyLifecycleRecord,
  proxy: ProxyInfo,
): boolean {
  if (persistedRecord.childPid !== proxy.pid || hasExitDetail(persistedRecord) || !hasExitDetail(record)) {
    return false
  }
  const generationMs = Date.parse(proxy.generation)
  const observedMs = Date.parse(persistedRecord.timestamp)
  return observedMs >= generationMs
}

async function persistProxyExit(
  record: ProxyLifecycleRecord,
  proxy: ProxyInfo,
  portFilePath: string,
  lifecycleFilePath: string,
  authoritative = false,
): Promise<void> {
  await withLifecycleRecordLock(lifecycleFilePath, () => {
    const persistedRecord = readLifecycleRecord(lifecycleFilePath)
    const sameLifecycleIdentity = Boolean(
      persistedRecord &&
      (hasSameLifecycleIdentity(persistedRecord, record) ||
        isObservedLifecycleRecordForProxy(persistedRecord, record, proxy)),
    )
    if (
      !authoritative &&
      persistedRecord &&
      !sameLifecycleIdentity &&
      isLifecycleRecordLater(persistedRecord, record)
    ) {
      return
    }
    const replacement = readPortFile(portFilePath)
    const observedOutcome =
      replacement && !hasSameProxyGeneration(replacement, proxy) ? 'succeeded' : record.restartOutcome
    if (persistedRecord && sameLifecycleIdentity) {
      const persistedHasExitDetail = hasExitDetail(persistedRecord)
      const recordHasExitDetail = hasExitDetail(record)
      const baseRecord =
        recordHasExitDetail && !persistedHasExitDetail
          ? record
          : persistedHasExitDetail && !recordHasExitDetail
            ? persistedRecord
            : isLifecycleRecordLater(record, persistedRecord)
              ? record
              : persistedRecord
      persistLifecycleRecord(
        {
          ...baseRecord,
          restartOutcome: mergeRestartOutcome(persistedRecord.restartOutcome, observedOutcome),
        },
        lifecycleFilePath,
      )
      return
    }
    persistLifecycleRecord({ ...record, restartOutcome: observedOutcome }, lifecycleFilePath)
  })
}

async function persistObservedProxyExit(
  proxy: ProxyInfo,
  portFilePath: string,
  lifecycleFilePath: string,
): Promise<ProxyLifecycleRecord> {
  const record: ProxyLifecycleRecord = {
    timestamp: new Date().toISOString(),
    childPid: proxy.pid,
    exitCode: null,
    exitSignal: null,
    restartOutcome: 'not-attempted',
  }
  await persistProxyExit(record, proxy, portFilePath, lifecycleFilePath, true)
  return record
}

async function persistProxyExitWithCoordination(
  record: ProxyLifecycleRecord,
  proxy: ProxyInfo,
  portFilePath: string,
  lifecycleFilePath: string,
): Promise<void> {
  await withProxyPortLock(portFilePath, async () => {
    await persistProxyExit(record, proxy, portFilePath, lifecycleFilePath)
    removeOwnedProxyPortFileUnderLock(portFilePath, proxy)
  })
}

function handleProxyExit(event: ProxyExitEvent, portFilePath: string, lifecycleFilePath: string): void {
  const record: ProxyLifecycleRecord = {
    timestamp: new Date().toISOString(),
    childPid: event.childPid,
    exitCode: event.exitCode,
    exitSignal: event.exitSignal,
    restartOutcome: 'not-attempted',
  }
  const pendingExit: PendingProxyExit = { record, persistence: null }
  let exitsForFile = pendingProxyExits.get(lifecycleFilePath)
  if (!exitsForFile) {
    exitsForFile = new Map<string, PendingProxyExit>()
    pendingProxyExits.set(lifecycleFilePath, exitsForFile)
  }
  const identityKey = getLifecycleIdentityKey(record)
  exitsForFile.set(identityKey, pendingExit)
  const persistence = persistProxyExitWithCoordination(
    record,
    { port: event.port, pid: event.childPid, generation: event.generation },
    portFilePath,
    lifecycleFilePath,
  )
  pendingExit.persistence = persistence
  const clearPendingExit = (): void => {
    const currentExits = pendingProxyExits.get(lifecycleFilePath)
    if (currentExits?.get(identityKey) === pendingExit) {
      currentExits.delete(identityKey)
      if (currentExits.size === 0) {
        pendingProxyExits.delete(lifecycleFilePath)
      }
    }
  }
  void persistence.then(clearPendingExit, clearPendingExit)

  if (
    activeConnection?.pid !== event.childPid ||
    activeConnection.port !== event.port ||
    activeConnection.generation !== event.generation
  ) {
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

async function sendHeartbeat(port: number, sessionId: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return false
  }
  try {
    const timeout = AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS)
    const response = await fetch(`http://localhost:${String(port)}/internal/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    return response.ok
  } catch {
    return false
  }
}

export async function pushToken(port: number, accessToken: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return false
  }
  try {
    const timeout = AbortSignal.timeout(TOKEN_PUSH_TIMEOUT_MS)
    const response = await fetch(`http://localhost:${String(port)}/internal/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access: accessToken }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    return response.ok
  } catch {
    return false
  }
}

async function getModels(port: number, signal?: AbortSignal): Promise<CursorModel[]> {
  signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS)
  const res = await fetch(`http://localhost:${String(port)}/internal/models`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!res.ok) {
    throw new Error(`Proxy model refresh failed with status ${String(res.status)}`)
  }
  const data = (await res.json()) as { models: CursorModel[] }
  return data.models
}

function isActiveProxyConnection(connection: ProxyInfo): boolean {
  return (
    activeConnection?.port === connection.port &&
    activeConnection.pid === connection.pid &&
    activeConnection.generation === connection.generation &&
    isProcessAlive(connection.pid)
  )
}

function stopHeartbeatFor(connection: ProxyInfo): void {
  if (
    activeConnection?.port === connection.port &&
    activeConnection.pid === connection.pid &&
    activeConnection.generation === connection.generation
  ) {
    stopHeartbeat()
  }
}

async function finalizeProxyConnection<T extends ProxyInfo & { models: CursorModel[] }>(
  connection: T,
  portFilePath: string,
  lifecycleFilePath: string,
  restartIdentity: ProxyLifecycleIdentity | null,
): Promise<T> {
  const connectionCurrent = await completePendingRestart(
    'succeeded',
    lifecycleFilePath,
    restartIdentity,
    () => isActiveProxyConnection(connection),
    false,
  )
  if (!connectionCurrent) {
    stopHeartbeatFor(connection)
    removeOwnedProxyPortFileUnderLock(portFilePath, connection)
    throw new Error(`Proxy ${String(connection.pid)} exited before connection completed`)
  }
  return connection
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
): Promise<{ port: number; pid: number; generation: string; models: CursorModel[] }> {
  const getSessionId = typeof sessionId === 'function' ? sessionId : () => sessionId
  const portFilePath = options.portFilePath ?? PORT_FILE
  const lifecycleFilePath = options.lifecycleFilePath ?? LIFECYCLE_FILE
  const { signal } = options
  signal?.throwIfAborted()
  const lockResult = await withProxyPortLock(
    portFilePath,
    async () => {
      let restartIdentity = getPendingRestartIdentity(lifecycleFilePath)
      let spawnedConnection: (ProxyInfo & { models: CursorModel[] }) | null = null
      let adoptedConnection: ProxyInfo | null = null
      try {
        signal?.throwIfAborted()
        const parsedPortFile = parsePortFile(portFilePath)
        const existing = parsedPortFile.info
        if (existing && isProcessAlive(existing.pid)) {
          const healthy = await isProxyHealthy(existing.port, signal)
          signal?.throwIfAborted()
          if (healthy) {
            const tokenAccepted = !accessToken || (await pushToken(existing.port, accessToken, signal))
            signal?.throwIfAborted()
            const heartbeatAccepted = tokenAccepted && (await sendHeartbeat(existing.port, getSessionId(), signal))
            signal?.throwIfAborted()
            if (heartbeatAccepted) {
              try {
                const models = await getModels(existing.port, signal)
                signal?.throwIfAborted()
                if (await isProxyHealthy(existing.port, signal)) {
                  signal?.throwIfAborted()
                  startHeartbeat(existing.port, existing.pid, existing.generation, getSessionId, false)
                  adoptedConnection = existing
                  const connection = await finalizeProxyConnection(
                    { port: existing.port, pid: existing.pid, generation: existing.generation, models },
                    portFilePath,
                    lifecycleFilePath,
                    restartIdentity,
                  )
                  signal?.throwIfAborted()
                  return connection
                }
                signal?.throwIfAborted()
              } catch {
                signal?.throwIfAborted()
              }
            }
          }
        }

        if (existing) {
          const observedExit = await persistObservedProxyExit(existing, portFilePath, lifecycleFilePath)
          restartIdentity = { timestamp: observedExit.timestamp, childPid: observedExit.childPid }
          signal?.throwIfAborted()
          stopHeartbeatFor(existing)
          removeOwnedProxyPortFileUnderLock(portFilePath, existing)
        } else if (parsedPortFile.exists) {
          try {
            unlinkSync(portFilePath)
          } catch {}
        }

        signal?.throwIfAborted()
        if (!accessToken) {
          throw new Error('No access token and no existing proxy')
        }
        const generation = allocateProxyGeneration(lifecycleFilePath, existing)
        spawnedConnection = await spawnProxy(getSessionId, accessToken, generation, {
          portFilePath,
          lifecycleFilePath,
          proxyEntry: options.proxyEntry ?? PROXY_ENTRY,
          signal,
        })
        signal?.throwIfAborted()
        const connection = await finalizeProxyConnection(
          spawnedConnection,
          portFilePath,
          lifecycleFilePath,
          restartIdentity,
        )
        signal?.throwIfAborted()
        return connection
      } catch (error) {
        if (signal?.aborted && adoptedConnection) {
          stopHeartbeatFor(adoptedConnection)
        }
        if (signal?.aborted && spawnedConnection) {
          stopHeartbeatFor(spawnedConnection)
          removeOwnedProxyPortFileUnderLock(portFilePath, spawnedConnection)
          try {
            process.kill(spawnedConnection.pid, 'SIGTERM')
          } catch {}
        }
        await completePendingRestart('failed', lifecycleFilePath, restartIdentity, undefined, false)
        throw error
      }
    },
    signal,
  )
  if (!lockResult.acquired) {
    throw new Error('Timed out waiting for shared proxy recovery')
  }
  return lockResult.value
}

async function spawnProxy(
  getSessionId: () => string,
  accessToken: string,
  generation: string,
  options: SpawnProxyOptions,
): Promise<{ port: number; pid: number; generation: string; models: CursorModel[] }> {
  options.signal?.throwIfAborted()
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
  stdin.write(`${JSON.stringify({ accessToken, generation, portFilePath: options.portFilePath })}\n`)
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
      const onAbort = (): void => {
        if (state !== 'pending') {
          return
        }
        state = 'failed'
        detachStartupWatch()
        const reason = options.signal?.reason
        resolve({
          ready: false,
          message: 'Proxy startup aborted',
          cause: reason instanceof Error ? reason : undefined,
        })
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
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) {
        onAbort()
      }

      // Clears the startup timeout and detaches every startup listener once a
      // terminal state is claimed. Idempotent.
      function detachStartupWatch(): void {
        clearTimeout(startupTimeout)
        child.removeListener('exit', onExit)
        child.removeListener('error', onChildError)
        rl.removeListener('line', onLine)
        options.signal?.removeEventListener('abort', onAbort)
      }
    })

    if (!outcome.ready) {
      throw new Error(outcome.message, { cause: outcome.cause })
    }
    options.signal?.throwIfAborted()
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
      { port: ready.port, childPid, generation, exitCode: code, exitSignal: signal },
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
  writePortFile({ port: ready.port, pid: childPid, generation }, options.portFilePath)

  // Start heartbeat
  startHeartbeat(ready.port, childPid, generation, getSessionId)

  // Don't let the child keep the parent alive
  child.unref()

  return { port: ready.port, pid: childPid, generation, models: ready.models ?? [] }
}

function startHeartbeat(
  port: number,
  pid: number,
  generation: string,
  getSessionId: () => string,
  sendInitial = true,
): void {
  stopHeartbeat()
  // Resolve the session ID at each send so heartbeats follow session_start updates.
  if (sendInitial) {
    void sendHeartbeat(port, getSessionId())
  }
  const timer = setInterval(() => {
    void sendHeartbeat(port, getSessionId())
  }, HEARTBEAT_INTERVAL_MS)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
  activeConnection = { port, pid, generation, heartbeatTimer: timer }
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
