import { randomUUID } from 'node:crypto'
import { linkSync, readFileSync, renameSync, unlinkSync } from 'node:fs'

export interface ProxyPortIdentity {
  port: number
  pid: number
  generation?: string
}

function readProxyPortIdentity(path: string): ProxyPortIdentity | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null) {
      return null
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
      (generation !== undefined && typeof generation !== 'string')
    ) {
      return null
    }
    return { port, pid, generation }
  } catch {
    return null
  }
}

function matchesProxyPortIdentity(current: ProxyPortIdentity | null, expected: ProxyPortIdentity): boolean {
  if (!current || current.port !== expected.port || current.pid !== expected.pid) {
    return false
  }
  return !current.generation || !expected.generation || current.generation === expected.generation
}

export function removeOwnedProxyPortFile(path: string, expected: ProxyPortIdentity): boolean {
  const claimedPath = `${path}.${String(process.pid)}.${randomUUID()}.remove`
  try {
    renameSync(path, claimedPath)
  } catch {
    return false
  }

  let discardClaim = false
  try {
    if (matchesProxyPortIdentity(readProxyPortIdentity(claimedPath), expected)) {
      discardClaim = true
      return true
    }
    try {
      linkSync(claimedPath, path)
      discardClaim = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        discardClaim = true
      }
    }
    return false
  } finally {
    if (discardClaim) {
      try {
        unlinkSync(claimedPath)
      } catch {}
    }
  }
}
