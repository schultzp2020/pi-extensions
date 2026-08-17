import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

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
    const firstExit = once(first, 'exit')

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
})
