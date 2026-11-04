import { resolve } from 'node:path'

import { EGM_PACKAGE_SPEC } from './egm.ts'

export type Settings = Record<string, unknown> & {
  packages?: unknown[]
  subagents?: { agentScanDirs?: unknown }
}

/**
 * Add dir to subagents.agentScanDirs if absent.
 * Returns the (possibly same) settings object and whether it changed.
 */
export function ensureAgentScanDir(settings: Settings, dir: string): { settings: Settings; changed: boolean } {
  const normalized = resolve(dir)
  const subagents = (settings.subagents ??= {})
  const raw: unknown = subagents.agentScanDirs
  const dirs: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : []
  const exists = dirs.some((d) => typeof d === 'string' && resolve(d) === normalized)
  if (exists) {
    return { settings, changed: false }
  }
  subagents.agentScanDirs = [...dirs, normalized]
  settings.subagents = subagents
  return { settings, changed: true }
}

/**
 * Point the EGM package spec at ref (pin), or drop the pin when ref is undefined.
 * No-op when the package is not in settings.
 */
export function pinEgmPackageRef(
  settings: Settings,
  ref: string | undefined,
): { settings: Settings; changed: boolean } {
  const { packages } = settings
  if (!Array.isArray(packages)) {
    return { settings, changed: false }
  }
  const target = ref ? `${EGM_PACKAGE_SPEC}@${ref}` : EGM_PACKAGE_SPEC
  let changed = false
  const next = packages.map((entry) => {
    if (typeof entry !== 'string') {
      return entry
    }
    const isEgm = entry === EGM_PACKAGE_SPEC || entry.startsWith(`${EGM_PACKAGE_SPEC}@`)
    if (!isEgm || entry === target) {
      return entry
    }
    changed = true
    return target
  })
  settings.packages = next
  return { settings, changed }
}
