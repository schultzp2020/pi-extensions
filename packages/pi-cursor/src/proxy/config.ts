import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NativeToolsMode = 'reject' | 'redirect' | 'native'

export interface CursorConfig {
  version: number
  nativeToolsMode: NativeToolsMode
  maxMode: boolean
  fast: boolean
  thinking: boolean
  maxRetries: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: Readonly<CursorConfig> = {
  version: 1,
  nativeToolsMode: 'reject',
  maxMode: false,
  fast: false,
  thinking: true,
  maxRetries: 2,
}

// fallow-ignore-next-line unused-export
export const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'cursor-config.json')

/** Hard upper bound for maxRetries to prevent runaway retry loops */
const MAX_RETRIES_CAP = 10

// ---------------------------------------------------------------------------
// Env var name map
// ---------------------------------------------------------------------------

const ENV_MAP: Record<string, keyof CursorConfig> = {
  PI_CURSOR_NATIVE_TOOLS_MODE: 'nativeToolsMode',
  PI_CURSOR_MAX_MODE: 'maxMode',
  PI_CURSOR_FAST: 'fast',
  PI_CURSOR_THINKING: 'thinking',
  PI_CURSOR_MAX_RETRIES: 'maxRetries',
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_NATIVE_TOOLS_MODES: ReadonlySet<string> = new Set(['reject', 'redirect', 'native'])

function isNativeToolsMode(v: unknown): v is NativeToolsMode {
  return typeof v === 'string' && VALID_NATIVE_TOOLS_MODES.has(v)
}

function isTruthy(v: string): boolean {
  return v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Read and parse `cursor-config.json`. On missing file, invalid JSON, or
 * malformed values, return defaults. Unknown fields are ignored. Each field
 * is validated independently.
 */
export function loadConfig(configPath: string = CONFIG_PATH): CursorConfig {
  let raw: Record<string, unknown>
  try {
    const text = readFileSync(configPath, 'utf-8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_CONFIG }
    }
    raw = parsed as Record<string, unknown>
  } catch {
    return { ...DEFAULT_CONFIG }
  }

  return {
    version: 1,
    nativeToolsMode: isNativeToolsMode(raw.nativeToolsMode) ? raw.nativeToolsMode : DEFAULT_CONFIG.nativeToolsMode,
    maxMode: typeof raw.maxMode === 'boolean' ? raw.maxMode : DEFAULT_CONFIG.maxMode,
    fast: typeof raw.fast === 'boolean' ? raw.fast : DEFAULT_CONFIG.fast,
    thinking: typeof raw.thinking === 'boolean' ? raw.thinking : DEFAULT_CONFIG.thinking,
    maxRetries:
      typeof raw.maxRetries === 'number' && Number.isFinite(raw.maxRetries) && raw.maxRetries >= 0
        ? Math.min(Math.floor(raw.maxRetries), MAX_RETRIES_CAP)
        : DEFAULT_CONFIG.maxRetries,
  }
}

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

/**
 * Merge provided fields with current config on disk, write to
 * `cursor-config.json`. Creates `~/.pi/agent/` directory if missing.
 * Always writes `version: 1`.
 */
export function saveConfig(config: Partial<CursorConfig>, configPath: string = CONFIG_PATH): void {
  const current = loadConfig(configPath)
  const merged: CursorConfig = {
    ...current,
    ...config,
    version: 1,
  }

  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8')

  _cachedEffective = null
}

// ---------------------------------------------------------------------------
// resolveEffective
// ---------------------------------------------------------------------------

let _cachedEffective: CursorConfig | null = null

/** Invalidate the cached config (e.g. after saveConfig or for tests). */
// fallow-ignore-next-line unused-export
export function invalidateConfigCache(): void {
  _cachedEffective = null
}

/**
 * Load config, then apply environment variable overrides:
 * - `PI_CURSOR_NATIVE_TOOLS_MODE`
 * - `PI_CURSOR_MAX_MODE` (truthy → true)
 * - `PI_CURSOR_FAST` (truthy → true)
 * - `PI_CURSOR_THINKING` (truthy → true)
 * - `PI_CURSOR_MAX_RETRIES` (parse int)
 */
export function resolveEffective(configPath: string = CONFIG_PATH): CursorConfig {
  if (_cachedEffective && configPath === CONFIG_PATH) {
    return { ..._cachedEffective }
  }

  const cfg = loadConfig(configPath)

  const ntm = process.env.PI_CURSOR_NATIVE_TOOLS_MODE
  if (ntm !== undefined && isNativeToolsMode(ntm)) {
    cfg.nativeToolsMode = ntm
  }

  const mm = process.env.PI_CURSOR_MAX_MODE
  if (mm !== undefined) {
    cfg.maxMode = isTruthy(mm)
  }

  const fast = process.env.PI_CURSOR_FAST
  if (fast !== undefined) {
    cfg.fast = isTruthy(fast)
  }

  const thinking = process.env.PI_CURSOR_THINKING
  if (thinking !== undefined) {
    cfg.thinking = isTruthy(thinking)
  }

  const mr = process.env.PI_CURSOR_MAX_RETRIES
  if (mr !== undefined) {
    const parsed = Number.parseInt(mr, 10)
    if (Number.isFinite(parsed) && parsed >= 0) {
      cfg.maxRetries = Math.min(parsed, MAX_RETRIES_CAP)
    }
  }

  if (configPath === CONFIG_PATH) {
    _cachedEffective = { ...cfg }
  }

  return cfg
}

// ---------------------------------------------------------------------------
// getEnvOverrides
// ---------------------------------------------------------------------------

/**
 * Return a map of which config fields are currently overridden by environment
 * variables and their env var names.
 */
export function getEnvOverrides(): Partial<Record<keyof CursorConfig, string>> {
  const overrides: Partial<Record<keyof CursorConfig, string>> = {}

  for (const [envName, field] of Object.entries(ENV_MAP)) {
    if (process.env[envName] !== undefined) {
      overrides[field] = envName
    }
  }

  return overrides
}
