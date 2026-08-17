import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import { withSharedLock } from '../shared-lock.ts'

const [lockPath, enteredPath, releasePath, resultPath, maxWaitMs] = process.argv.slice(2)

try {
  const result = await withSharedLock(lockPath, Number(maxWaitMs), async () => {
    writeFileSync(enteredPath, String(process.pid), { flag: 'wx' })
    while (releasePath !== '-' && !existsSync(releasePath)) {
      await delay(5)
    }
  })
  writeFileSync(resultPath, JSON.stringify(result))
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}
