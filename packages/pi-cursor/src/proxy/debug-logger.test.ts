import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flushDebugLogger, initDebugLogger, isDebugLoggingEnabled, logProxyStderr } from './debug-logger.ts'

// Mirrors the logger's private bounds. Keep in sync with debug-logger.ts.
const FLUSH_DELAY_MS = 100
const STAT_INTERVAL = 100
const MAX_PENDING_BYTES = 4 * 1024 * 1024
const MAX_APPEND_BYTES = 256 * 1024

const fsMocks = vi.hoisted(() => ({
  appendFile: vi.fn<(path: string, data: string, options: { mode?: number }) => Promise<void>>(),
  mkdir: vi.fn<(path: string, options: { recursive: boolean }) => Promise<string | undefined>>(),
  stat: vi.fn<(path: string) => Promise<{ size: number }>>(),
  rename: vi.fn<(from: string, to: string) => Promise<void>>(),
}))

// The real fs/promises, captured by the mock factory so tests can delegate
// to it for genuine end-to-end writes.
interface RealFsPromises {
  appendFile: (path: string, data: string, options: { mode?: number }) => Promise<void>
  mkdir: (path: string, options: { recursive: boolean }) => Promise<string | undefined>
  stat: (path: string) => Promise<{ size: number }>
  rename: (from: string, to: string) => Promise<void>
}

