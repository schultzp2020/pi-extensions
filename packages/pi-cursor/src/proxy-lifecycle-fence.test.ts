import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

const fence = vi.hoisted(() => ({
  lockPath: '',
  afterOperation: undefined as ((value: unknown) => void | Promise<void>) | undefined,
  beforeRelease: undefined as ((value: unknown) => void | Promise<void>) | undefined,
}))

vi.mock('./shared-lock.ts', () => ({
  SHARED_LOCK_STALE_MS: 2_000,
  async withSharedLock<T>(
    lockPath: string,
    _maxWaitMs: number,
    operation: () => T | Promise<T>,
    signal?: AbortSignal,
    afterFence?: (value: T) => void | Promise<void>,
  ): Promise<{ acquired: true; value: T }> {
    signal?.throwIfAborted()
    const value = await operation()
    try {
      if (lockPath === fence.lockPath) {
        const { afterOperation } = fence
        fence.afterOperation = undefined
        await afterOperation?.(value)
      }
      const finalization = afterFence?.(value)
      if (finalization) {
        await finalization
      }
    } finally {
      if (lockPath === fence.lockPath) {
        await fence.beforeRelease?.(value)
      }
    }
    return { acquired: true, value }
  },
}))

import { connectToProxy, getActivePort, stopHeartbeat } from './proxy-lifecycle.ts'

afterEach(() => {
  fence.lockPath = ''
  fence.afterOperation = undefined
  fence.beforeRelease = undefined
  stopHeartbeat()
})

async function waitForProcessExit(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10)
    })
  }
  throw new Error(`Timed out waiting for proxy ${String(pid)} to exit`)
}

describe('proxy connection fence', () => {
  it('rejects a spawned proxy that exits during the final lock fence', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-fence-exit-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    let preparedConnection: { port: number; pid: number } | undefined

    try {
      fence.lockPath = `${portFilePath}.lock`
      fence.afterOperation = async (value) => {
        preparedConnection = value as { port: number; pid: number }
        process.kill(preparedConnection.pid, 'SIGKILL')
        await waitForProcessExit(preparedConnection.pid)
      }

      await expect(
        connectToProxy('test-session', 'test-secret', {
          portFilePath,
          lifecycleFilePath,
          proxyEntry,
        }),
      ).rejects.toThrow('exited before connection completed')

      expect(preparedConnection).toBeDefined()
      expect(getActivePort()).toBeNull()
      expect(existsSync(portFilePath)).toBeFalsy()
    } finally {
      if (preparedConnection) {
        try {
          process.kill(preparedConnection.pid, 'SIGKILL')
        } catch {}
        await waitForProcessExit(preparedConnection.pid).catch(() => undefined)
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('unwinds a spawned proxy when cancellation wins the final lock fence', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-lifecycle-fence-cancel-'))
    const portFilePath = join(tempDir, 'cursor-proxy.json')
    const lifecycleFilePath = join(tempDir, 'cursor-proxy-lifecycle.json')
    const proxyEntry = fileURLToPath(new URL('./test-fixtures/ready-proxy.mjs', import.meta.url))
    const controller = new AbortController()
    let preparedConnection: { port: number; pid: number } | undefined
    let portFilePresentAtRelease: boolean | undefined

    try {
      fence.lockPath = `${portFilePath}.lock`
      fence.afterOperation = (value) => {
        preparedConnection = value as { port: number; pid: number }
        expect(existsSync(portFilePath)).toBeTruthy()
        expect(getActivePort()).toBe(preparedConnection.port)
        controller.abort(new Error('Recovery cancelled at the connection fence'))
      }
      fence.beforeRelease = () => {
        portFilePresentAtRelease = existsSync(portFilePath)
      }

      await expect(
        connectToProxy('test-session', 'test-secret', {
          portFilePath,
          lifecycleFilePath,
          proxyEntry,
          signal: controller.signal,
        }),
      ).rejects.toThrow('Recovery cancelled at the connection fence')

      expect(preparedConnection).toBeDefined()
      expect(portFilePresentAtRelease).toBeFalsy()
      expect(getActivePort()).toBeNull()
      expect(existsSync(portFilePath)).toBeFalsy()
      if (preparedConnection) {
        await waitForProcessExit(preparedConnection.pid)
      }
    } finally {
      if (preparedConnection) {
        try {
          process.kill(preparedConnection.pid, 'SIGKILL')
        } catch {}
        await waitForProcessExit(preparedConnection.pid).catch(() => undefined)
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
