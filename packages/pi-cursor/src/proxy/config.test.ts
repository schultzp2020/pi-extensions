import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  loadConfig,
  saveConfig,
  resolveEffective,
  getEnvOverrides,
  DEFAULT_CONFIG,
  type CursorConfig,
} from './config.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'pi-cursor-config-test-'))
}

function tmpConfigPath(dir: string): string {
  return join(dir, 'cursor-config.json')
}

const ENV_KEYS = [
  'PI_CURSOR_NATIVE_TOOLS_MODE',
  'PI_CURSOR_MAX_MODE',
  'PI_CURSOR_FAST',
  'PI_CURSOR_THINKING',
  'PI_CURSOR_MAX_RETRIES',
] as const

let savedEnv: Record<string, string | undefined>
let tmpDir: string

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  tmpDir = makeTmpDir()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore cleanup errors on Windows
  }
})

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('returns defaults when file is missing', () => {
    const cfg = loadConfig(tmpConfigPath(tmpDir))
    expect(cfg).toEqual(DEFAULT_CONFIG)
  })

  it('parses a valid config file', () => {
    const path = tmpConfigPath(tmpDir)
    const data: CursorConfig = {
      version: 1,
      nativeToolsMode: 'native',
      maxMode: true,
      fast: true,
      thinking: false,
      maxRetries: 5,
    }
    writeFileSync(path, JSON.stringify(data))
    expect(loadConfig(path)).toEqual(data)
  })

  it('returns defaults on invalid JSON', () => {
    const path = tmpConfigPath(tmpDir)
    writeFileSync(path, '{not valid json!!!')
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG)
  })

  it('falls back per-field on malformed values', () => {
    const path = tmpConfigPath(tmpDir)
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        nativeToolsMode: 'INVALID',
        maxMode: true,
        fast: 'not-a-bool',
        maxRetries: -1,
      }),
    )
    const cfg = loadConfig(path)
    expect(cfg.nativeToolsMode).toBe('reject') // invalid → default
    expect(cfg.maxMode).toBeTruthy()
    expect(cfg.fast).toBeFalsy() // not a boolean → default false
    expect(cfg.maxRetries).toBe(2) // negative → default 2
  })

  it('ignores unknown fields', () => {
    const path = tmpConfigPath(tmpDir)
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        nativeToolsMode: 'redirect',
        unknownField: 'hello',
        modelMappings: 'raw', // old field, should be ignored
      }),
    )
    const cfg = loadConfig(path)
    expect(cfg.nativeToolsMode).toBe('redirect')
    expect('unknownField' in cfg).toBeFalsy()
    expect('modelMappings' in cfg).toBeFalsy()
  })

  it('returns defaults when file contains a JSON array', () => {
    const path = tmpConfigPath(tmpDir)
    writeFileSync(path, '[1,2,3]')
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG)
  })
})

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

describe('saveConfig', () => {
  it('writes and reads back', () => {
    const path = tmpConfigPath(tmpDir)
    saveConfig({ maxMode: true, fast: true, thinking: false }, path)
    const cfg = loadConfig(path)
    expect(cfg.maxMode).toBeTruthy()
    expect(cfg.fast).toBeTruthy()
    expect(cfg.thinking).toBeFalsy()
    expect(cfg.version).toBe(1)
  })

  it('creates directory if needed', () => {
    const nested = join(tmpDir, 'deep', 'nested')
    const path = join(nested, 'cursor-config.json')
    saveConfig({ maxMode: true }, path)
    const cfg = loadConfig(path)
    expect(cfg.maxMode).toBeTruthy()
  })

  it('always writes version 1', () => {
    const path = tmpConfigPath(tmpDir)
    saveConfig({ version: 99 } as Partial<CursorConfig>, path)
    const cfg = loadConfig(path)
    expect(cfg.version).toBe(1)
  })

  it('merges with existing config', () => {
    const path = tmpConfigPath(tmpDir)
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        nativeToolsMode: 'native',
        maxMode: false,
        fast: false,
        contextWindow: 0,
        maxRetries: 3,
      }),
    )
    saveConfig({ maxRetries: 10, fast: true }, path)
    const cfg = loadConfig(path)
    expect(cfg.nativeToolsMode).toBe('native') // preserved
    expect(cfg.fast).toBeTruthy() // updated
    expect(cfg.maxRetries).toBe(10) // updated
  })
})

