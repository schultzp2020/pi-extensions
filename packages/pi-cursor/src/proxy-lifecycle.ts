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
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'

import { captureProxyStderr } from './proxy-stderr.ts'
import { isDebugLoggingEnabled, logProxyStderr } from './proxy/debug-logger.ts'
import { removeOwnedProxyPortFile } from './proxy-port-file.ts'
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
const LIFECYCLE_LOCK_RETRY_MS = 5
const LIFECYCLE_LOCK_STALE_MS = 2_000
const PROCESS_IDENTITY_CACHE_MS = 250
const PROXY_LOCK_MAX_WAIT_MS =
  PROXY_STARTUP_TIMEOUT_MS +
  HEALTH_CHECK_TIMEOUT_MS +
  TOKEN_PUSH_TIMEOUT_MS +
  MODEL_REFRESH_TIMEOUT_MS +
  LIFECYCLE_LOCK_STALE_MS

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

interface PendingProxyExit {
  record: ProxyLifecycleRecord
  persistence: Promise<void> | null
}

interface SharedLockOwner {
  ownerPid: number
  ownerId: string
  acquiredAt: number
  processIdentity: string | null
}

interface SharedLockEntry {
  modifiedAt: number
  owner: SharedLockOwner | null
}

interface AcquiredSharedLock {
  ticketName: string
  ticketPath: string
}

type ProcessIdentity = { status: 'running'; identity: string } | { status: 'stopped' } | { status: 'unknown' }

type SharedLockResult<T> = { acquired: true; value: T } | { acquired: false }

interface ParsedPortFile {
  info: ProxyInfo | null
  exists: boolean
}

export interface ProxyConnectOptions {
  portFilePath?: string
  lifecycleFilePath?: string
  proxyEntry?: string
}

let activeConnection: ProxyConnection | null = null
const proxyExitListeners = new Set<(event: ProxyExitEvent) => void>()
const pendingProxyExits = new Map<string, PendingProxyExit>()
const processIdentityCache = new Map<string, { observedAt: number; identity: ProcessIdentity }>()
let currentProcessIdentity: string | null | undefined

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = existence check only
    return true
  } catch {
    return false
  }
}

function queryLinuxProcessIdentity(pid: number): ProcessIdentity {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    const commandEnd = stat.lastIndexOf(')')
    if (commandEnd < 0) {
      return { status: 'unknown' }
    }
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/)
    const state = fields[0]
    const startTime = fields[19]
    if (state === 'Z') {
      return { status: 'stopped' }
    }
    if (!startTime) {
      return { status: 'unknown' }
    }
    let bootId = ''
    try {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    } catch {}
    return { status: 'running', identity: `linux:${bootId}:${startTime}` }
  } catch {
    return isProcessAlive(pid) ? { status: 'unknown' } : { status: 'stopped' }
  }
}

function getProbeTimeout(maxProbeMs: number, defaultTimeoutMs: number): number | null {
  const timeout = Math.min(defaultTimeoutMs, Math.floor(maxProbeMs))
  return timeout >= 1 ? timeout : null
}

function queryPsProcessIdentity(pid: number, maxProbeMs: number): ProcessIdentity {
  const timeout = getProbeTimeout(maxProbeMs, 1_000)
  if (timeout === null) {
    return { status: 'unknown' }
  }
  const result = spawnSync('ps', ['-o', 'lstart=', '-o', 'state=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  })
  const output = result.stdout.trim()
  if (result.status !== 0 || !output) {
    return isProcessAlive(pid) ? { status: 'unknown' } : { status: 'stopped' }
  }
  const fields = output.split(/\s+/)
  const state = fields.pop()
  if (!state || fields.length === 0) {
    return { status: 'unknown' }
  }
  if (state.startsWith('Z')) {
    return { status: 'stopped' }
  }
  return { status: 'running', identity: `ps:${fields.join(' ')}` }
}

function queryWindowsProcessIdentity(pid: number, maxProbeMs: number): ProcessIdentity {
  const timeout = getProbeTimeout(maxProbeMs, 2_000)
  if (timeout === null) {
    return { status: 'unknown' }
  }
  const command =
    `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue; ` +
    'if ($null -ne $p) { $p.StartTime.ToUniversalTime().Ticks }'
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  })
  const output = result.stdout.trim()
  if (result.status === 0 && /^\d+$/.test(output)) {
    return { status: 'running', identity: `windows:${output}` }
  }
  return isProcessAlive(pid) ? { status: 'unknown' } : { status: 'stopped' }
}