const realFsRef = vi.hoisted(() => ({ current: null as RealFsPromises | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  realFsRef.current = await importOriginal<RealFsPromises>()
  return {
    ...realFsRef.current,
    appendFile: fsMocks.appendFile,
    mkdir: fsMocks.mkdir,
    stat: fsMocks.stat,
    rename: fsMocks.rename,
  }
})

/** Real fs/promises for tests that mix gated mocks with genuine writes */
function realFs(): RealFsPromises {
  if (realFsRef.current === null) {
    throw new Error('real fs/promises not captured')
  }
  return realFsRef.current
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const logDirs: string[] = []

/** Each path lives in its own fresh subdirectory, so directory state is observable per path */
function newLogPath(): string {
  const dir = join(tmpdir(), `pi-cursor-debug-logger-${process.pid}-${crypto.randomUUID()}`)
  logDirs.push(dir)
  return join(dir, 'debug.jsonl')
}

function enable(path: string): void {
  vi.stubEnv('PI_CURSOR_PROVIDER_DEBUG', '1')
  vi.stubEnv('PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE', path)
  initDebugLogger()
}

function writtenPayloads(): string[] {
  return fsMocks.appendFile.mock.calls.map((call) => call[1])
}

function parseLines(payload: string): Record<string, unknown>[] {
  return payload
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function stderrChunk(index: number): string {
  return `chunk-${String(index)}\n${'x'.repeat(64 * 1024)}`
}

/** Serialized size of one proxy_stderr line, mirroring the logger's JSON shape */
function stderrLineBytes(output: string): number {
  return Buffer.byteLength(
    `${JSON.stringify({
      // toISOString() always measures 24 characters.
      timestamp: '2024-01-01T00:00:00.000Z',
      type: 'proxy_stderr',
      sessionId: 'session-1',
      requestId: '',
      output,
    })}\n`,
  )
}

/** Output whose serialized entry line measures exactly target bytes */
function fixedLineOutput(targetBytes: number, id: string): string {
  const prefix = `${id}\n`
  const pad = targetBytes - stderrLineBytes(prefix)
  if (pad < 0) {
    throw new Error(`id prefix already exceeds the ${String(targetBytes)} byte target`)
  }
  return prefix + 'x'.repeat(pad)
}

function stderrOutputs(entries: Record<string, unknown>[]): string[] {
  return entries.filter((entry) => entry.type === 'proxy_stderr').map((entry) => String(entry.output))
}

// Delegate to the real fs/promises by default so end-to-end writes hit a
// real file. Tests that need call assertions override with plain mocks.
function delegateToRealFs(): void {
  const real = realFsRef.current
  if (real === null) {
    return
  }
  fsMocks.appendFile.mockImplementation((path, data, options) => real.appendFile(path, data, options))
  fsMocks.mkdir.mockImplementation((path, options) => real.mkdir(path, options))
  fsMocks.stat.mockImplementation((path) => real.stat(path))
  fsMocks.rename.mockImplementation((from, to) => real.rename(from, to))
}

beforeEach(() => {
  delegateToRealFs()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  initDebugLogger()
  vi.clearAllMocks()
  for (const dir of logDirs) {
    rmSync(dir, { force: true, recursive: true })
  }
  logDirs.length = 0
})

describe('proxy stderr debug logging', () => {
  it('writes captured output as structured JSONL when debug logging is enabled', async () => {
    const path = newLogPath()
    enable(path)

    logProxyStderr('session-1', '[proxy] Listening on port 1234\n')
    await flushDebugLogger()

    const entry = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(entry).toMatchObject({
      type: 'proxy_stderr',
      sessionId: 'session-1',
      requestId: '',
      output: '[proxy] Listening on port 1234\n',
    })
  })

  it('appends with mode 0o600 through the async writer', async () => {
    const path = newLogPath()
    enable(path)

    logProxyStderr('session-1', 'out\n')
    await flushDebugLogger()

    expect(fsMocks.appendFile).toHaveBeenCalledWith(path, expect.any(String), { mode: 0o600 })
  })

  it('stays disabled unless explicitly enabled', async () => {
    vi.stubEnv('PI_CURSOR_PROVIDER_DEBUG', undefined)
    initDebugLogger()

    expect(isDebugLoggingEnabled()).toBeFalsy()

    for (let i = 0; i < 100; i++) {
      logProxyStderr('session-1', `noise ${String(i)}\n`)
    }
    await flushDebugLogger()

    expect(fsMocks.appendFile).not.toHaveBeenCalled()
    expect(fsMocks.mkdir).not.toHaveBeenCalled()
    expect(logDirs.every((dir) => !existsSync(join(dir, 'debug.jsonl')))).toBeTruthy()
  })
})

describe('debug logger batching', () => {
  it('queues a stderr burst and writes it as one ordered JSONL batch', async () => {
    const path = newLogPath()
    enable(path)

    const events = Array.from({ length: 500 }, (_, i) => ({
      sessionId: i % 2 === 0 ? 'session-a' : 'session-b',
      output: `[proxy] stderr line ${String(i)}\n`,
    }))
    for (const event of events) {
      logProxyStderr(event.sessionId, event.output)
    }

    // No write happened on any logProxyStderr call stack.
    expect(fsMocks.appendFile).not.toHaveBeenCalled()
    expect(existsSync(path)).toBeFalsy()

    await flushDebugLogger()

    // One filesystem operation for the whole burst, not one per chunk.
    expect(fsMocks.appendFile).toHaveBeenCalledTimes(1)
    expect(fsMocks.mkdir).toHaveBeenCalledTimes(1)

    const entries = parseLines(readFileSync(path, 'utf8'))
    expect(entries).toHaveLength(events.length)
    for (const [index, entry] of entries.entries()) {
      expect(entry).toMatchObject({
        type: 'proxy_stderr',
        sessionId: events[index]?.sessionId,
        requestId: '',
        output: events[index]?.output,
      })
    }
  })

  it('flushes queued entries on the flush delay without an explicit flush', async () => {
    vi.useFakeTimers()
    fsMocks.appendFile.mockResolvedValue(undefined)
    fsMocks.mkdir.mockResolvedValue(undefined)
    const path = newLogPath()
    enable(path)

    logProxyStderr('session-1', 'one\n')
    logProxyStderr('session-1', 'two\n')
    logProxyStderr('session-1', 'three\n')
    expect(fsMocks.appendFile).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS)

    expect(fsMocks.appendFile).toHaveBeenCalledTimes(1)
    expect(parseLines(fsMocks.appendFile.mock.calls[0]?.[1] ?? '')).toHaveLength(3)
  })

  it('resolves an idle flush without touching the filesystem', async () => {
    const path = newLogPath()
    enable(path)

    await expect(flushDebugLogger()).resolves.toBeUndefined()
    expect(fsMocks.appendFile).not.toHaveBeenCalled()
  })

  it('survives filesystem failures without rejecting and reports the lost batch', async () => {
    const path = newLogPath()
    enable(path)
    fsMocks.appendFile.mockRejectedValue(new Error('EACCES: permission denied'))

    for (let i = 0; i < 10; i++) {
      logProxyStderr('session-1', `lost ${String(i)}\n`)
    }
    await expect(flushDebugLogger()).resolves.toBeUndefined()

    // The failed batch is counted; the next written batch reports the loss.
    fsMocks.appendFile.mockResolvedValue(undefined)
    for (let i = 0; i < 5; i++) {
      logProxyStderr('session-1', `kept ${String(i)}\n`)
    }
    await expect(flushDebugLogger()).resolves.toBeUndefined()

    const payloads = writtenPayloads()
    expect(payloads).toHaveLength(2)
    const entries = parseLines(payloads[1] ?? '')
    expect(entries[0]).toMatchObject({ type: 'log_drop', dropped: 10 })
    expect(entries.slice(1)).toHaveLength(5)
  })

  it('rotates the log file once the periodic size check sees the size limit', async () => {
    const path = newLogPath()
    enable(path)
    fsMocks.stat.mockResolvedValue({ size: 60 * 1024 * 1024 })
    fsMocks.rename.mockResolvedValue(undefined)
    fsMocks.appendFile.mockResolvedValue(undefined)

    for (let i = 0; i < STAT_INTERVAL + 50; i++) {
      logProxyStderr('session-1', `line ${String(i)}\n`)
    }
    await flushDebugLogger()

    expect(fsMocks.stat).toHaveBeenCalledTimes(1)
    expect(fsMocks.stat).toHaveBeenCalledWith(path)
    expect(fsMocks.rename).toHaveBeenCalledWith(path, `${path}.old`)
    // Rotation does not lose the batch it precedes.
    expect(parseLines(fsMocks.appendFile.mock.calls[0]?.[1] ?? '')).toHaveLength(STAT_INTERVAL + 50)
  })

  it('does not rotate while the file stays under the size limit', async () => {
    const path = newLogPath()
    enable(path)
    fsMocks.stat.mockResolvedValue({ size: 1024 })
    fsMocks.rename.mockResolvedValue(undefined)
    fsMocks.appendFile.mockResolvedValue(undefined)

    for (let i = 0; i < STAT_INTERVAL + 50; i++) {
      logProxyStderr('session-1', `line ${String(i)}\n`)
    }
    await flushDebugLogger()

    expect(fsMocks.rename).not.toHaveBeenCalled()
  })

  it('retains the stat interval remainder so 150 then 50 entries stat twice', async () => {
    const path = newLogPath()
    enable(path)
    const real = realFs()
    let statCalls = 0
    fsMocks.stat.mockImplementation(() => {
      statCalls++
      // The first interval reports a small file; the second reports an
      // oversized file, so the second batch must rotate before it appends.
      return statCalls === 1 ? Promise.resolve({ size: 1024 }) : Promise.resolve({ size: 60 * 1024 * 1024 })
    })
    fsMocks.rename.mockImplementation((from, to) => real.rename(from, to))

    for (let i = 0; i < STAT_INTERVAL + 50; i++) {
      logProxyStderr('session-1', `line ${String(i)}\n`)
    }
    await flushDebugLogger()

    // The 150-entry group crosses one full interval: exactly one stat for
    // the group, and the 50-entry surplus must stay counted toward the
    // next interval instead of vanishing in a reset to zero.
    expect(fsMocks.stat).toHaveBeenCalledTimes(1)
    expect(fsMocks.rename).not.toHaveBeenCalled()
    expect(parseLines(readFileSync(path, 'utf8'))).toHaveLength(STAT_INTERVAL + 50)

    for (let i = 0; i < 50; i++) {
      logProxyStderr('session-1', `more ${String(i)}\n`)
    }
    await flushDebugLogger()

    // The retained surplus plus 50 more entries reaches the interval
    // again, so the second stat fires.
    expect(fsMocks.stat).toHaveBeenCalledTimes(2)
    expect(fsMocks.stat).toHaveBeenNthCalledWith(2, path)
    // The second stat reports an oversized file: rotation renames the
    // first batch away before the second append, so the rotated file
    // holds the first batch and the fresh file holds only the second.
    expect(fsMocks.rename).toHaveBeenCalledTimes(1)
    expect(fsMocks.rename).toHaveBeenCalledWith(path, `${path}.old`)
    expect(parseLines(readFileSync(`${path}.old`, 'utf8'))).toHaveLength(STAT_INTERVAL + 50)
    const entries = parseLines(readFileSync(path, 'utf8'))
    expect(entries).toHaveLength(50)
    expect(entries.every((entry) => String(entry.output).startsWith('more '))).toBeTruthy()
  })

  it('stats once for a group that crosses several intervals, keeping the modulo remainder', async () => {
    const path = newLogPath()
    enable(path)
    fsMocks.stat.mockResolvedValue({ size: 1024 })
    fsMocks.rename.mockResolvedValue(undefined)

    for (let i = 0; i < STAT_INTERVAL * 2 + 50; i++) {
      logProxyStderr('session-1', `line ${String(i)}\n`)
    }
    await flushDebugLogger()

    // One stat for the whole 250-entry append group, not one per crossed
    // interval; the counter keeps 250 % 100 = 50.
    expect(fsMocks.stat).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 50; i++) {
      logProxyStderr('session-1', `more ${String(i)}\n`)
    }
    await flushDebugLogger()

    expect(fsMocks.stat).toHaveBeenCalledTimes(2)

    // Only the true surplus counts: another 50 entries stay short of the
    // next interval.
    for (let i = 0; i < 50; i++) {
      logProxyStderr('session-1', `tail ${String(i)}\n`)
    }
    await flushDebugLogger()

    expect(fsMocks.stat).toHaveBeenCalledTimes(2)
    expect(fsMocks.rename).not.toHaveBeenCalled()
  })

  it('discards queued entries when reinitialization changes the log path', async () => {
    const pathA = newLogPath()
    const pathB = newLogPath()
    enable(pathA)
    for (let i = 0; i < 3; i++) {
      logProxyStderr('session-1', `old ${String(i)}\n`)
    }

    enable(pathB)
    for (let i = 0; i < 2; i++) {
      logProxyStderr('session-2', `new ${String(i)}\n`)
    }
    await flushDebugLogger()

    // Nothing from the old configuration reaches the new path, and the old
    // path never receives a write.
    expect(fsMocks.appendFile).toHaveBeenCalledTimes(1)
    expect(fsMocks.appendFile.mock.calls[0]?.[0]).toBe(pathB)
    expect(existsSync(pathA)).toBeFalsy()

    const entries = parseLines(readFileSync(pathB, 'utf8'))
    expect(entries).toHaveLength(2)
    expect(entries.every((entry) => entry.sessionId === 'session-2')).toBeTruthy()
  })
})

describe('append chunking for multi-process JSONL safety', () => {
  it('splits large batches only between complete records within the append bound', async () => {
    const path = newLogPath()
    enable(path)
    fsMocks.mkdir.mockResolvedValue(undefined)
    fsMocks.appendFile.mockResolvedValue(undefined)

    const total = 40
    for (let i = 0; i < total; i++) {
      logProxyStderr('session-1', stderrChunk(i))
    }
    await flushDebugLogger()

    const payloads = writtenPayloads()
    expect(payloads.length).toBeGreaterThan(1)
    for (const payload of payloads) {
      // Every append stays within one write syscall, so processes sharing
      // the file cannot interleave inside a record.
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(MAX_APPEND_BYTES)
      // Every payload ends on a record boundary and parses standalone.
      expect(payload.endsWith('\n')).toBeTruthy()
      for (const line of parseLines(payload)) {
        expect(line.type).toBe('proxy_stderr')
      }
    }

    // Concatenated in call order, the appends form one ordered JSONL stream.
    const outputs = stderrOutputs(payloads.flatMap((payload) => parseLines(payload)))
    expect(outputs).toHaveLength(total)
    for (const [index, output] of outputs.entries()) {
      expect(output).toBe(stderrChunk(index))
    }
  })

  it('rejects a single entry larger than the append bound and reports it as a drop', async () => {
    const path = newLogPath()
    enable(path)
    fsMocks.mkdir.mockResolvedValue(undefined)
    fsMocks.appendFile.mockResolvedValue(undefined)

    logProxyStderr('session-1', `oversized\n${'x'.repeat(MAX_APPEND_BYTES)}`)
    logProxyStderr('session-1', 'kept\n')
    await flushDebugLogger()

    const entries = parseLines(writtenPayloads()[0] ?? '')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ type: 'log_drop', dropped: 1 })
    expect(entries[1]).toMatchObject({ type: 'proxy_stderr', output: 'kept\n' })
  })

  it('schedules the flush timer for an isolated oversized drop', async () => {
    vi.useFakeTimers()
    fsMocks.mkdir.mockResolvedValue(undefined)
    fsMocks.appendFile.mockResolvedValue(undefined)
    const path = newLogPath()
    enable(path)

    // Only an oversized entry: no valid follow-up and no explicit flush,
    // so the marker reaches the file only through the flush timer.
    logProxyStderr('session-1', `oversized\n${'x'.repeat(MAX_APPEND_BYTES)}`)
    expect(fsMocks.appendFile).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS)

    expect(fsMocks.appendFile).toHaveBeenCalledTimes(1)
    const entries = parseLines(writtenPayloads()[0] ?? '')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'log_drop', dropped: 1 })
  })
})

