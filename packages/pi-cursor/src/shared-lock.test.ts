import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { withSharedLock } from './shared-lock.ts'

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!existsSync(path)) {
    if (performance.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`)
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5)
    })
  }
}

describe('withSharedLock', () => {
  it('keeps queued owners out until fenced finalization completes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-shared-lock-finalize-'))
    const lockPath = join(tempDir, 'shared.lock')
    let releaseFinalization: (() => void) | undefined
    let finalizationStarted: (() => void) | undefined
    const finalizationReady = new Promise<void>((resolve) => {
      finalizationStarted = resolve
    })
    const finalizationRelease = new Promise<void>((resolve) => {
      releaseFinalization = resolve
    })
    let queuedOwnerEntered = false

    try {
      const first = withSharedLock(
        lockPath,
        1_000,
        () => 'first',
        undefined,
        async () => {
          finalizationStarted?.()
          await finalizationRelease
        },
      )
      await finalizationReady
      const second = withSharedLock(lockPath, 1_000, () => {
        queuedOwnerEntered = true
        return 'second'
      })

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      })
      expect(queuedOwnerEntered).toBeFalsy()

      releaseFinalization?.()
      await expect(first).resolves.toEqual({ acquired: true, value: 'first' })
      await expect(second).resolves.toEqual({ acquired: true, value: 'second' })
      expect(queuedOwnerEntered).toBeTruthy()
    } finally {
      releaseFinalization?.()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('recognizes a live owner across process timezones', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-shared-lock-timezone-'))
    const lockPath = join(tempDir, 'shared.lock')
    const firstEnteredPath = join(tempDir, 'first-entered')
    const firstResultPath = join(tempDir, 'first-result.json')
    const secondEnteredPath = join(tempDir, 'second-entered')
    const secondResultPath = join(tempDir, 'second-result.json')
    const releasePath = join(tempDir, 'release')
    const workerPath = fileURLToPath(new URL('./test-fixtures/shared-lock-worker.mjs', import.meta.url))
    const baseEnv = { ...process.env, LANG: 'C', LANGUAGE: 'C', LC_ALL: 'C' }
    const first = spawn(
      process.execPath,
      [workerPath, lockPath, firstEnteredPath, releasePath, firstResultPath, '5000'],
      {
        env: { ...baseEnv, TZ: 'UTC' },
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    const firstExit = once(first, 'exit') as Promise<[number | null, NodeJS.Signals | null]>

    try {
      await waitForFile(firstEnteredPath)
      const second = spawnSync(
        process.execPath,
        [workerPath, lockPath, secondEnteredPath, '-', secondResultPath, '750'],
        {
          encoding: 'utf8',
          env: { ...baseEnv, TZ: 'Pacific/Honolulu' },
          timeout: 5_000,
          windowsHide: true,
        },
      )

      expect(second.error).toBeUndefined()
      expect(second.status).toBe(0)
      expect(JSON.parse(readFileSync(secondResultPath, 'utf8'))).toEqual({ acquired: false })
      expect(existsSync(secondEnteredPath)).toBeFalsy()

      writeFileSync(releasePath, '')
      await waitForFile(firstResultPath)
      const [firstExitCode] = await firstExit
      expect(firstExitCode).toBe(0)
      expect(JSON.parse(readFileSync(firstResultPath, 'utf8'))).toEqual({ acquired: true })
    } finally {
      if (!existsSync(releasePath)) {
        writeFileSync(releasePath, '')
      }
      if (first.exitCode === null && first.signalCode === null) {
        first.kill('SIGKILL')
        await firstExit
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('reclaims a stale incarnation despite a matching coarse process identity', async () => {
    if (
      process.platform !== 'linux' &&
      process.platform !== 'darwin' &&
      process.platform !== 'freebsd' &&
      process.platform !== 'openbsd'
    ) {
      return
    }
    const tempDir = mkdtempSync(join(tmpdir(), 'pi-cursor-shared-lock-incarnation-'))
    const identityLockPath = join(tempDir, 'identity.lock')
    const lockPath = join(tempDir, 'shared.lock')
    const enteredPath = join(tempDir, 'entered')
    const releasePath = join(tempDir, 'release')
    const resultPath = join(tempDir, 'result.json')
    const workerPath = fileURLToPath(new URL('./test-fixtures/shared-lock-worker.mjs', import.meta.url))
    let currentProcessIdentity: unknown
    let incarnationSocket: string | undefined
    const identityResult = await withSharedLock(identityLockPath, 1_000, () => {
      const ticketName = readdirSync(identityLockPath).find((name) => name.endsWith('.ticket'))
      if (!ticketName) {
        throw new Error('Current process did not publish a lock ticket')
      }
      const owner = JSON.parse(readFileSync(join(identityLockPath, ticketName), 'utf8')) as Record<string, unknown>
      currentProcessIdentity = owner.processIdentity
    })
    expect(identityResult.acquired).toBeTruthy()
    expect(typeof currentProcessIdentity).toBe('string')

    const worker = spawn(process.execPath, [workerPath, lockPath, enteredPath, releasePath, resultPath, '5000'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const workerExit = once(worker, 'exit')

    try {
      await waitForFile(enteredPath)
      const ticketName = readdirSync(lockPath).find((name) => name.endsWith('.ticket'))
      if (!ticketName) {
        throw new Error('Worker did not publish a lock ticket')
      }
      const ticketPath = join(lockPath, ticketName)
      const owner = JSON.parse(readFileSync(ticketPath, 'utf8')) as Record<string, unknown>
      incarnationSocket = typeof owner.incarnationSocket === 'string' ? owner.incarnationSocket : undefined
      expect(incarnationSocket).toBeDefined()

      worker.kill('SIGKILL')
      await workerExit
      writeFileSync(
        ticketPath,
        JSON.stringify({ ...owner, ownerPid: process.pid, processIdentity: currentProcessIdentity }),
      )

      await expect(withSharedLock(lockPath, 1_000, () => 'entered')).resolves.toEqual({
        acquired: true,
        value: 'entered',
      })
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGKILL')
        await workerExit
      }
      if (incarnationSocket) {
        try {
          unlinkSync(incarnationSocket)
        } catch {}
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
