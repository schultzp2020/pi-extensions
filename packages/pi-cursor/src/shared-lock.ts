import { spawnSync } from 'node:child_process'
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
import { connect, createServer, type Server } from 'node:net'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const SHARED_LOCK_RETRY_MS = 5
export const SHARED_LOCK_STALE_MS = 2_000
const PROCESS_IDENTITY_CACHE_MS = 250
const SHARED_LOCK_INCARNATION_PREFIX = '/tmp/pi-cursor-lock-'

interface SharedLockOwner {
  ownerPid: number
  ownerId: string
  acquiredAt: number
  processIdentity: string | null
  incarnationSocket: string | null
}

interface SharedLockEntry {
  modifiedAt: number
  owner: SharedLockOwner | null
}

interface AcquiredSharedLock {
  ticketName: string
  ticketPath: string
  incarnation: SharedLockIncarnation | null
}

interface SharedLockIncarnation {
  path: string
  server: Server
}

type ProcessIdentity = { status: 'running'; identity: string } | { status: 'stopped' } | { status: 'unknown' }
type IncarnationStatus = 'running' | 'stopped' | 'unknown'

export type SharedLockResult<T> = { acquired: true; value: T } | { acquired: false }

const processIdentityCache = new Map<string, { observedAt: number; identity: ProcessIdentity }>()
let currentProcessIdentity: string | null | undefined

function supportsIncarnationSocket(): boolean {
  return (
    process.platform === 'linux' ||
    process.platform === 'darwin' ||
    process.platform === 'freebsd' ||
    process.platform === 'openbsd'
  )
}

function getIncarnationSocketPath(ownerId: string): string | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) {
    return null
  }
  return `${SHARED_LOCK_INCARNATION_PREFIX}${ownerId}.sock`
}

function closeSharedLockIncarnation(incarnation: SharedLockIncarnation | null): void {
  if (!incarnation) {
    return
  }
  try {
    incarnation.server.close()
  } catch {}
  try {
    unlinkSync(incarnation.path)
  } catch {}
}

async function createSharedLockIncarnation(ownerId: string): Promise<SharedLockIncarnation | null> {
  if (!supportsIncarnationSocket()) {
    return null
  }
  const path = getIncarnationSocketPath(ownerId)
  if (!path) {
    return null
  }
  const server = createServer((socket) => socket.destroy())
  return await new Promise<SharedLockIncarnation | null>((resolveIncarnation) => {
    const onError = (): void => {
      server.removeListener('listening', onListening)
      closeSharedLockIncarnation({ path, server })
      resolveIncarnation(null)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      server.on('error', () => {})
      server.unref()
      resolveIncarnation({ path, server })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(path)
  })
}

async function observeSharedLockIncarnation(path: string, maxProbeMs: number): Promise<IncarnationStatus> {
  const timeout = getProbeTimeout(maxProbeMs, 250)
  if (timeout === null) {
    return 'unknown'
  }
  return await new Promise<IncarnationStatus>((resolveStatus) => {
    const socket = connect(path)
    socket.unref()
    let settled = false
    const finish = (status: IncarnationStatus): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolveStatus(status)
    }
    const timer = setTimeout(() => finish('unknown'), timeout)
    socket.once('connect', () => finish('running'))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'stopped' : 'unknown')
    })
  })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
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
    env: { ...process.env, LANG: 'C', LANGUAGE: 'C', LC_ALL: 'C', TZ: 'UTC' },
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

