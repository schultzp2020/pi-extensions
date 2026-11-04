import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveAgentDir, wirePersonas } from './index.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-egm-'))
  tempDirs.push(dir)
  return dir
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('resolveAgentDir', () => {
  it('defaults to ~/.pi/agent and honors PI_CODING_AGENT_DIR', () => {
    expect(resolveAgentDir({})).toBe(join(process.env.USERPROFILE ?? '', '.pi', 'agent'))
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: '/custom' })).toBe('/custom')
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: '~/x' })).toBe(
      join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'x'),
    )
  })
})

describe('wirePersonas', () => {
  it('adds the agents scan dir to settings.json once', () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }))

    expect(wirePersonas(dir, () => true)).toBeTruthy()
    const first = readSettings(settingsPath)
    const expected = join(dir, 'git', 'github.com', 'google', 'elephant-goldfish-model', 'agents')
    expect(first.subagents).toEqual({ agentScanDirs: [expected] })
    expect(first.theme).toBe('dark')

    expect(wirePersonas(dir, () => true)).toBeFalsy()
    const second = readSettings(settingsPath)
    expect((second.subagents as { agentScanDirs: string[] }).agentScanDirs).toHaveLength(1)
  })

  it('returns false when settings.json is missing or unreadable', () => {
    expect(wirePersonas(tempDir(), () => true)).toBeFalsy()
    const dir = tempDir()
    writeFileSync(join(dir, 'settings.json'), 'not json')
    expect(wirePersonas(dir, () => true)).toBeFalsy()
  })
})