function queryProcessIdentity(pid: number, maxProbeMs: number): ProcessIdentity {
  if (process.platform === 'linux') {
    return queryLinuxProcessIdentity(pid)
  }
  if (process.platform === 'darwin' || process.platform === 'freebsd' || process.platform === 'openbsd') {
    return queryPsProcessIdentity(pid, maxProbeMs)
  }
  if (process.platform === 'win32') {
    return queryWindowsProcessIdentity(pid, maxProbeMs)
  }
  return isProcessAlive(pid) ? { status: 'unknown' } : { status: 'stopped' }
}

function getCurrentProcessIdentity(maxProbeMs: number): string | null {
  if (currentProcessIdentity !== undefined) {
    return currentProcessIdentity
  }
  const observed = queryProcessIdentity(process.pid, maxProbeMs)
  if (observed.status === 'running') {
    currentProcessIdentity = observed.identity
    return currentProcessIdentity
  }
  return null
}

function observeProcessIdentity(pid: number, expectedIdentity: string | null, maxProbeMs: number): ProcessIdentity {
  if (pid === process.pid) {
    const identity = getCurrentProcessIdentity(maxProbeMs)
    return identity === null ? { status: 'unknown' } : { status: 'running', identity }
  }
  const cacheKey = `${String(pid)}:${expectedIdentity ?? ''}`
  const cached = processIdentityCache.get(cacheKey)
  if (cached && performance.now() - cached.observedAt < PROCESS_IDENTITY_CACHE_MS) {
    return cached.identity
  }
  const identity = queryProcessIdentity(pid, maxProbeMs)
  processIdentityCache.set(cacheKey, { observedAt: performance.now(), identity })
  return identity
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

function parseSharedLockOwner(value: unknown): SharedLockOwner | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const { ownerPid, ownerId, acquiredAt, processIdentity } = record
  if (
    typeof ownerPid !== 'number' ||
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 0 ||
    typeof ownerId !== 'string' ||
    ownerId.length === 0 ||
    typeof acquiredAt !== 'number' ||
    !Number.isFinite(acquiredAt) ||
    acquiredAt <= 0 ||
    (typeof processIdentity !== 'string' && processIdentity !== null && processIdentity !== undefined)
  ) {
    return null
  }
  return {
    ownerPid,
    ownerId,
    acquiredAt,
    processIdentity: typeof processIdentity === 'string' ? processIdentity : null,
  }
}

