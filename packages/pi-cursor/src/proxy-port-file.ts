import { readFileSync, unlinkSync } from 'node:fs'

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

export function removeOwnedProxyPortFileUnderLock(path: string, expected: ProxyPortIdentity): boolean {
  if (!matchesProxyPortIdentity(readProxyPortIdentity(path), expected)) {
    return false
  }
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}
