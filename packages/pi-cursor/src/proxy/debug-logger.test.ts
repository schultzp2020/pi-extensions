import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { initDebugLogger, isDebugLoggingEnabled, logProxyStderr } from './debug-logger.ts'

const TEST_LOG_PATH = join(tmpdir(), `pi-cursor-debug-logger-${process.pid}.jsonl`)

afterEach(() => {
  vi.unstubAllEnvs()
  initDebugLogger()
  rmSync(TEST_LOG_PATH, { force: true })
})

describe('proxy stderr debug logging', () => {
  it('writes captured output as structured JSONL when debug logging is enabled', () => {
    vi.stubEnv('PI_CURSOR_PROVIDER_DEBUG', '1')
    vi.stubEnv('PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE', TEST_LOG_PATH)
    initDebugLogger()

    logProxyStderr('session-1', '[proxy] Listening on port 1234\n')

    const entry = JSON.parse(readFileSync(TEST_LOG_PATH, 'utf8')) as Record<string, unknown>
    expect(entry).toMatchObject({
      type: 'proxy_stderr',
      sessionId: 'session-1',
      requestId: '',
      output: '[proxy] Listening on port 1234\n',
    })
  })

  it('stays disabled unless explicitly enabled', () => {
    vi.stubEnv('PI_CURSOR_PROVIDER_DEBUG', undefined)
    initDebugLogger()

    expect(isDebugLoggingEnabled()).toBeFalsy()
  })
})
