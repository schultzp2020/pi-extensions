import { describe, expect, it } from 'vitest'

import { formatTokenCount } from './index.ts'

describe('formatTokenCount', () => {
  it('formats millions', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(2_000_000)).toBe('2M')
  })

  it('formats thousands', () => {
    expect(formatTokenCount(200_000)).toBe('200K')
    expect(formatTokenCount(272_000)).toBe('272K')
    expect(formatTokenCount(500_000)).toBe('500K')
    expect(formatTokenCount(128_000)).toBe('128K')
  })

  it('returns raw number for non-round values', () => {
    expect(formatTokenCount(123_456)).toBe('123456')
    expect(formatTokenCount(999)).toBe('999')
  })
})
