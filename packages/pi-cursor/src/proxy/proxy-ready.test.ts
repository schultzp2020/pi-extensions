import { describe, expect, it } from 'vitest'

import type { CursorModel } from './models.ts'
import { buildProxyReadySignal } from './proxy-ready.ts'

describe('buildProxyReadySignal', () => {
  it('preserves model metadata needed by the extension', () => {
    const models: CursorModel[] = [
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        reasoning: true,
        contextWindow: 200_000,
        contextWindowMaxMode: 1_000_000,
        maxTokens: 64_000,
        supportsImages: true,
        supportsMaxMode: true,
        legacySlugs: ['gpt-5.5-high', 'gpt-5.5-extra-high'],
      },
    ]

    const signal = buildProxyReadySignal(4321, models)
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Verify JSON process-boundary serialization.
    const roundTripped = JSON.parse(JSON.stringify(signal)) as typeof signal

    expect(roundTripped).toEqual({ type: 'ready', port: 4321, models })
    expect(roundTripped.models[0]?.legacySlugs).toEqual(['gpt-5.5-high', 'gpt-5.5-extra-high'])
    expect(roundTripped.models[0]?.contextWindowMaxMode).toBe(1_000_000)
    expect(roundTripped.models[0]?.supportsMaxMode).toBeTruthy()
  })
})
