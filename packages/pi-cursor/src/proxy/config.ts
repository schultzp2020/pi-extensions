import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NativeToolsMode = 'reject' | 'redirect' | 'native';
export type ModelMappingsMode = 'normalized' | 'raw';

export interface CursorConfig {
  version: number;
  nativeToolsMode: NativeToolsMode;
  maxMode: boolean;
  modelMappings: ModelMappingsMode;
  maxRetries: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: Readonly<CursorConfig> = {
  version: 1,
  nativeToolsMode: 'reject',
  maxMode: false,
  modelMappings: 'normalized',
  maxRetries: 2,
};

export const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'cursor-config.json');

// ---------------------------------------------------------------------------
// Env var name map
// ---------------------------------------------------------------------------

const ENV_MAP: Record<string, keyof CursorConfig> = {
  PI_CURSOR_NATIVE_TOOLS_MODE: 'nativeToolsMode',
  PI_CURSOR_MAX_MODE: 'maxMode',
  PI_CURSOR_RAW_MODELS: 'modelMappings',
  PI_CURSOR_MAX_RETRIES: 'maxRetries',
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_NATIVE_TOOLS_MODES: ReadonlySet<string> = new Set(['reject', 'redirect', 'native']);
const VALID_MODEL_MAPPINGS: ReadonlySet<string> = new Set(['normalized', 'raw']);

function isNativeToolsMode(v: unknown): v is NativeToolsMode {
  return typeof v === 'string' && VALID_NATIVE_TOOLS_MODES.has(v);
}

function isModelMappingsMode(v: unknown): v is ModelMappingsMode {
  return typeof v === 'string' && VALID_MODEL_MAPPINGS.has(v);
}

function isTruthy(v: string): boolean {
  return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Read and parse `cursor-config.json`. On missing file, invalid JSON, or
 * malformed values, return defaults. Unknown fields are ignored. Each field
 * is validated independently — a bad `nativeToolsMode` doesn't invalidate
 * `maxRetries`.
 */
export function loadConfig(configPath: string = CONFIG_PATH): CursorConfig {
  let raw: Record<string, unknown>;
  try {
    const text = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_CONFIG };
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  return {
    version: 1, // always v1 regardless of file content
    nativeToolsMode: isNativeToolsMode(raw.nativeToolsMode)
      ? raw.nativeToolsMode
      : DEFAULT_CONFIG.nativeToolsMode,
    maxMode: typeof raw.maxMode === 'boolean' ? raw.maxMode : DEFAULT_CONFIG.maxMode,
    modelMappings: isModelMappingsMode(raw.modelMappings)
      ? raw.modelMappings
      : DEFAULT_CONFIG.modelMappings,
    maxRetries:
      typeof raw.maxRetries === 'number' && Number.isFinite(raw.maxRetries) && raw.maxRetries >= 0
        ? Math.floor(raw.maxRetries)
        : DEFAULT_CONFIG.maxRetries,
  };
}

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

/**
 * Merge provided fields with current config on disk, write to
 * `cursor-config.json`. Creates `~/.pi/agent/` directory if missing.
 * Always writes `version: 1`.
 */
export function saveConfig(
  config: Partial<CursorConfig>,
  configPath: string = CONFIG_PATH,
): void {
  const current = loadConfig(configPath);
  const merged: CursorConfig = {
    ...current,
    ...config,
    version: 1, // always v1
  };

  const dir = join(configPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// resolveEffective
// ---------------------------------------------------------------------------

/**
 * Load config, then apply environment variable overrides:
 * - `PI_CURSOR_NATIVE_TOOLS_MODE`
 * - `PI_CURSOR_MAX_MODE` (truthy string → true)
 * - `PI_CURSOR_RAW_MODELS` (truthy → modelMappings: 'raw')
 * - `PI_CURSOR_MAX_RETRIES` (parse int)
 */
export function resolveEffective(configPath: string = CONFIG_PATH): CursorConfig {
  const cfg = loadConfig(configPath);

  const ntm = process.env.PI_CURSOR_NATIVE_TOOLS_MODE;
  if (ntm !== undefined && isNativeToolsMode(ntm)) {
    cfg.nativeToolsMode = ntm;
  }

  const mm = process.env.PI_CURSOR_MAX_MODE;
  if (mm !== undefined) {
    cfg.maxMode = isTruthy(mm);
  }

  const rm = process.env.PI_CURSOR_RAW_MODELS;
  if (rm !== undefined) {
    cfg.modelMappings = isTruthy(rm) ? 'raw' : 'normalized';
  }

  const mr = process.env.PI_CURSOR_MAX_RETRIES;
  if (mr !== undefined) {
    const parsed = parseInt(mr, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      cfg.maxRetries = parsed;
    }
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// getEnvOverrides
// ---------------------------------------------------------------------------

/**
 * Return a map of which config fields are currently overridden by environment
 * variables and their env var names. Used by the `/cursor` command to show
 * override indicators.
 */
export function getEnvOverrides(): Partial<Record<keyof CursorConfig, string>> {
  const overrides: Partial<Record<keyof CursorConfig, string>> = {};

  for (const [envName, field] of Object.entries(ENV_MAP)) {
    if (process.env[envName] !== undefined) {
      overrides[field] = envName;
    }
  }

  return overrides;
}