function parseSharedLockOwner(value: unknown): SharedLockOwner | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const { ownerPid, ownerId, acquiredAt, processIdentity, incarnationSocket } = record
  if (
    typeof ownerPid !== 'number' ||
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 0 ||
    typeof ownerId !== 'string' ||
    ownerId.length === 0 ||
    typeof acquiredAt !== 'number' ||
    !Number.isFinite(acquiredAt) ||
    acquiredAt <= 0 ||
    (typeof processIdentity !== 'string' && processIdentity !== null && processIdentity !== undefined) ||
    (typeof incarnationSocket !== 'string' && incarnationSocket !== null && incarnationSocket !== undefined)
  ) {
    return null
  }
  const expectedIncarnationSocket = getIncarnationSocketPath(ownerId)
  if (typeof incarnationSocket === 'string' && incarnationSocket !== expectedIncarnationSocket) {
    return null
  }
  return {
    ownerPid,
    ownerId,
    acquiredAt,
    processIdentity: typeof processIdentity === 'string' ? processIdentity : null,
    incarnationSocket: typeof incarnationSocket === 'string' ? incarnationSocket : null,
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

async function isSharedLockEntryStale(entry: SharedLockEntry, maxProbeMs: number): Promise<boolean> {
  if (entry.owner) {
    if (entry.owner.incarnationSocket) {
      const incarnation = await observeSharedLockIncarnation(entry.owner.incarnationSocket, maxProbeMs)
      if (incarnation === 'running') {
        return false
      }
      if (incarnation === 'stopped') {
        return true
      }
      return false
    }
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
  return entry.modifiedAt > now + SHARED_LOCK_STALE_MS || now - entry.modifiedAt >= SHARED_LOCK_STALE_MS
}

async function ensureSharedLockDirectory(lockPath: string, maxProbeMs: number): Promise<boolean> {
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
  if (!legacyEntry || !(await isSharedLockEntryStale(legacyEntry, maxProbeMs))) {
    return false
  }
  try {
    unlinkSync(lockPath)
  } catch {}
  return false
}

function getNextTicketSequence(lockPath: string): bigint {
  let highest = 0n
  try {
    for (const name of readdirSync(lockPath)) {
      const match = /^(\d+)-.*\.ticket$/.exec(name)
      if (!match?.[1]) {
        continue
      }
      try {
        const sequence = BigInt(match[1])
        if (sequence > highest) {
          highest = sequence
        }
      } catch {}
    }
  } catch {}
  return highest + 1n
}

async function createSharedLockTicket(lockPath: string, maxProbeMs: number): Promise<AcquiredSharedLock | null> {
  if (!(await ensureSharedLockDirectory(lockPath, maxProbeMs))) {
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
  const ownerId = randomUUID()
  const incarnation = await createSharedLockIncarnation(ownerId)
  if (supportsIncarnationSocket() && !incarnation) {
    return null
  }
  const owner: SharedLockOwner = {
    ownerPid: process.pid,
    ownerId,
    acquiredAt: Date.now(),
    processIdentity,
    incarnationSocket: incarnation?.path ?? null,
  }
  const choosingPath = join(lockPath, `${String(owner.ownerPid)}-${owner.ownerId}.choosing`)
  try {
    writeFileSync(choosingPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
    const sequence = getNextTicketSequence(lockPath).toString().padStart(24, '0')
    const ticketName = `${sequence}-${String(owner.ownerPid)}-${owner.ownerId}.ticket`
    const ticketPath = join(lockPath, ticketName)
    renameSync(choosingPath, ticketPath)
    return { ticketName, ticketPath, incarnation }
  } catch {
    try {
      unlinkSync(choosingPath)
    } catch {}
    closeSharedLockIncarnation(incarnation)
    return null
  }
}

async function getLiveSharedLockNames(
  lockPath: string,
  suffix: '.choosing' | '.ticket',
  maxProbeMs: number,
): Promise<string[]> {
  const startedAt = performance.now()
  let names: string[]
  try {
    names = readdirSync(lockPath)
      .filter((name) => name.endsWith(suffix))
      .sort()
  } catch {
    return []
  }
  const liveNames: string[] = []
  for (const name of names) {
    const path = join(lockPath, name)
    const entry = readSharedLockEntry(path)
    if (!entry) {
      continue
    }
    const remainingProbeMs = Math.max(0, maxProbeMs - (performance.now() - startedAt))
    if (!(await isSharedLockEntryStale(entry, remainingProbeMs))) {
      liveNames.push(name)
      continue
    }
    try {
      unlinkSync(path)
    } catch {}
    if (entry.owner?.incarnationSocket) {
      try {
        unlinkSync(entry.owner.incarnationSocket)
      } catch {}
    }
  }
  return liveNames
}

async function canEnterSharedLock(lockPath: string, lock: AcquiredSharedLock, maxProbeMs: number): Promise<boolean> {
  if (!existsSync(lock.ticketPath)) {
    return false
  }
  if ((await getLiveSharedLockNames(lockPath, '.choosing', maxProbeMs)).length > 0) {
    return false
  }
  return (await getLiveSharedLockNames(lockPath, '.ticket', maxProbeMs))[0] === lock.ticketName
}

async function stillOwnsSharedLock(lockPath: string, lock: AcquiredSharedLock, maxProbeMs: number): Promise<boolean> {
  return (
    existsSync(lock.ticketPath) &&
    (await getLiveSharedLockNames(lockPath, '.ticket', maxProbeMs))[0] === lock.ticketName
  )
}

function releaseSharedLock(lockPath: string, lock: AcquiredSharedLock): void {
  try {
    unlinkSync(lock.ticketPath)
  } catch {}
  try {
    rmdirSync(lockPath)
  } catch {}
  closeSharedLockIncarnation(lock.incarnation)
}

async function waitForSharedLockRetry(waitMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, waitMs)
    })
    return
  }
  signal.throwIfAborted()
  await new Promise<void>((resolveWait, rejectWait) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveWait()
    }, waitMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectWait(signal.reason ?? new Error('Operation aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function withSharedLock<T>(
  lockPath: string,
  maxWaitMs: number,
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<SharedLockResult<T>> {
  signal?.throwIfAborted()
  try {
    mkdirSync(resolve(lockPath, '..'), { recursive: true })
  } catch {
    return { acquired: false }
  }

  const deadline = performance.now() + maxWaitMs
  let lock: AcquiredSharedLock | null = null
  try {
    while (performance.now() < deadline) {
      signal?.throwIfAborted()
      const remainingMs = Math.max(0, deadline - performance.now())
      lock ??= await createSharedLockTicket(lockPath, remainingMs)
      const ownershipRemainingMs = Math.max(0, deadline - performance.now())
      if (lock && (await canEnterSharedLock(lockPath, lock, ownershipRemainingMs)) && performance.now() < deadline) {
        const value = await operation()
        if (!(await stillOwnsSharedLock(lockPath, lock, SHARED_LOCK_STALE_MS))) {
          throw new Error(`Lost shared lock ${lockPath}`)
        }
        return { acquired: true, value }
      }
      if (lock && !existsSync(lock.ticketPath)) {
        closeSharedLockIncarnation(lock.incarnation)
        lock = null
      }
      const waitMs = Math.min(SHARED_LOCK_RETRY_MS, Math.max(0, deadline - performance.now()))
      if (waitMs > 0) {
        await waitForSharedLockRetry(waitMs, signal)
      }
    }
    return { acquired: false }
  } finally {
    if (lock) {
      releaseSharedLock(lockPath, lock)
    }
  }
}