function readSharedLockEntry(path: string): SharedLockEntry | null {
  try {
    const stats = lstatSync(path)
    let owner: SharedLockOwner | null = null
    if (stats.isFile()) {
      try {
        owner = parseSharedLockOwner(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      } catch {}
    }
    return { modifiedAt: stats.mtimeMs, owner }
  } catch {
    return null
  }
}

function isSharedLockEntryStale(entry: SharedLockEntry, maxProbeMs: number): boolean {
  if (entry.owner) {
    const observed = observeProcessIdentity(entry.owner.ownerPid, entry.owner.processIdentity, maxProbeMs)
    if (observed.status === 'stopped') {
      return true
    }
    if (observed.status === 'unknown') {
      return !isProcessAlive(entry.owner.ownerPid)
    }
    return entry.owner.processIdentity !== null && observed.identity !== entry.owner.processIdentity
  }
  const now = Date.now()
  return entry.modifiedAt > now + LIFECYCLE_LOCK_STALE_MS || now - entry.modifiedAt >= LIFECYCLE_LOCK_STALE_MS
}

function ensureSharedLockDirectory(lockPath: string, maxProbeMs: number): boolean {
  try {
    mkdirSync(lockPath, { mode: 0o700 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return false
    }
  }

  try {
    if (lstatSync(lockPath).isDirectory()) {
      return true
    }
  } catch {
    return false
  }

  const legacyEntry = readSharedLockEntry(lockPath)
  if (!legacyEntry || !isSharedLockEntryStale(legacyEntry, maxProbeMs)) {
    return false
  }
  try {
    unlinkSync(lockPath)
  } catch {}
  return false
}

function createSharedLockTicket(lockPath: string, maxProbeMs: number): AcquiredSharedLock | null {
  if (!ensureSharedLockDirectory(lockPath, maxProbeMs)) {
    return null
  }
  const processIdentity = getCurrentProcessIdentity(maxProbeMs)
  if (
    processIdentity === null &&
    (process.platform === 'linux' ||
      process.platform === 'darwin' ||
      process.platform === 'freebsd' ||
      process.platform === 'openbsd' ||
      process.platform === 'win32')
  ) {
    return null
  }
  const owner: SharedLockOwner = {
    ownerPid: process.pid,
    ownerId: randomUUID(),
    acquiredAt: Date.now(),
    processIdentity,
  }
  const sequence = process.hrtime.bigint().toString().padStart(24, '0')
  const ticketName = `${sequence}-${String(owner.ownerPid)}-${owner.ownerId}.ticket`
  const ticketPath = join(lockPath, ticketName)
  try {
    writeFileSync(ticketPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
    return { ticketName, ticketPath }
  } catch {
    return null
  }
}

function getFirstSharedLockTicket(lockPath: string, maxProbeMs: number): string | null {
  const startedAt = performance.now()
  let ticketNames: string[]
  try {
    ticketNames = readdirSync(lockPath)
      .filter((name) => name.endsWith('.ticket'))
      .sort()
  } catch {
    return null
  }
  for (const ticketName of ticketNames) {
    const ticketPath = join(lockPath, ticketName)
    const entry = readSharedLockEntry(ticketPath)
    if (!entry) {
      continue
    }
    const remainingProbeMs = Math.max(0, maxProbeMs - (performance.now() - startedAt))
    if (!isSharedLockEntryStale(entry, remainingProbeMs)) {
      return ticketName
    }
    try {
      unlinkSync(ticketPath)
    } catch {}
  }
  return null
}

function ownsSharedLock(lockPath: string, lock: AcquiredSharedLock, maxProbeMs: number): boolean {
  return existsSync(lock.ticketPath) && getFirstSharedLockTicket(lockPath, maxProbeMs) === lock.ticketName
}

function releaseSharedLock(lockPath: string, lock: AcquiredSharedLock): void {
  try {
    unlinkSync(lock.ticketPath)
  } catch {}
  try {
    rmdirSync(lockPath)
  } catch {}
}

async function withSharedLock<T>(
  lockPath: string,
  maxWaitMs: number,
  operation: () => T | Promise<T>,
): Promise<SharedLockResult<T>> {
  try {
    mkdirSync(resolve(lockPath, '..'), { recursive: true })
  } catch {
    return { acquired: false }
  }

  const deadline = performance.now() + maxWaitMs
  let lock: AcquiredSharedLock | null = null
  try {
    while (performance.now() < deadline) {
      const remainingMs = Math.max(0, deadline - performance.now())
      lock ??= createSharedLockTicket(lockPath, remainingMs)
      const ownershipRemainingMs = Math.max(0, deadline - performance.now())
      if (lock && ownsSharedLock(lockPath, lock, ownershipRemainingMs) && performance.now() < deadline) {
        const value = await operation()
        if (!ownsSharedLock(lockPath, lock, LIFECYCLE_LOCK_STALE_MS)) {
          throw new Error(`Lost shared lock ${lockPath}`)
        }
        return { acquired: true, value }
      }
      if (lock && !existsSync(lock.ticketPath)) {
        lock = null
      }
      const waitMs = Math.min(LIFECYCLE_LOCK_RETRY_MS, Math.max(0, deadline - performance.now()))
      if (waitMs > 0) {
        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, waitMs)
        })
      }
    }
    return { acquired: false }
  } finally {
    if (lock) {
      releaseSharedLock(lockPath, lock)
    }
  }
}

