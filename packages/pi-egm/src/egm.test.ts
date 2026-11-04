import { describe, expect, it } from 'vitest'

import { compareVersions, type GitRunner, latestReleaseTag, pinnedRef } from './egm.ts'

describe('compareVersions', () => {
  it('orders semver tags', () => {
    expect(compareVersions('v0.2.0', 'v0.10.0')).toBeLessThan(0)
    expect(compareVersions('v0.10.0', 'v0.2.0')).toBeGreaterThan(0)
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('v2', 'v1.9.9')).toBeGreaterThan(0)
  })
})

describe('latestReleaseTag', () => {
  it('picks the highest numeric tag and ignores non-release refs', async () => {
    const run: GitRunner = async () => {
      await Promise.resolve()
      return [
        'a1b2c3\trefs/tags/v0.1.0',
        'd4e5f6\trefs/tags/v0.10.0',
        '789abc\trefs/tags/v0.2.0',
        '000000\trefs/tags/nightly',
      ].join('\n')
    }
    expect(await latestReleaseTag(run)).toBe('v0.10.0')
  })

  it('returns undefined when no release tags exist', async () => {
    const run: GitRunner = async () => {
      await Promise.resolve()
      return '000000\trefs/tags/nightly'
    }
    expect(await latestReleaseTag(run)).toBeUndefined()
  })
})

describe('pinnedRef', () => {
  it('extracts the ref or undefined', () => {
    expect(pinnedRef('git:github.com/google/elephant-goldfish-model@v0.1.0')).toBe('v0.1.0')
    expect(pinnedRef('git:github.com/google/elephant-goldfish-model')).toBeUndefined()
    expect(pinnedRef('npm:other')).toBeUndefined()
  })
})