describe('aggregate queue cap across pending and in-flight entries', () => {
  it('drops exactly one record when pending alone fits the cap but pending plus in-flight crosses it', async () => {
    const path = newLogPath()
    enable(path)
    fsMocks.mkdir.mockResolvedValue(undefined)
    fsMocks.appendFile.mockResolvedValue(undefined)
    // Hold the first append in flight, so exactly one accepted record
    // stays counted as in-flight for the whole admission sequence.
    const gate = deferred<void>()
    fsMocks.appendFile.mockImplementationOnce(() => gate.promise)

    // 64 KiB lines: exactly 64 of them fill the 4 MiB cap, and four fit
    // one 256 KiB append payload, so every size check is exact.
    const LINE_BYTES = 64 * 1024
    const CAP_RECORDS = MAX_PENDING_BYTES / LINE_BYTES
    const idOf = (output: string): number => Number.parseInt(output.slice(0, 3), 10)
    const outputFor = (index: number): string => fixedLineOutput(LINE_BYTES, String(index).padStart(3, '0'))

    logProxyStderr('session-1', outputFor(0))
    const flushing = flushDebugLogger()
    await vi.waitFor(() => expect(fsMocks.appendFile).toHaveBeenCalledTimes(1))

    // Records 1..CAP_RECORDS-1 stay admissible on pending bytes alone. The
    // record numbered CAP_RECORDS would also fit on pending bytes alone
    // (CAP_RECORDS * 64 KiB equals the cap, and the check is strict), but
    // the in-flight record pushes the aggregate one record past the cap,
    // so only that record drops. Without in-flight bytes in the admission
    // check, no record would drop.
    for (let i = 1; i <= CAP_RECORDS; i++) {
      logProxyStderr('session-1', outputFor(i))
    }
    gate.resolve()
    await flushing

    const payloads = writtenPayloads()
    expect(payloads.length).toBeGreaterThan(1)
    for (const payload of payloads) {
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(MAX_APPEND_BYTES)
      expect(payload.endsWith('\n')).toBeTruthy()
    }

    const entries = payloads.flatMap((payload) => parseLines(payload))
    const markers = entries.filter((entry) => entry.type === 'log_drop')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ dropped: 1 })
    // The overflow marker follows the accepted records at the queue tail.
    expect(entries.at(-1)).toMatchObject({ type: 'log_drop', dropped: 1 })

    // Every accepted record persists, in order; only the last record is
    // missing.
    const outputs = stderrOutputs(entries)
    expect(outputs.map(idOf)).toEqual(Array.from({ length: CAP_RECORDS }, (_, i) => i))
  })
})