async function withLifecycleRecordLock(lifecycleFilePath: string, update: () => void): Promise<void> {
  try {
    await withSharedLock(`${lifecycleFilePath}.lock`, LIFECYCLE_LOCK_STALE_MS, update)
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

function hasSameLifecycleIdentity(left: ProxyLifecycleRecord, right: ProxyLifecycleRecord): boolean {
  return left.timestamp === right.timestamp && left.childPid === right.childPid
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
    return left.timestamp > right.timestamp
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
  isConnectionCurrent?: () => boolean,
  awaitPendingPersistence = true,
): Promise<boolean> {
  if (isConnectionCurrent && !isConnectionCurrent()) {
    return false
  }
  const pendingExit = pendingProxyExits.get(lifecycleFilePath)
  if (pendingExit) {
    pendingExit.record.restartOutcome = mergeRestartOutcome(pendingExit.record.restartOutcome, restartOutcome)
    if (awaitPendingPersistence && pendingExit.persistence) {
      await pendingExit.persistence
    }
  }
  if (isConnectionCurrent && !isConnectionCurrent()) {
    return false
  }
  const expectedRecord = readLifecycleRecord(lifecycleFilePath)
  if (!expectedRecord) {
    return isConnectionCurrent?.() ?? true
  }
  let connectionCurrent = true
  await withLifecycleRecordLock(lifecycleFilePath, () => {
    if (isConnectionCurrent && !isConnectionCurrent()) {
      connectionCurrent = false
      return
    }
    const persistedRecord = readLifecycleRecord(lifecycleFilePath)
    if (!persistedRecord || !hasSameLifecycleIdentity(expectedRecord, persistedRecord)) {
      return
    }
    const nextOutcome = mergeRestartOutcome(persistedRecord.restartOutcome, restartOutcome)
    if (persistedRecord.restartOutcome !== nextOutcome) {
      persistLifecycleRecord({ ...persistedRecord, restartOutcome: nextOutcome }, lifecycleFilePath)
    }
  })
  return connectionCurrent && (isConnectionCurrent?.() ?? true)
}

function hasSameProxyGeneration(info: ProxyInfo, record: ProxyLifecycleRecord): boolean {
  return info.pid === record.childPid && info.generation === record.timestamp
}

async function persistProxyExit(
  record: ProxyLifecycleRecord,
  portFilePath: string,
  lifecycleFilePath: string,
): Promise<void> {
  await withLifecycleRecordLock(lifecycleFilePath, () => {
    const persistedRecord = readLifecycleRecord(lifecycleFilePath)
    if (
      persistedRecord &&
      !hasSameLifecycleIdentity(persistedRecord, record) &&
      isLifecycleRecordLater(persistedRecord, record)
    ) {
      return
    }
    const replacement = readPortFile(portFilePath)
    const observedOutcome =
      replacement && !hasSameProxyGeneration(replacement, record) ? 'succeeded' : record.restartOutcome
    if (persistedRecord && hasSameLifecycleIdentity(persistedRecord, record)) {
      const persistedHasExitDetail = persistedRecord.exitCode !== null || persistedRecord.exitSignal !== null
      const recordHasExitDetail = record.exitCode !== null || record.exitSignal !== null
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
): Promise<void> {
  await persistProxyExit(
    {
      timestamp: proxy.generation,
      childPid: proxy.pid,
      exitCode: null,
      exitSignal: null,
      restartOutcome: 'not-attempted',
    },
    portFilePath,
    lifecycleFilePath,
  )
}

async function persistProxyExitWithCoordination(
  record: ProxyLifecycleRecord,
  proxy: ProxyInfo,
  portFilePath: string,
  lifecycleFilePath: string,
): Promise<void> {
  await withSharedLock(`${portFilePath}.lock`, PROXY_LOCK_MAX_WAIT_MS, async () => {
    await persistProxyExit(record, portFilePath, lifecycleFilePath)
    removeOwnedProxyPortFile(portFilePath, proxy)
  })
}

function handleProxyExit(event: ProxyExitEvent, portFilePath: string, lifecycleFilePath: string): void {
  const record: ProxyLifecycleRecord = {
    timestamp: event.generation,
    childPid: event.childPid,
    exitCode: event.exitCode,
    exitSignal: event.exitSignal,
    restartOutcome: 'not-attempted',
  }
  const pendingExit: PendingProxyExit = { record, persistence: null }
  pendingProxyExits.set(lifecycleFilePath, pendingExit)
  const persistence = persistProxyExitWithCoordination(
    record,
    { port: event.port, pid: event.childPid, generation: event.generation },
    portFilePath,
    lifecycleFilePath,
  )
  pendingExit.persistence = persistence
  const clearPendingExit = (): void => {
    if (pendingProxyExits.get(lifecycleFilePath) === pendingExit) {
      pendingProxyExits.delete(lifecycleFilePath)
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

function isActiveProxyConnection(connection: ProxyInfo): boolean {
  return (
    activeConnection?.port === connection.port &&
    activeConnection.pid === connection.pid &&
    activeConnection.generation === connection.generation &&
    isProcessAlive(connection.pid)
  )
}

async function finalizeProxyConnection<T extends ProxyInfo & { models: CursorModel[] }>(
  connection: T,
  portFilePath: string,
  lifecycleFilePath: string,
): Promise<T> {
  const connectionCurrent = await completePendingRestart(
    'succeeded',
    lifecycleFilePath,
    () => isActiveProxyConnection(connection),
    false,
  )
  if (!connectionCurrent) {
    if (
      activeConnection?.port === connection.port &&
      activeConnection.pid === connection.pid &&
      activeConnection.generation === connection.generation
    ) {
      stopHeartbeat()
    }
    removeOwnedProxyPortFile(portFilePath, connection)
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
  const lockResult = await withSharedLock(`${portFilePath}.lock`, PROXY_LOCK_MAX_WAIT_MS, async () => {
    try {
      const parsedPortFile = parsePortFile(portFilePath)
      const existing = parsedPortFile.info
      if (existing && isProcessAlive(existing.pid) && (await isProxyHealthy(existing.port))) {
        if (accessToken) {
          await pushToken(existing.port, accessToken)
        }
        startHeartbeat(existing.port, existing.pid, existing.generation, getSessionId)
        const models = await getModels(existing.port)
        return await finalizeProxyConnection(
          { port: existing.port, pid: existing.pid, generation: existing.generation, models },
          portFilePath,
          lifecycleFilePath,
        )
      }
      if (existing && !isProcessAlive(existing.pid)) {
        await persistObservedProxyExit(existing, portFilePath, lifecycleFilePath)
      }
      if (existing) {
        removeOwnedProxyPortFile(portFilePath, existing)
      } else if (parsedPortFile.exists) {
        try {
          unlinkSync(portFilePath)
        } catch {}
      }

      if (!accessToken) {
        throw new Error('No access token and no existing proxy')
      }
      const result = await spawnProxy(getSessionId, accessToken, {
        portFilePath,
        lifecycleFilePath,
        proxyEntry: options.proxyEntry ?? PROXY_ENTRY,
      })
      return await finalizeProxyConnection(result, portFilePath, lifecycleFilePath)
    } catch (error) {
      await completePendingRestart('failed', lifecycleFilePath, undefined, false)
      throw error
    }
  })
  if (!lockResult.acquired) {
    throw new Error('Timed out waiting for shared proxy recovery')
  }
  return lockResult.value
}

async function spawnProxy(
  getSessionId: () => string,
  accessToken: string,
  options: Required<ProxyConnectOptions>,
): Promise<{ port: number; pid: number; generation: string; models: CursorModel[] }> {
  const generation = new Date().toISOString()
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

function startHeartbeat(port: number, pid: number, generation: string, getSessionId: () => string): void {
  stopHeartbeat()
  // Resolve the session ID at each send so heartbeats follow session_start updates.
  void sendHeartbeat(port, getSessionId()) // immediate first heartbeat
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
