import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { type RemoteTag, compareVersions, egmAgentsDir, egmCheckoutDir, latestReleaseTag, pinnedRef } from './egm.ts'

describe('compareVersions', () => {
  it('orders semver tags', () => {
    expect(compareVersions('v0.2.0', 'v0.10.0')).toBeLessThan(0)
    expect(compareVersions('v0.10.0', 'v0.2.0')).toBeGreaterThan(0)
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('v2', 'v1.9.9')).toBeGreaterThan(0)
  })
})

describe('latestReleaseTag', () => {
  it('picks the highest numeric tag and ignores non-release refs', () => {
    const tags: RemoteTag[] = [
      { name: 'v0.1.0', oid: 'a' },
      { name: 'v0.10.0', oid: 'b' },
      { name: 'v0.2.0', oid: 'c' },
      { name: 'nightly', oid: 'd' },
    ]
    expect(latestReleaseTag(tags)).toBe('v0.10.0')
  })

  it('returns undefined when no release tags exist', () => {
    expect(latestReleaseTag([{ name: 'nightly', oid: 'd' }])).toBeUndefined()
    expect(latestReleaseTag([])).toBeUndefined()
  })
})

describe('pinnedRef', () => {
  it('extracts the ref or undefined', () => {
    expect(pinnedRef('git:github.com/google/elephant-goldfish-model@v0.1.0')).toBe('v0.1.0')
    expect(pinnedRef('git:github.com/google/elephant-goldfish-model')).toBeUndefined()
    expect(pinnedRef('npm:other')).toBeUndefined()
  })
})

describe('checkout paths', () => {
  it('are ref-independent and nest under the pi git-package layout', () => {
    expect(egmCheckoutDir('/agent')).toBe(join('/agent', 'git', 'github.com', 'google', 'elephant-goldfish-model'))
    expect(egmAgentsDir('/agent')).toBe(
      join('/agent', 'git', 'github.com', 'google', 'elephant-goldfish-model', 'agents'),
    )
  })
})
