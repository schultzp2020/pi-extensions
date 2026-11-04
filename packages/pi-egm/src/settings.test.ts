import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { EGM_PACKAGE_SPEC } from './egm.ts'
import { ensureAgentScanDir, pinEgmPackageRef, type Settings } from './settings.ts'

describe('ensureAgentScanDir', () => {
  it('adds the dir when absent', () => {
    const settings: Settings = {}
    const result = ensureAgentScanDir(settings, '/some/agents')
    expect(result.changed).toBeTruthy()
    expect(result.settings.subagents?.agentScanDirs).toEqual([resolve('/some/agents')])
  })

  it('preserves existing entries and does not duplicate', () => {
    const settings: Settings = { subagents: { agentScanDirs: ['/other'] } }
    const first = ensureAgentScanDir(settings, '/some/agents')
    expect(first.changed).toBeTruthy()
    const second = ensureAgentScanDir(first.settings, '/some/agents')
    expect(second.changed).toBeFalsy()
    expect(second.settings.subagents?.agentScanDirs).toHaveLength(2)
  })

  it('replaces a non-array agentScanDirs value', () => {
    const settings: Settings = { subagents: { agentScanDirs: 'garbage' } }
    const result = ensureAgentScanDir(settings, '/some/agents')
    expect(result.changed).toBeTruthy()
    expect(Array.isArray(result.settings.subagents?.agentScanDirs)).toBeTruthy()
  })
})

describe('pinEgmPackageRef', () => {
  it('pins an unpinned spec', () => {
    const settings: Settings = { packages: [EGM_PACKAGE_SPEC, 'npm:other'] }
    const result = pinEgmPackageRef(settings, 'v0.2.0')
    expect(result.changed).toBeTruthy()
    expect(result.settings.packages).toEqual([`${EGM_PACKAGE_SPEC}@v0.2.0`, 'npm:other'])
  })

  it('moves an existing pin', () => {
    const settings: Settings = { packages: [`${EGM_PACKAGE_SPEC}@v0.1.0`] }
    const result = pinEgmPackageRef(settings, 'v0.3.0')
    expect(result.changed).toBeTruthy()
    expect(result.settings.packages).toEqual([`${EGM_PACKAGE_SPEC}@v0.3.0`])
  })

  it('unpins when ref is undefined', () => {
    const settings: Settings = { packages: [`${EGM_PACKAGE_SPEC}@v0.1.0`] }
    const result = pinEgmPackageRef(settings, undefined)
    expect(result.changed).toBeTruthy()
    expect(result.settings.packages).toEqual([EGM_PACKAGE_SPEC])
  })

  it('is a no-op when already at the target or package absent', () => {
    expect(pinEgmPackageRef({ packages: [`${EGM_PACKAGE_SPEC}@v0.1.0`] }, 'v0.1.0').changed).toBeFalsy()
    expect(pinEgmPackageRef({ packages: ['npm:other'] }, 'v0.1.0').changed).toBeFalsy()
    expect(pinEgmPackageRef({}, 'v0.1.0').changed).toBeFalsy()
  })
})
