/**
 * Structured JSONL debug logger for the Cursor proxy.
 *
 * Gated behind `PI_CURSOR_PROVIDER_DEBUG=1`. When disabled, all log
 * functions are zero-cost no-ops. Log entries are appended to
 * `~/.pi/agent/cursor-debug.jsonl` by default; override the path with
 * `PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE`.
 *
 * Entries are never written on the caller's stack: each log call queues one
 * JSONL line and returns. A single-flight async writer batches queued lines
 * per flush, so a proxy stderr storm cannot block the extension's event loop
 * with synchronous filesystem work.
 *
 * Each initDebugLogger() call opens a new generation. A generation owns its
 * path, queue, size estimate, and write state, so async filesystem work
 * started by an old generation mutates only that generation and a re-init
 * mid-write cannot corrupt the new configuration. Batch writes serialize on
 * one process-wide chain, so two generations that share a path can never
 * reorder records.
 *
 * Accepted bytes are capped across pending and in-flight entries; entries
 * beyond the cap are dropped, and the queue reports each loss as an ordered
 * `log_drop` entry. Each append payload stays within a one-syscall bound
 * and splits only between complete JSONL records, so processes that share
 * the file cannot interleave inside a record. Call flushDebugLogger() during
 * shutdown so queued entries reach the file.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ── Types ──

type DebugEventType =
  | 'request_start'
  | 'request_end'
  | 'session_create'
  | 'session_resume'
  | 'checkpoint_commit'
  | 'checkpoint_discard'
  | 'retry'
  | 'tool_call'
  | 'bridge_open'
  | 'bridge_close'
  | 'lineage_invalidation'
  | 'lifecycle'
  | 'proxy_stderr'
  | 'log_drop'

interface DebugLogEntry {
  timestamp: string
  type: DebugEventType
  sessionId: string
  requestId: string
  [key: string]: unknown
}

/** One accepted JSONL line waiting in a generation's queue */
interface QueuedEntry {
  line: string
  bytes: number
}

/** A count of entries lost at this position in the queue's chronology */
interface QueuedDrop {
  dropped: number
}

type QueueItem = QueuedEntry | QueuedDrop

function isDrop(item: QueueItem): item is QueuedDrop {
  return 'dropped' in item
}

/**
 * One append payload: a run of serialized JSONL records within the
 * one-syscall bound, with the accounting the failure path restores when
 * the append rejects.
 */
interface AppendGroup {
  /** Serialized lines; drop markers sit at their chronology in the run */
  lines: QueuedEntry[]
  /** Accepted log entries; drop marker lines are not counted */
  entryCount: number
  /** Lost entries this group's own markers already represent */
  dropped: number
  bytes: number
}

/**
 * Reports a failed append payload plus every unattempted payload after
 * it, so failure accounting restores exactly the unpersisted suffix of a
 * split batch and never recounts a persisted prefix.
 */
class AppendSuffixError extends Error {
  constructor(
    message: string,
    /** The failed payload plus every unattempted payload after it */
    readonly remaining: AppendGroup[],
    cause?: unknown,
  ) {
    super(message, { cause })
  }
}

// ── Bounds ──

/** Max log file size before rotation (50 MB) */
const MAX_LOG_SIZE_BYTES = 50 * 1024 * 1024
/** Flush the queue this long after the first queued entry */
const FLUSH_DELAY_MS = 100
/** Start a flush without waiting for the timer once the queue holds this much */
const FLUSH_BATCH_BYTES = 256 * 1024
/** Hard cap on accepted bytes across pending plus in-flight entries */
const MAX_PENDING_BYTES = 4 * 1024 * 1024
/**
 * Hard bound on one appendFile payload. Node splits appendFile writes above
 * 512 KiB across several write syscalls, and O_APPEND is atomic only per
 * syscall, so a split payload can interleave partial records with writes
 * from other processes that share the file. 256 KiB keeps every append one
 * syscall, and batches split only between complete JSONL records.
 */
const MAX_APPEND_BYTES = 256 * 1024
/** Only stat the real file every N entries to re-sync the size estimate */
const STAT_INTERVAL = 100

// ── Generation state ──

/**
 * State for one logger configuration. initDebugLogger() closes the previous
 * generation and installs a new one. Async completions mutate only the
 * generation they started in, so old writes stay on the old path and never
 * alter or report into the new configuration.
 */
