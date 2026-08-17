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
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const SHARED_LOCK_RETRY_MS = 5
export const SHARED_LOCK_STALE_MS = 2_000
const PROCESS_IDENTITY_CACHE_MS = 250

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

export type SharedLockResult<T> = { acquired: true; value: T } | { acquired: false }

const processIdentityCache = new Map<string, { observedAt: number; identity: ProcessIdentity }>()
let currentProcessIdentity: string | null | undefined

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
  return entry.modifiedAt > now + SHARED_LOCK_STALE_MS || now - entry.modifiedAt >= SHARED_LOCK_STALE_MS
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
  const choosingPath = join(lockPath, `${String(owner.ownerPid)}-${owner.ownerId}.choosing`)
  try {
    writeFileSync(choosingPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
    const sequence = getNextTicketSequence(lockPath).toString().padStart(24, '0')
    const ticketName = `${sequence}-${String(owner.ownerPid)}-${owner.ownerId}.ticket`
    const ticketPath = join(lockPath, ticketName)
    renameSync(choosingPath, ticketPath)
    return { ticketName, ticketPath }
  } catch {
    try {
      unlinkSync(choosingPath)
    } catch {}
    return null
  }
}

function getLiveSharedLockNames(lockPath: string, suffix: '.choosing' | '.ticket', maxProbeMs: number): string[] {
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
    if (!isSharedLockEntryStale(entry, remainingProbeMs)) {
      liveNames.push(name)
      continue
    }
    try {
      unlinkSync(path)
    } catch {}
  }
  return liveNames
}

function canEnterSharedLock(lockPath: string, lock: AcquiredSharedLock, maxProbeMs: number): boolean {
  if (!existsSync(lock.ticketPath)) {
    return false
  }
  if (getLiveSharedLockNames(lockPath, '.choosing', maxProbeMs).length > 0) {
    return false
  }
  return getLiveSharedLockNames(lockPath, '.ticket', maxProbeMs)[0] === lock.ticketName
}

function stillOwnsSharedLock(lockPath: string, lock: AcquiredSharedLock, maxProbeMs: number): boolean {
  return existsSync(lock.ticketPath) && getLiveSharedLockNames(lockPath, '.ticket', maxProbeMs)[0] === lock.ticketName
}

function releaseSharedLock(lockPath: string, lock: AcquiredSharedLock): void {
  try {
    unlinkSync(lock.ticketPath)
  } catch {}
  try {
    rmdirSync(lockPath)
  } catch {}
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
      lock ??= createSharedLockTicket(lockPath, remainingMs)
      const ownershipRemainingMs = Math.max(0, deadline - performance.now())
      if (lock && canEnterSharedLock(lockPath, lock, ownershipRemainingMs) && performance.now() < deadline) {
        const value = await operation()
        if (!stillOwnsSharedLock(lockPath, lock, SHARED_LOCK_STALE_MS)) {
          throw new Error(`Lost shared lock ${lockPath}`)
        }
        return { acquired: true, value }
      }
      if (lock && !existsSync(lock.ticketPath)) {
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