// ---------------------------------------------------------------------------
// resolveEffective
// ---------------------------------------------------------------------------

describe('resolveEffective', () => {
  it('env vars override file values', () => {
    const path = tmpConfigPath(tmpDir)
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG))

    process.env.PI_CURSOR_NATIVE_TOOLS_MODE = 'native'
    process.env.PI_CURSOR_MAX_MODE = '1'
    process.env.PI_CURSOR_FAST = 'true'
    process.env.PI_CURSOR_THINKING = '0'
    process.env.PI_CURSOR_MAX_RETRIES = '7'

    const cfg = resolveEffective(path)
    expect(cfg.nativeToolsMode).toBe('native')
    expect(cfg.maxMode).toBeTruthy()
    expect(cfg.fast).toBeTruthy()
    expect(cfg.thinking).toBeFalsy()
    expect(cfg.maxRetries).toBe(7)
  })

  it('env vars override defaults when no file exists', () => {
    process.env.PI_CURSOR_MAX_MODE = 'yes'
    const cfg = resolveEffective(tmpConfigPath(tmpDir))
    expect(cfg.maxMode).toBeTruthy()
    expect(cfg.nativeToolsMode).toBe('reject') // other fields remain default
  })

  it('PI_CURSOR_MAX_MODE=0 is falsy', () => {
    process.env.PI_CURSOR_MAX_MODE = '0'
    const cfg = resolveEffective(tmpConfigPath(tmpDir))
    expect(cfg.maxMode).toBeFalsy()
  })

  it('PI_CURSOR_MAX_MODE=false is falsy', () => {
    process.env.PI_CURSOR_MAX_MODE = 'false'
    const cfg = resolveEffective(tmpConfigPath(tmpDir))
    expect(cfg.maxMode).toBeFalsy()
  })

  it('PI_CURSOR_FAST=0 is falsy', () => {
    process.env.PI_CURSOR_FAST = '0'
    const cfg = resolveEffective(tmpConfigPath(tmpDir))
    expect(cfg.fast).toBeFalsy()
  })

  it('ignores invalid PI_CURSOR_NATIVE_TOOLS_MODE', () => {
    process.env.PI_CURSOR_NATIVE_TOOLS_MODE = 'INVALID'
    const cfg = resolveEffective(tmpConfigPath(tmpDir))
    expect(cfg.nativeToolsMode).toBe('reject')
  })

  it('ignores invalid PI_CURSOR_MAX_RETRIES', () => {
    process.env.PI_CURSOR_MAX_RETRIES = 'abc'
    const cfg = resolveEffective(tmpConfigPath(tmpDir))
    expect(cfg.maxRetries).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// getEnvOverrides
// ---------------------------------------------------------------------------

describe('getEnvOverrides', () => {
  it('returns empty map when no env vars set', () => {
    expect(getEnvOverrides()).toEqual({})
  })

  it('returns correct override map', () => {
    process.env.PI_CURSOR_MAX_MODE = '1'
    process.env.PI_CURSOR_FAST = '1'
    const overrides = getEnvOverrides()
    expect(overrides).toEqual({
      maxMode: 'PI_CURSOR_MAX_MODE',
      fast: 'PI_CURSOR_FAST',
    })
  })

  it('includes all env vars when all are set', () => {
    process.env.PI_CURSOR_NATIVE_TOOLS_MODE = 'native'
    process.env.PI_CURSOR_MAX_MODE = '1'
    process.env.PI_CURSOR_FAST = '1'
    process.env.PI_CURSOR_THINKING = '1'
    process.env.PI_CURSOR_MAX_RETRIES = '5'
    const overrides = getEnvOverrides()
    expect(overrides).toEqual({
      nativeToolsMode: 'PI_CURSOR_NATIVE_TOOLS_MODE',
      maxMode: 'PI_CURSOR_MAX_MODE',
      fast: 'PI_CURSOR_FAST',
      thinking: 'PI_CURSOR_THINKING',
      maxRetries: 'PI_CURSOR_MAX_RETRIES',
    })
  })
})