describe('ordered drop accounting', () => {
  it('keeps one cumulative exact count across repeated failed batches', async () => {
    const path = newLogPath()
    enable(path)
    fsMocks.mkdir.mockResolvedValue(undefined)
    fsMocks.appendFile.mockResolvedValue(undefined)
    const fail1 = deferred<void>()
    const fail2 = deferred<void>()
    fsMocks.appendFile.mockImplementationOnce(() =>
      fail1.promise.then(
        () => Promise.reject(new Error('EBUSY')),
        () => Promise.reject(new Error('EBUSY')),
      ),
    )
    fsMocks.appendFile.mockImplementationOnce(() =>
      fail2.promise.then(
        () => Promise.reject(new Error('EBUSY')),
        () => Promise.reject(new Error('EBUSY')),
      ),
    )

    for (let i = 0; i < 5; i++) {
      logProxyStderr('session-1', `first ${String(i)}\n`)
    }
    const flushing = flushDebugLogger()
    for (let i = 0; i < 3; i++) {
      logProxyStderr('session-1', `second ${String(i)}\n`)
    }
    fail1.resolve()
    await vi.waitFor(() => expect(fsMocks.appendFile).toHaveBeenCalledTimes(2))
    for (let i = 0; i < 2; i++) {
      logProxyStderr('session-1', `final ${String(i)}\n`)
    }
    fail2.resolve()
    await flushing

    // Batch 1 (5 entries) fails, then batch 2 (marker for 5 plus 3 entries
    // queued during the write) fails. The surviving batch reports one
    // cumulative count, 5 + 3, ahead of the entries queued after the last
    // failure: no duplication, no loss.
    const payloads = writtenPayloads()
    expect(payloads).toHaveLength(3)
    expect(parseLines(payloads[0] ?? '')).toHaveLength(5)
    const secondBatch = parseLines(payloads[1] ?? '')
    expect(secondBatch[0]).toMatchObject({ type: 'log_drop', dropped: 5 })
    expect(secondBatch.slice(1)).toHaveLength(3)
    const finalBatch = parseLines(payloads[2] ?? '')
    expect(finalBatch[0]).toMatchObject({ type: 'log_drop', dropped: 8 })
    expect(finalBatch.slice(1)).toHaveLength(2)
  })

  it('places the failure marker ahead of entries queued after the failure', async () => {
    const path = newLogPath()
    enable(path)
    fsMocks.mkdir.mockResolvedValue(undefined)
    fsMocks.appendFile.mockResolvedValue(undefined)
    const fail = deferred<void>()
    fsMocks.appendFile.mockImplementationOnce(() =>
      fail.promise.then(
        () => Promise.reject(new Error('EBUSY')),
        () => Promise.reject(new Error('EBUSY')),
      ),
    )

    logProxyStderr('session-1', 'lost-a\n')
    logProxyStderr('session-1', 'lost-b\n')
    const flushing = flushDebugLogger()
    logProxyStderr('session-1', 'queued-after-failure\n')
    fail.resolve()
    await flushing

    const payloads = writtenPayloads()
    expect(payloads).toHaveLength(2)
    const entries = parseLines(payloads[1] ?? '')
    expect(entries[0]).toMatchObject({ type: 'log_drop', dropped: 2 })
    expect(entries[1]).toMatchObject({ type: 'proxy_stderr', output: 'queued-after-failure\n' })
  })

  it('restores only the failed payload and its suffix when a split batch partially persists', async () => {
    const path = newLogPath()
    enable(path)
    fsMocks.mkdir.mockResolvedValue(undefined)
    fsMocks.appendFile.mockResolvedValue(undefined)
    const gate = deferred<void>()
    fsMocks.appendFile.mockImplementationOnce(() => gate.promise)
    fsMocks.appendFile.mockImplementationOnce(() => Promise.reject(new Error('ENOSPC')))

    // The oversized entry becomes a leading marker; three 100 KiB entries
    // split into payloads [marker, 000, 001] and [002].
    logProxyStderr('session-1', `oversized\n${'y'.repeat(MAX_APPEND_BYTES)}`)
    for (const id of ['000', '001', '002']) {
      logProxyStderr('session-1', fixedLineOutput(100 * 1024, id))
    }
    const flushing = flushDebugLogger()
    await vi.waitFor(() => expect(fsMocks.appendFile).toHaveBeenCalledTimes(1))
    // Entries queued after the batch was taken must follow the
    // replacement marker once the suffix failure is accounted.
    logProxyStderr('session-1', fixedLineOutput(100 * 1024, '003'))
    logProxyStderr('session-1', fixedLineOutput(100 * 1024, '004'))
    gate.resolve()
    await flushing

    const payloads = writtenPayloads()
    expect(payloads).toHaveLength(3)

    // Payload 1 persisted: the oversized-loss marker plus entries 000, 001.
    const persisted = parseLines(payloads[0] ?? '')
    expect(persisted).toHaveLength(3)
    expect(persisted[0]).toMatchObject({ type: 'log_drop', dropped: 1 })

    // Payload 2 failed and carried only entry 002: wholly unpersisted.
    const failed = parseLines(payloads[1] ?? '')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ type: 'proxy_stderr' })

    // The retry batch reports exactly the failed payload's entry once,
    // ahead of the entries queued after the failure; the marker already
    // persisted in payload 1 is never repeated.
    const retry = parseLines(payloads[2] ?? '')
    expect(retry[0]).toMatchObject({ type: 'log_drop', dropped: 1 })
    expect(retry.slice(1)).toHaveLength(2)

    // Exact invariant: each source event is persisted exactly once or
    // counted in exactly one marker. Oversized and 002 are counted (2);
    // 000, 001, 003, 004 persist (4). The rejected payload 2 never
    // reached the file, so only payloads 1 and 3 count as persisted.
    const all = payloads.flatMap((payload) => parseLines(payload))
    const dropped = all
      .filter((entry) => entry.type === 'log_drop')
      .reduce((sum, entry) => sum + Number(entry.dropped), 0)
    expect(dropped).toBe(2)
    const persistedOutputs = stderrOutputs([...parseLines(payloads[0] ?? ''), ...parseLines(payloads[2] ?? '')])
    expect(persistedOutputs.map((output) => output.slice(0, 3))).toEqual(['000', '001', '003', '004'])
  })
})