interface Generation {
  path: string
  dirEnsured: boolean
  /** In-memory size estimate; the writer re-syncs it every STAT_INTERVAL entries */
  estimatedSize: number
  writesSinceStat: number
  /** Chronological queue of accepted entries and drop counts */
  queue: QueueItem[]
  /** Accepted entry bytes waiting in the queue */
  pendingBytes: number
  /** Batch bytes an append currently carries for this generation */
  inflightBytes: number
  /** Entries lost to failed batches, waiting for the next written batch to report them */
  lostEntries: number
  /** True while the writer drains this generation's queue */
  writing: boolean
  /** True once initDebugLogger() replaced this generation */
  closed: boolean
  flushTimer: NodeJS.Timeout | null
  /** Resolvers waiting for this generation to sit idle with an empty queue */
  idleWaiters: (() => void)[]
}

/** The active generation; null while debug logging is disabled */
let _current: Generation | null = null

/**
 * Serializes batch writes across generations in this process. Jobs run in
 * first-come order, so generations that share a path append in queue order
 * and never interleave a batch.
 */
let _writeChain: Promise<void> = Promise.resolve()

/** Write jobs this process ever enqueued and ever settled */
let _jobsEnqueued = 0
let _jobsSettled = 0

/** One flush fence waiting for its pre-call jobs to settle */
interface JobWaiter {
  target: number
  resolve: () => void
}

let _jobWaiters: JobWaiter[] = []

function unrefTimer(timer: NodeJS.Timeout): void {
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
}

/**
 * Resolve every fence whose target the settled count reached. Jobs settle
 * in enqueue order on the serialized chain, so a fence target is reached
 * exactly when that fence's last pre-call job settled, even while younger
 * jobs accepted after the fence keep running.
 */
function notifyJobsSettled(): void {
  const ready = _jobWaiters.filter((waiter) => _jobsSettled >= waiter.target)
  if (ready.length === 0) {
    return
  }
  _jobWaiters = _jobWaiters.filter((waiter) => _jobsSettled < waiter.target)
  for (const waiter of ready) {
    waiter.resolve()
  }
}

/** Queue one batch write job behind every other job in this process */
function enqueueWrite(job: () => Promise<void>): Promise<void> {
  _jobsEnqueued++
  const run = _writeChain.then(job)
  // The chain itself never rejects; the caller handles each job's outcome.
  _writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  const settle = (): void => {
    _jobsSettled++
    notifyJobsSettled()
  }
  // The counting side chain always resolves, so a failed job never
  // reports an unhandled rejection here.
  void run.then(settle, settle)
  return run
}

// ── Per-generation filesystem steps ──

async function ensureDir(gen: Generation): Promise<void> {
  if (gen.dirEnsured) {
    return
  }
  try {
    await mkdir(dirname(gen.path), { recursive: true })
    gen.dirEnsured = true
  } catch {
    // best-effort; retried with the next batch
  }
}

/** Sync the in-memory size estimate with the actual file size */
async function syncFileSize(gen: Generation): Promise<void> {
  try {
    gen.estimatedSize = (await stat(gen.path)).size
  } catch {
    gen.estimatedSize = 0
  }
}

/** Rotate the log file if the size estimate exceeds the size limit */
async function rotateIfNeeded(gen: Generation): Promise<void> {
  if (gen.estimatedSize <= MAX_LOG_SIZE_BYTES) {
    return
  }
  try {
    await rename(gen.path, `${gen.path}.old`)
    gen.estimatedSize = 0
  } catch {
    // best-effort
  }
}

