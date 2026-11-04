import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { EGM_PACKAGE_SPEC } from './egm.ts'
import {
  egmPinnedRefFromSettings,
  ensureAgentScanDir,
  type Settings,
  isRecord,
  pinEgmPackageRef,
  removeAgentScanDir,
} from './settings.ts'

const AGENTS = resolve('/egm/agents')

describe('ensureAgentScanDir', () => {
  it('adds the dir when absent', () => {
    const settings: Settings = {}
    const result = ensureAgentScanDir(settings, AGENTS)
    expect(result.changed).toBeTruthy()
    expect((result.settings.subagents as { agentScanDirs?: string[] }).agentScanDirs).toEqual([AGENTS])
  })

  it('preserves existing entries and does not duplicate', () => {
    const settings: Settings = { subagents: { agentScanDirs: [resolve('/other')] } }
    const first = ensureAgentScanDir(settings, AGENTS)
    expect(first.changed).toBeTruthy()
    const second = ensureAgentScanDir(first.settings, AGENTS)
    expect(second.changed).toBeFalsy()
    expect((second.settings.subagents as { agentScanDirs?: string[] }).agentScanDirs).toHaveLength(2)
  })

  it('fails closed on unsupported shapes instead of rewriting them', () => {
    const nullSettings = null as unknown as Settings
    expect(ensureAgentScanDir(nullSettings, AGENTS).changed).toBeFalsy()
    expect(ensureAgentScanDir({ subagents: 'legacy' }, AGENTS).changed).toBeFalsy()
    expect(ensureAgentScanDir({ subagents: ['a'] }, AGENTS).changed).toBeFalsy()
    expect(ensureAgentScanDir({ subagents: { agentScanDirs: 'garbage' } }, AGENTS).changed).toBeFalsy()
  })
})

describe('removeAgentScanDir', () => {
  it('removes only the named dir', () => {
    const settings: Settings = { subagents: { agentScanDirs: [resolve('/other'), AGENTS] } }
    const result = removeAgentScanDir(settings, AGENTS)
    expect(result.changed).toBeTruthy()
    expect((result.settings.subagents as { agentScanDirs?: string[] }).agentScanDirs).toEqual([resolve('/other')])
  })

  it('is a no-op when absent', () => {
    const settings: Settings = { subagents: { agentScanDirs: [resolve('/other')] } }
    expect(removeAgentScanDir(settings, AGENTS).changed).toBeFalsy()
  })
})

describe('pinEgmPackageRef', () => {
  it('pins an unpinned string spec', () => {
    const settings: Settings = { packages: [EGM_PACKAGE_SPEC, 'npm:other'] }
    const result = pinEgmPackageRef(settings, 'v0.2.0')
    expect(result.changed).toBeTruthy()
    expect(result.settings.packages).toEqual([`${EGM_PACKAGE_SPEC}@v0.2.0`, 'npm:other'])
  })

  it('moves an existing pin and unpins with undefined', () => {
    const settings: Settings = { packages: [`${EGM_PACKAGE_SPEC}@v0.1.0`] }
    expect(pinEgmPackageRef(settings, 'v0.3.0').settings.packages).toEqual([`${EGM_PACKAGE_SPEC}@v0.3.0`])
    expect(pinEgmPackageRef(settings, undefined).settings.packages).toEqual([EGM_PACKAGE_SPEC])
  })

  it('pins object-form entries while preserving resource filters', () => {
    const settings: Settings = {
      packages: [{ source: EGM_PACKAGE_SPEC, skills: ['./custom-skills'] }],
    }
    const result = pinEgmPackageRef(settings, 'v0.2.0')
    expect(result.changed).toBeTruthy()
    expect(result.settings.packages).toEqual([{ source: `${EGM_PACKAGE_SPEC}@v0.2.0`, skills: ['./custom-skills'] }])
  })

  it('unpins object-form entries', () => {
    const settings: Settings = { packages: [{ source: `${EGM_PACKAGE_SPEC}@v0.1.0` }] }
    const result = pinEgmPackageRef(settings, undefined)
    expect(result.settings.packages).toEqual([{ source: EGM_PACKAGE_SPEC }])
  })

  it('is a no-op when already at the target or package absent', () => {
    expect(pinEgmPackageRef({ packages: [`${EGM_PACKAGE_SPEC}@v0.1.0`] }, 'v0.1.0').changed).toBeFalsy()
    expect(pinEgmPackageRef({ packages: ['npm:other'] }, 'v0.1.0').changed).toBeFalsy()
    expect(pinEgmPackageRef({ packages: [{ source: 'npm:other' }] }, 'v0.1.0').changed).toBeFalsy()
    expect(pinEgmPackageRef({}, 'v0.1.0').changed).toBeFalsy()
  })
})

describe('egmPinnedRefFromSettings', () => {
  it('reads the pin from string and object entries alike', () => {
    expect(egmPinnedRefFromSettings({ packages: [`${EGM_PACKAGE_SPEC}@v0.2.0`] })).toBe('v0.2.0')
    expect(egmPinnedRefFromSettings({ packages: [{ source: `${EGM_PACKAGE_SPEC}@v0.2.0` }] })).toBe('v0.2.0')
    expect(egmPinnedRefFromSettings({ packages: [EGM_PACKAGE_SPEC] })).toBeUndefined()
    expect(egmPinnedRefFromSettings({ packages: [{ source: 'npm:other' }] })).toBeUndefined()
    expect(egmPinnedRefFromSettings({})).toBeUndefined()
  })
})

describe('isRecord', () => {
  it('rejects null, arrays, and primitives', () => {
    expect(isRecord({})).toBeTruthy()
    expect(isRecord(null)).toBeFalsy()
    expect(isRecord([])).toBeFalsy()
    expect(isRecord('x')).toBeFalsy()
  })
})