describe('generation isolation on reinitialize', () => {
  it('lets the new generation create its own directory while the old mkdir is in flight', async () => {
    const pathA = newLogPath()
    const pathB = newLogPath()
    const gate = deferred<void>()
    const real = realFs()
    fsMocks.mkdir.mockImplementationOnce(async (dir, options) => {
      await gate.promise
      return real.mkdir(dir, options)
    })

    enable(pathA)
    for (let i = 0; i < 3; i++) {
      logProxyStderr('session-a', `a ${String(i)}\n`)
    }
    const flushA = flushDebugLogger()

    enable(pathB)
    for (let i = 0; i < 2; i++) {
      logProxyStderr('session-b', `b ${String(i)}\n`)
    }
    const flushB = flushDebugLogger()

    gate.resolve()
    await flushA
    await flushB

    // Both generations ran their own mkdir; B did not inherit A's
    // directory state, so its entries reach B without loss or marker.
    expect(fsMocks.mkdir).toHaveBeenCalledWith(dirname(pathA), { recursive: true })
    expect(fsMocks.mkdir).toHaveBeenCalledWith(dirname(pathB), { recursive: true })
    expect(parseLines(readFileSync(pathA, 'utf8'))).toHaveLength(3)
    const entriesB = parseLines(readFileSync(pathB, 'utf8'))
    expect(entriesB).toHaveLength(2)
    expect(entriesB.every((entry) => entry.type === 'proxy_stderr')).toBeTruthy()
  })

  it('keeps size and rotation state per generation when reinit happens during a stat', async () => {
    const pathA = newLogPath()
    const pathB = newLogPath()
    const gate = deferred<{ size: number }>()
    fsMocks.stat.mockImplementationOnce(() => gate.promise)
    fsMocks.rename.mockResolvedValue(undefined)

    enable(pathA)
    for (let i = 0; i < STAT_INTERVAL + 50; i++) {
      logProxyStderr('session-a', `a ${String(i)}\n`)
    }
    const flushA = flushDebugLogger()

    enable(pathB)
    for (let i = 0; i < 2; i++) {
      logProxyStderr('session-b', `b ${String(i)}\n`)
    }
    const flushB = flushDebugLogger()

    gate.resolve({ size: 60 * 1024 * 1024 })
    await flushA
    await flushB

    // A's oversized stat rotates only A. B starts from its own size state
    // and never rotates, so no entry is lost and no marker appears.
    expect(fsMocks.stat).toHaveBeenCalledTimes(1)
    expect(fsMocks.stat).toHaveBeenCalledWith(pathA)
    expect(fsMocks.rename).toHaveBeenCalledTimes(1)
    expect(fsMocks.rename).toHaveBeenCalledWith(pathA, `${pathA}.old`)
    expect(parseLines(readFileSync(pathA, 'utf8'))).toHaveLength(STAT_INTERVAL + 50)
    const entriesB = parseLines(readFileSync(pathB, 'utf8'))
    expect(entriesB).toHaveLength(2)
    expect(entriesB.every((entry) => entry.type === 'proxy_stderr')).toBeTruthy()
  })

  it('keeps rotation per generation when reinit happens during a rename', async () => {
    const pathA = newLogPath()
    const pathB = newLogPath()
    const gate = deferred<void>()
    fsMocks.stat.mockResolvedValue({ size: 60 * 1024 * 1024 })
    fsMocks.rename.mockImplementationOnce(() => gate.promise)

    enable(pathA)
    for (let i = 0; i < STAT_INTERVAL + 50; i++) {
      logProxyStderr('session-a', `a ${String(i)}\n`)
    }
    const flushA = flushDebugLogger()

    enable(pathB)
    for (let i = 0; i < 2; i++) {
      logProxyStderr('session-b', `b ${String(i)}\n`)
    }
    const flushB = flushDebugLogger()

    gate.resolve()
    await flushA
    await flushB

    expect(fsMocks.rename).toHaveBeenCalledTimes(1)
    expect(fsMocks.rename).toHaveBeenCalledWith(pathA, `${pathA}.old`)
    expect(fsMocks.rename).not.toHaveBeenCalledWith(pathB, `${pathB}.old`)
    expect(parseLines(readFileSync(pathA, 'utf8'))).toHaveLength(STAT_INTERVAL + 50)
    const entriesB = parseLines(readFileSync(pathB, 'utf8'))
    expect(entriesB).toHaveLength(2)
    expect(entriesB.every((entry) => entry.type === 'proxy_stderr')).toBeTruthy()
  })

  it('finishes an in-flight append on the old generation after reinit to a new path', async () => {
    const pathA = newLogPath()
    const pathB = newLogPath()
    const gate = deferred<void>()
    const real = realFs()
    fsMocks.appendFile.mockImplementationOnce(async (path, data, options) => {
      await gate.promise
      return real.appendFile(path, data, options)
    })

    enable(pathA)
    for (let i = 0; i < 3; i++) {
      logProxyStderr('session-a', `a ${String(i)}\n`)
    }
    const flushA = flushDebugLogger()

    enable(pathB)
    for (let i = 0; i < 2; i++) {
      logProxyStderr('session-b', `b ${String(i)}\n`)
    }
    const flushB = flushDebugLogger()

    gate.resolve()
    await flushA
    await flushB

    // The in-flight batch lands on its own path; B writes after it, in
    // queue order, with its own clean state.
    expect(fsMocks.appendFile).toHaveBeenCalledTimes(2)
    expect(fsMocks.appendFile.mock.calls[0]?.[0]).toBe(pathA)
    expect(fsMocks.appendFile.mock.calls[1]?.[0]).toBe(pathB)
    expect(parseLines(readFileSync(pathA, 'utf8'))).toHaveLength(3)
    const entriesB = parseLines(readFileSync(pathB, 'utf8'))
    expect(entriesB).toHaveLength(2)
    expect(entriesB.every((entry) => entry.type === 'proxy_stderr')).toBeTruthy()
  })

  it('serializes two generations that share one path so records keep queue order', async () => {
    const path = newLogPath()
    const gate = deferred<void>()
    const real = realFs()
    fsMocks.appendFile.mockImplementationOnce(async (target, data, options) => {
      await gate.promise
      return real.appendFile(target, data, options)
    })

    enable(path)
    for (let i = 0; i < 3; i++) {
      logProxyStderr('session-a', `a ${String(i)}\n`)
    }
    const flushA = flushDebugLogger()

    // Reinit to the same path opens a fresh generation with its own state.
    enable(path)
    for (let i = 0; i < 2; i++) {
      logProxyStderr('session-b', `b ${String(i)}\n`)
    }
    const flushB = flushDebugLogger()

    gate.resolve()
    await flushA
    await flushB

    const entries = parseLines(readFileSync(path, 'utf8'))
    expect(entries.map((entry) => entry.output)).toEqual(['a 0\n', 'a 1\n', 'a 2\n', 'b 0\n', 'b 1\n'])
    expect(fsMocks.mkdir).toHaveBeenCalledTimes(2)
  })

  it('completes the old generation write after reinit through disabled', async () => {
    const pathA = newLogPath()
    const pathB = newLogPath()
    const gate = deferred<void>()
    const real = realFs()
    fsMocks.appendFile.mockImplementationOnce(async (path, data, options) => {
      await gate.promise
      return real.appendFile(path, data, options)
    })

    enable(pathA)
    for (let i = 0; i < 3; i++) {
      logProxyStderr('session-a', `a ${String(i)}\n`)
    }
    const flushA = flushDebugLogger()

    vi.stubEnv('PI_CURSOR_PROVIDER_DEBUG', undefined)
    initDebugLogger()
    expect(isDebugLoggingEnabled()).toBeFalsy()

    enable(pathB)
    for (let i = 0; i < 2; i++) {
      logProxyStderr('session-b', `b ${String(i)}\n`)
    }
    const flushB = flushDebugLogger()

    gate.resolve()
    await flushA
    await flushB

    expect(parseLines(readFileSync(pathA, 'utf8'))).toHaveLength(3)
    const entriesB = parseLines(readFileSync(pathB, 'utf8'))
    expect(entriesB).toHaveLength(2)
    expect(entriesB.every((entry) => entry.type === 'proxy_stderr')).toBeTruthy()
  })

  it('reports a failed in-flight batch only in its own generation', async () => {
    const pathA = newLogPath()
    const pathB = newLogPath()
    fsMocks.appendFile.mockRejectedValueOnce(new Error('EIO'))

    enable(pathA)
    for (let i = 0; i < 3; i++) {
      logProxyStderr('session-a', `a ${String(i)}\n`)
    }
    const flushA = flushDebugLogger()

    enable(pathB)
    for (let i = 0; i < 2; i++) {
      logProxyStderr('session-b', `b ${String(i)}\n`)
    }
    const flushB = flushDebugLogger()

    await flushA
    await flushB

    // A's failed entries are never reported into B: B's batch carries no
    // drop marker for them, and A never succeeded.
    expect(fsMocks.appendFile).toHaveBeenCalledTimes(2)
    expect(fsMocks.appendFile.mock.calls[0]?.[0]).toBe(pathA)
    expect(fsMocks.appendFile.mock.calls[1]?.[0]).toBe(pathB)
    expect(existsSync(pathA)).toBeFalsy()
    const entriesB = parseLines(readFileSync(pathB, 'utf8'))
    expect(entriesB).toHaveLength(2)
    expect(entriesB.every((entry) => entry.type === 'proxy_stderr')).toBeTruthy()
  })
})