function dropMarkerLine(dropped: number): string {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'log_drop',
    sessionId: '',
    requestId: '',
    dropped,
  })}\n`
}

/** Count one entry lost at the queue's tail, after every accepted entry */
function recordDrop(gen: Generation): void {
  const tail = gen.queue.at(-1)
  if (tail !== undefined && isDrop(tail)) {
    tail.dropped++
    return
  }
  gen.queue.push({ dropped: 1 })
}

/**
 * Drain the queue into append-sized groups. A loss from a failed batch
 * becomes a leading marker, so it precedes every entry queued after that
 * failure; overflow drops keep their tail position after the accepted
 * entries that preceded the loss. Groups split only between complete
 * JSONL records, so each payload stays within the one-syscall bound.
 */
function takeBatch(gen: Generation): AppendGroup[] {
  const items = gen.queue
  gen.queue = []
  // Accepted bytes move into the in-flight total without shrinking the
  // aggregate; the cap stays enforced while the append runs.
  gen.inflightBytes += gen.pendingBytes
  gen.pendingBytes = 0
  const groups: AppendGroup[] = []
  let group: AppendGroup | null = null
  const addLine = (line: string, bytes: number, dropped: number): void => {
    if (group === null || group.bytes + bytes > MAX_APPEND_BYTES) {
      group = { lines: [], entryCount: 0, dropped: 0, bytes: 0 }
      groups.push(group)
    }
    group.lines.push({ line, bytes })
    group.bytes += bytes
    group.dropped += dropped
    if (dropped > 0) {
      // Marker bytes never sat in the pending total; they enlarge the
      // in-flight aggregate here instead.
      gen.inflightBytes += bytes
    } else {
      group.entryCount++
    }
  }
  const lost = gen.lostEntries
  gen.lostEntries = 0
  if (lost > 0) {
    const line = dropMarkerLine(lost)
    addLine(line, Buffer.byteLength(line), lost)
  }
  for (const item of items) {
    if (isDrop(item)) {
      const line = dropMarkerLine(item.dropped)
      addLine(line, Buffer.byteLength(line), item.dropped)
      continue
    }
    addLine(item.line, item.bytes, 0)
  }
  return groups
}

/** Join one group's lines into its single appendFile payload */
function groupPayload(group: AppendGroup): string {
  let payload = ''
  for (const { line } of group.lines) {
    payload += line
  }
  return payload
}

function notifyIdle(gen: Generation): void {
  if (gen.writing || gen.queue.length > 0) {
    return
  }
  const waiters = gen.idleWaiters
  gen.idleWaiters = []
  for (const resolve of waiters) {
    resolve()
  }
}

/**
 * Write queued entries, one batch in flight at a time. Drains everything
 * queued during a write, so callers never wait per entry. A batch splits
 * into append-sized payloads whose accounting retires as each payload
 * persists; a failed payload loses only itself and the unattempted suffix,
 * which the next written batch reports as one cumulative drop count.
 */
async function runWriter(gen: Generation): Promise<void> {
  if (gen.writing || gen.queue.length === 0) {
    return
  }
  gen.writing = true
  try {
    while (!gen.closed && gen.queue.length > 0) {
      const groups = takeBatch(gen)
      try {
        await enqueueWrite(async () => {
          await ensureDir(gen)
          for (const [index, group] of groups.entries()) {
            gen.writesSinceStat += group.entryCount
            if (gen.writesSinceStat >= STAT_INTERVAL) {
              // One stat per append group, even when the group crossed
              // several conceptual intervals. The modulo keeps the
              // surplus counted toward the next interval instead of
              // losing it in a reset to zero.
              gen.writesSinceStat %= STAT_INTERVAL
              await syncFileSize(gen)
            }
            await rotateIfNeeded(gen)
            try {
              await appendFile(gen.path, groupPayload(group), { mode: 0o600 })
            } catch (error) {
              // A rejected payload counts as wholly unpersisted; the
              // prefix that already persisted stays retired.
              throw new AppendSuffixError('append payload failed', groups.slice(index), error)
            }
            gen.inflightBytes -= group.bytes
            gen.estimatedSize += group.bytes
          }
        })
      } catch (error) {
        // Restore only the failed payload plus the unattempted suffix:
        // their entries and the markers they carried are re-reported by
        // the next written batch, and a marker already persisted in a
        // successful prefix payload is never repeated. A closed
        // generation's loop stops after this batch; its counter is never
        // read again.
        const remaining = error instanceof AppendSuffixError ? error.remaining : groups
        for (const group of remaining) {
          gen.inflightBytes -= group.bytes
          gen.lostEntries += group.entryCount + group.dropped
        }
      }
    }
  } finally {
    gen.writing = false
    notifyIdle(gen)
  }
}

function scheduleFlushTimer(gen: Generation): void {
  // While the writer runs, its loop picks up new entries itself, so a timer
  // would only pile up behind the write it is waiting for.
  if (gen.flushTimer !== null || gen.writing) {
    return
  }
  gen.flushTimer = setTimeout(() => {
    gen.flushTimer = null
    void runWriter(gen)
  }, FLUSH_DELAY_MS)
  unrefTimer(gen.flushTimer)
}

function cancelFlushTimer(gen: Generation): void {
  if (gen.flushTimer === null) {
    return
  }
  clearTimeout(gen.flushTimer)
  gen.flushTimer = null
}

function writeEntry(entry: DebugLogEntry): void {
  const gen = _current
  if (gen === null) {
    return
  }
  const line = `${JSON.stringify(entry)}\n`
  const size = Buffer.byteLength(line)
  // Reject entries no bounded append could ever carry, and entries that
  // alone exceed the queue cap; both count as drops.
  if (size > MAX_APPEND_BYTES || size > MAX_PENDING_BYTES) {
    recordDrop(gen)
    // An isolated oversized drop must still reach the file: schedule the
    // normal flush timer so the marker persists without another entry or
    // an explicit flush. No-op while a timer is live or the writer runs.
    scheduleFlushTimer(gen)
    return
  }
  // The cap covers pending plus in-flight accepted bytes: a slow append
  // must not let the queue grow a second full budget behind it.
  if (gen.pendingBytes + gen.inflightBytes + size > MAX_PENDING_BYTES) {
    recordDrop(gen)
    return
  }
  gen.queue.push({ line, bytes: size })
  gen.pendingBytes += size
  if (!gen.writing && gen.pendingBytes >= FLUSH_BATCH_BYTES) {
    cancelFlushTimer(gen)
    void runWriter(gen)
    return
  }
  scheduleFlushTimer(gen)
}

// ── Public API ──

/** Generate a per-request UUID. Returns empty string when disabled. */
export function debugRequestId(): string {
  if (_current === null) {
    return ''
  }
  return crypto.randomUUID()
}

/** Log a new chat completion request. */
export function logRequestStart(
  sessionId: string,
  requestId: string,
  payload: { model: string; messageCount: number; toolsCount: number },
): void {
  if (_current === null) {
    return
  }
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'request_start',
    sessionId,
    requestId,
    model: payload.model,
    messageCount: payload.messageCount,
    toolsCount: payload.toolsCount,
  })
}

/** Log a completed request. */
export function logRequestEnd(
  sessionId: string,
  requestId: string,
  payload: { durationMs: number; error?: string },
): void {
  if (_current === null) {
    return
  }
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'request_end',
    sessionId,
    requestId,
    durationMs: payload.durationMs,
    ...(payload.error ? { error: payload.error } : {}),
  })
}

/** Log session creation. */
export function logSessionCreate(
  sessionId: string,
  requestId: string,
  payload: { sessionKey: string; conversationKey: string },
): void {
  if (_current === null) {
    return
  }
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'session_create',
    sessionId,
    requestId,
    sessionKey: payload.sessionKey,
    conversationKey: payload.conversationKey,
  })
}

/** Log session reuse. */
export function logSessionResume(sessionId: string, requestId: string, payload: { sessionKey: string }): void {
  if (_current === null) {
    return
  }
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'session_resume',
    sessionId,
    requestId,
    sessionKey: payload.sessionKey,
  })
}

/** Log checkpoint commit. */
export function logCheckpointCommit(sessionId: string, requestId: string, payload: { sizeBytes: number }): void {
  if (_current === null) {
    return
  }
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'checkpoint_commit',
    sessionId,
    requestId,
    sizeBytes: payload.sizeBytes,
  })
}

/** Log a retry attempt. */
export function logRetry(
  sessionId: string,
  requestId: string,
  payload: { attempt: number; hint: string; delayMs: number },
): void {
  if (_current === null) {
    return
  }
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'retry',
    sessionId,
    requestId,
    attempt: payload.attempt,
    hint: payload.hint,
    delayMs: payload.delayMs,
  })
}

/** Log lineage invalidation (compaction, fork, branch switch). */
export function logLineageInvalidation(
  sessionId: string,
  requestId: string,
  payload: { storedTurnCount: number; incomingTurnCount: number; blobCount: number },
): void {
  if (_current === null) {
    return
  }
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'lineage_invalidation',
    sessionId,
    requestId,
    storedTurnCount: payload.storedTurnCount,
    incomingTurnCount: payload.incomingTurnCount,
    blobCount: payload.blobCount,
  })
}

/** Log extension lifecycle event. */
export function logLifecycle(sessionId: string, requestId: string, payload: { event: string }): void {
  if (_current === null) {
    return
  }
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'lifecycle',
    sessionId,
    requestId,
    event: payload.event,
  })
}

/** Log text captured from the proxy child process stderr stream. */
export function logProxyStderr(sessionId: string, output: string): void {
  if (_current === null) {
    return
  }
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'proxy_stderr',
    sessionId,
    requestId: '',
    output,
  })
}

/** A removable wait: cancel drops the waiter and resolves the promise */
interface Subscription {
  promise: Promise<void>
  cancel: () => void
}

const RESOLVED_SUBSCRIPTION: Subscription = {
  promise: Promise.resolve(),
  cancel: () => undefined,
}

/**
 * Subscribe to the generation reaching empty idle. The subscription is
 * removable, so a timed-out flush leaves no waiter behind while the shared
 * writer keeps running.
 */
function subscribeIdle(gen: Generation): Subscription {
  if (!gen.writing && gen.queue.length === 0) {
    return RESOLVED_SUBSCRIPTION
  }
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  gen.idleWaiters.push(resolve)
  return {
    promise,
    cancel: () => {
      const index = gen.idleWaiters.indexOf(resolve)
      if (index >= 0) {
        gen.idleWaiters.splice(index, 1)
      }
      resolve()
    },
  }
}

/**
 * Subscribe to every write job this process accepted before now having
 * settled. The fence covers in-flight appends of closed or replaced
 * generations, which no single generation's idle state can observe.
 */
function subscribeJobsSettled(): Subscription {
  const target = _jobsEnqueued
  if (_jobsSettled >= target) {
    return RESOLVED_SUBSCRIPTION
  }
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  const waiter: JobWaiter = { target, resolve }
  _jobWaiters.push(waiter)
  return {
    promise,
    cancel: () => {
      const index = _jobWaiters.indexOf(waiter)
      if (index >= 0) {
        _jobWaiters.splice(index, 1)
      }
      resolve()
    },
  }
}

/**
 * Wait until every entry queued for the active generation is written or
 * has failed best-effort, and every write job this process accepted
 * before the call has settled, including in-flight appends of closed or
 * replaced generations: a disabled or idle current generation cannot
 * bypass them. Cancels the flush delay so the wait is immediate. Never
 * rejects; safe to call when disabled or idle. With `timeoutMs`, one
 * deadline bounds the aggregate wait while the writer continues; the
 * flush then removes its own waiters and deadline timer, so repeated
 * bounded flushes against a stuck write retain nothing.
 */
export function flushDebugLogger(timeoutMs?: number): Promise<void> {
  const gen = _current
  // Start the current generation's queued writer before the process-wide
  // fence, so entries it already accepted count as outstanding jobs.
  if (gen !== null) {
    cancelFlushTimer(gen)
    if (!gen.writing && gen.queue.length > 0) {
      void runWriter(gen)
    }
  }
  const genSubscription = gen === null ? RESOLVED_SUBSCRIPTION : subscribeIdle(gen)
  const jobSubscription = subscribeJobsSettled()
  const drained = Promise.all([genSubscription.promise, jobSubscription.promise]).then(() => undefined)
  if (timeoutMs === undefined) {
    return drained
  }
  return new Promise<void>((resolve) => {
    let finished = false
    let timer: NodeJS.Timeout | null = null
    const finish = () => {
      if (finished) {
        return
      }
      finished = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      genSubscription.cancel()
      jobSubscription.cancel()
      resolve()
    }
    timer = setTimeout(finish, timeoutMs)
    unrefTimer(timer)
    void drained.then(finish)
  })
}

// ── Initialization ──

export function isDebugLoggingEnabled(): boolean {
  return _current !== null
}

/**
 * Initialize the debug logger from environment variables.
 * Call once at startup. Safe to call multiple times.
 *
 * Each call serves a new configuration as a fresh generation. The previous
 * generation closes: its queued entries are discarded so they can never
 * reach the new path, and its in-flight batch finishes against the old
 * generation's own state without altering the new one.
 */
export function initDebugLogger(): void {
  if (_current !== null) {
    _current.closed = true
    cancelFlushTimer(_current)
    _current.queue = []
    _current.pendingBytes = 0
  }
  _current = null
  if (process.env.PI_CURSOR_PROVIDER_DEBUG !== '1') {
    return
  }
  const path =
    process.env.PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE ?? join(homedir(), '.pi', 'agent', 'cursor-debug.jsonl')
  _current = {
    path,
    dirEnsured: false,
    estimatedSize: 0,
    writesSinceStat: 0,
    queue: [],
    pendingBytes: 0,
    inflightBytes: 0,
    lostEntries: 0,
    writing: false,
    closed: false,
    flushTimer: null,
    idleWaiters: [],
  }
}

// Parent and proxy entry points initialize their process-local logger explicitly.
