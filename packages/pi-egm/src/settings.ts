import { resolve } from 'node:path'

import { EGM_PACKAGE_SPEC, pinnedRef } from './egm.ts'

export type Settings = Record<string, unknown> & {
  packages?: unknown[]
  /** Runtime shapes vary; validated with isRecord before use. */
  subagents?: unknown
}

/** A package entry as pi writes it: either a bare spec string or an object with `source`. */
export type PackageEntry = string | Record<string, unknown>

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The package spec of an entry, whatever its shape; undefined when it has none. */
export function egmEntrySource(entry: unknown): string | undefined {
  if (typeof entry === 'string') {
    return entry
  }
  if (isRecord(entry) && typeof entry.source === 'string') {
    return entry.source
  }
  return undefined
}

export function isEgmSource(source: string): boolean {
  return source === EGM_PACKAGE_SPEC || source.startsWith(`${EGM_PACKAGE_SPEC}@`)
}

/**
 * Add dir to subagents.agentScanDirs if absent.
 * Fails closed (no change) when settings or subagents has an unsupported shape.
 */
export function ensureAgentScanDir(settings: Settings, dir: string): { settings: Settings; changed: boolean } {
  if (!isRecord(settings)) {
    return { settings, changed: false }
  }
  const subagentsRaw = settings.subagents
  if (subagentsRaw !== undefined && !isRecord(subagentsRaw)) {
    return { settings, changed: false }
  }
  const subagents = (subagentsRaw ?? {}) as { agentScanDirs?: unknown }
  const normalized = resolve(dir)
  const raw: unknown = subagents.agentScanDirs
  const dirs: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : []
  if (raw !== undefined && !Array.isArray(raw)) {
    return { settings, changed: false }
  }
  const exists = dirs.some((d) => typeof d === 'string' && resolve(d) === normalized)
  if (exists) {
    return { settings, changed: false }
  }
  subagents.agentScanDirs = [...dirs, normalized]
  settings.subagents = subagents
  return { settings, changed: true }
}

/** Remove dir from subagents.agentScanDirs; no-op when absent or shapes are unsupported. */
export function removeAgentScanDir(settings: Settings, dir: string): { settings: Settings; changed: boolean } {
  if (!isRecord(settings)) {
    return { settings, changed: false }
  }
  const { subagents } = settings
  if (!isRecord(subagents) || !Array.isArray(subagents.agentScanDirs)) {
    return { settings, changed: false }
  }
  const normalized = resolve(dir)
  const kept = subagents.agentScanDirs.filter((d) => !(typeof d === 'string' && resolve(d) === normalized))
  if (kept.length === subagents.agentScanDirs.length) {
    return { settings, changed: false }
  }
  subagents.agentScanDirs = kept
  return { settings, changed: true }
}

/**
 * Point the EGM package entry at ref (pin), or drop the pin when ref is undefined.
 * Handles both string entries and object entries with a `source` field, preserving
 * any resource filters on the object. No-op when the package is not in settings.
 */
export function pinEgmPackageRef(
  settings: Settings,
  ref: string | undefined,
): { settings: Settings; changed: boolean } {
  if (!isRecord(settings)) {
    return { settings, changed: false }
  }
  const { packages } = settings
  if (!Array.isArray(packages)) {
    return { settings, changed: false }
  }
  const targetSource = ref ? `${EGM_PACKAGE_SPEC}@${ref}` : EGM_PACKAGE_SPEC
  let changed = false
  const next = packages.map((entry) => {
    const source = egmEntrySource(entry)
    if (source === undefined || !isEgmSource(source) || source === targetSource) {
      return entry
    }
    changed = true
    return typeof entry === 'string' ? targetSource : { ...(entry as Record<string, unknown>), source: targetSource }
  })
  settings.packages = next
  return { settings, changed }
}

/** The pinned ref of the EGM package entry in settings, whatever its shape. */
export function egmPinnedRefFromSettings(settings: Settings): string | undefined {
  if (!isRecord(settings) || !Array.isArray(settings.packages)) {
    return undefined
  }
  for (const entry of settings.packages) {
    const source = egmEntrySource(entry)
    if (source !== undefined && isEgmSource(source)) {
      return pinnedRef(source)
    }
  }
  return undefined
}