describe('flush fence across generations', () => {
  it('waits for an old in-flight append when reinit disables the logger', async () => {
    const path = newLogPath()
    const gate = deferred<void>()
    const real = realFs()
    fsMocks.appendFile.mockImplementationOnce(async (target, data, options) => {
      await gate.promise
      return real.appendFile(target, data, options)
    })

    enable(path)
    for (let i = 0; i < 3; i++) {
      logProxyStderr('session-1', `a ${String(i)}\n`)
    }
    const early = flushDebugLogger()

    // Disabled mid-write: the old generation's append is still in flight.
    vi.stubEnv('PI_CURSOR_PROVIDER_DEBUG', undefined)
    initDebugLogger()
    expect(isDebugLoggingEnabled()).toBeFalsy()

    const late = flushDebugLogger()
    let settled = false
    void late.then(() => {
      settled = true
    })
    // A macrotask lets any premature microtask-only resolution settle;
    // the fence must still hold while the old append is in flight.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(settled).toBeFalsy()

    gate.resolve()
    await early
    await late
    expect(settled).toBeTruthy()
    expect(parseLines(readFileSync(path, 'utf8'))).toHaveLength(3)
  })

  it('waits for an old in-flight append while the new generation sits idle', async () => {
    const pathA = newLogPath()
    const pathB = newLogPath()
    const gate = deferred<void>()
    const real = realFs()
    fsMocks.appendFile.mockImplementationOnce(async (target, data, options) => {
      await gate.promise
      return real.appendFile(target, data, options)
    })

    enable(pathA)
    for (let i = 0; i < 3; i++) {
      logProxyStderr('session-a', `a ${String(i)}\n`)
    }
    const early = flushDebugLogger()

    // B installs idle: its own empty queue must not bypass A's append.
    enable(pathB)
    const late = flushDebugLogger()
    let settled = false
    void late.then(() => {
      settled = true
    })
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(settled).toBeFalsy()

    gate.resolve()
    await early
    await late
    expect(settled).toBeTruthy()
    expect(fsMocks.appendFile).toHaveBeenCalledTimes(1)
    expect(fsMocks.appendFile.mock.calls[0]?.[0]).toBe(pathA)
    expect(parseLines(readFileSync(pathA, 'utf8'))).toHaveLength(3)
    expect(existsSync(pathB)).toBeFalsy()
  })

  it('removes its own waiters and timer when a bounded flush times out on a stuck old job', async () => {
    vi.useFakeTimers()
    fsMocks.mkdir.mockResolvedValue(undefined)
    const path = newLogPath()
    enable(path)
    const gate = deferred<void>()
    fsMocks.appendFile.mockImplementation(() => gate.promise)

    logProxyStderr('session-1', 'stuck write\n')
    void flushDebugLogger()

    // Disabled while the old job is stuck, so only the job fence remains.
    vi.stubEnv('PI_CURSOR_PROVIDER_DEBUG', undefined)
    initDebugLogger()

    try {
      for (let i = 0; i < 3; i++) {
        const flushed = flushDebugLogger(50)
        // Only this flush's deadline timer is live; earlier timed-out
        // flushes removed their deadline and job-fence subscription.
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(50)
        await expect(flushed).resolves.toBeUndefined()
        expect(vi.getTimerCount()).toBe(0)
      }
    } finally {
      gate.resolve()
    }

    // The stuck job continues after every caller timeout and settles
    // exactly once: one payload, one entry.
    await flushDebugLogger()
    expect(writtenPayloads()).toHaveLength(1)
    expect(parseLines(writtenPayloads()[0] ?? '')).toHaveLength(1)
  })
})

describe('bounded flush waiter and timer cleanup', () => {
  it('resolves a bounded flush even when a write never settles', async () => {
    vi.useFakeTimers()
    fsMocks.mkdir.mockResolvedValue(undefined)
    const path = newLogPath()
    enable(path)
    const gate = deferred<void>()
    fsMocks.appendFile.mockImplementation(() => gate.promise)

    try {
      logProxyStderr('session-1', 'stuck write\n')
      const flushed = flushDebugLogger(50)
      await vi.advanceTimersByTimeAsync(50)

      // The deadline resolves the shutdown flush; the stuck write must not
      // hang the caller.
      await expect(flushed).resolves.toBeUndefined()
    } finally {
      gate.resolve()
    }

    // The background drain finishes once the write settles, so later state
    // is not corrupted.
    await flushDebugLogger()
    expect(parseLines(writtenPayloads()[0] ?? '')).toHaveLength(1)
  })

  it('retains no timer or waiter growth across repeated timed flushes against a stuck write', async () => {
    vi.useFakeTimers()
    fsMocks.mkdir.mockResolvedValue(undefined)
    const path = newLogPath()
    enable(path)
    const gate = deferred<void>()
    fsMocks.appendFile.mockImplementation(() => gate.promise)

    logProxyStderr('session-1', 'stuck write\n')
    try {
      for (let i = 0; i < 3; i++) {
        const flushed = flushDebugLogger(50)
        // Only this flush's deadline timer is live; earlier timed-out
        // flushes removed their deadline and idle subscription.
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(50)
        await expect(flushed).resolves.toBeUndefined()
        expect(vi.getTimerCount()).toBe(0)
      }
    } finally {
      gate.resolve()
    }

    // The shared writer continues after every caller timeout and settles
    // exactly once: one payload, one entry.
    await flushDebugLogger()
    expect(writtenPayloads()).toHaveLength(1)
    expect(parseLines(writtenPayloads()[0] ?? '')).toHaveLength(1)
  })

  it('clears the deadline timer as soon as the drain completes', async () => {
    vi.useFakeTimers()
    fsMocks.mkdir.mockResolvedValue(undefined)
    fsMocks.appendFile.mockResolvedValue(undefined)
    const path = newLogPath()
    enable(path)

    logProxyStderr('session-1', 'one\n')
    logProxyStderr('session-1', 'two\n')
    const flushed = flushDebugLogger(1000)
    await flushed

    // A fast drain must not leave the deadline timer alive until expiry.
    expect(vi.getTimerCount()).toBe(0)
    expect(parseLines(writtenPayloads()[0] ?? '')).toHaveLength(2)
  })

  it('resolves simultaneous waiters when a stuck write settles', async () => {
    vi.useFakeTimers()
    fsMocks.mkdir.mockResolvedValue(undefined)
    fsMocks.appendFile.mockResolvedValue(undefined)
    const gate = deferred<void>()
    fsMocks.appendFile.mockImplementationOnce(() => gate.promise)
    const path = newLogPath()
    enable(path)

    logProxyStderr('session-1', 'one\n')
    logProxyStderr('session-1', 'two\n')
    const bounded1 = flushDebugLogger(50)
    const bounded2 = flushDebugLogger(50)
    const unbounded = flushDebugLogger()

    await vi.advanceTimersByTimeAsync(50)
    await expect(bounded1).resolves.toBeUndefined()
    await expect(bounded2).resolves.toBeUndefined()

    let settled = false
    void unbounded.then(() => {
      settled = true
    })
    expect(settled).toBeFalsy()

    gate.resolve()
    await unbounded
    expect(settled).toBeTruthy()
    expect(writtenPayloads()).toHaveLength(1)
    expect(parseLines(writtenPayloads()[0] ?? '')).toHaveLength(2)
  })

  it('leaves no timer behind for a bounded flush when disabled or idle', async () => {
    vi.useFakeTimers()
    vi.stubEnv('PI_CURSOR_PROVIDER_DEBUG', undefined)
    initDebugLogger()

    await expect(flushDebugLogger(1000)).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    expect(fsMocks.appendFile).not.toHaveBeenCalled()

    const path = newLogPath()
    enable(path)
    await expect(flushDebugLogger(1000)).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
