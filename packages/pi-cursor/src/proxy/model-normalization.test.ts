import { describe, it, expect } from 'vitest'

import {
  buildEffortMap,
  parseSlug,
  processModels,
  resolveModelId,
  type CursorEffort,
  type NormalizedModelSet,
} from './model-normalization.ts'
import type { CursorModel } from './models.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(id: string, overrides?: Partial<CursorModel>): CursorModel {
  return {
    id,
    name: id,
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    supportsImages: true,
    supportsMaxMode: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// parseSlug
// ---------------------------------------------------------------------------

describe('parseSlug', () => {
  it('parses a simple slug with no suffixes', () => {
    expect(parseSlug('claude-4.6-opus')).toEqual({
      base: 'claude-4.6-opus',
      effort: null,
      thinking: false,
      fast: false,
    })
  })

  it('parses an effort suffix', () => {
    expect(parseSlug('gpt-5.4-high')).toEqual({
      base: 'gpt-5.4',
      effort: 'high',
      thinking: false,
      fast: false,
    })
  })

  it('parses -fast suffix', () => {
    expect(parseSlug('gpt-5.4-fast')).toEqual({
      base: 'gpt-5.4',
      effort: null,
      thinking: false,
      fast: true,
    })
  })

  it('parses -thinking suffix', () => {
    expect(parseSlug('claude-4.6-opus-thinking')).toEqual({
      base: 'claude-4.6-opus',
      effort: null,
      thinking: true,
      fast: false,
    })
  })

  it('parses effort + fast', () => {
    expect(parseSlug('gpt-5.4-high-fast')).toEqual({
      base: 'gpt-5.4',
      effort: 'high',
      thinking: false,
      fast: true,
    })
  })

  it('parses effort + thinking', () => {
    expect(parseSlug('claude-4.6-opus-max-thinking')).toEqual({
      base: 'claude-4.6-opus',
      effort: 'max',
      thinking: true,
      fast: false,
    })
  })

  it('parses effort + thinking + fast', () => {
    expect(parseSlug('claude-4.6-opus-high-thinking-fast')).toEqual({
      base: 'claude-4.6-opus',
      effort: 'high',
      thinking: true,
      fast: true,
    })
  })

  it('parses thinking before effort', () => {
    expect(parseSlug('claude-opus-4-7-thinking-medium')).toEqual({
      base: 'claude-opus-4-7',
      effort: 'medium',
      thinking: true,
      fast: false,
    })
  })

  it('parses fast before effort', () => {
    expect(parseSlug('grok-4.5-fast-medium')).toEqual({
      base: 'grok-4.5',
      effort: 'medium',
      thinking: false,
      fast: true,
    })
  })

  it('parses thinking and fast before effort', () => {
    expect(parseSlug('claude-opus-4-7-thinking-low-fast')).toEqual({
      base: 'claude-opus-4-7',
      effort: 'low',
      thinking: true,
      fast: true,
    })
  })

  it('parses -minimal effort', () => {
    expect(parseSlug('gemini-3.6-flash-minimal')).toEqual({
      base: 'gemini-3.6-flash',
      effort: 'minimal',
      thinking: false,
      fast: false,
    })
  })

  it('parses -extra-high effort', () => {
    expect(parseSlug('gpt-5.5-extra-high-fast')).toEqual({
      base: 'gpt-5.5',
      effort: 'extra-high',
      thinking: false,
      fast: true,
    })
  })

  it('parses -none effort', () => {
    expect(parseSlug('gpt-5.4-none')).toEqual({
      base: 'gpt-5.4',
      effort: 'none',
      thinking: false,
      fast: false,
    })
  })

  it('parses -none effort + fast', () => {
    expect(parseSlug('gpt-5.4-none-fast')).toEqual({
      base: 'gpt-5.4',
      effort: 'none',
      thinking: false,
      fast: true,
    })
  })

  it('handles single-segment slug', () => {
    expect(parseSlug('composer')).toEqual({
      base: 'composer',
      effort: null,
      thinking: false,
      fast: false,
    })
  })
})

// ---------------------------------------------------------------------------
// buildEffortMap
// ---------------------------------------------------------------------------

describe('buildEffortMap', () => {
  it('maps all Pi effort levels with full effort set', () => {
    const efforts = new Set<CursorEffort | 'default'>(['none', 'low', 'default', 'medium', 'high', 'xhigh', 'max'])
    const map = buildEffortMap(efforts)
    expect(map.minimal).toBe('none')
    expect(map.low).toBe('low')
    expect(map.medium).toBe('medium')
    expect(map.high).toBe('high')
    expect(map.xhigh).toBe('max')
  })

  it('maps xhigh to max when both exist', () => {
    const efforts = new Set<CursorEffort | 'default'>(['low', 'high', 'xhigh', 'max'])
    const map = buildEffortMap(efforts)
    expect(map.xhigh).toBe('max')
  })

  it('maps xhigh to xhigh when no max available', () => {
    const efforts = new Set<CursorEffort | 'default'>(['low', 'medium', 'high', 'xhigh'])
    const map = buildEffortMap(efforts)
    expect(map.xhigh).toBe('xhigh')
  })

  it('maps xhigh to high when no elevated effort is available', () => {
    const efforts = new Set<CursorEffort | 'default'>(['low', 'medium', 'high'])
    const map = buildEffortMap(efforts)
    expect(map.xhigh).toBe('high')
  })

  it('maps Cursor minimal and extra-high efforts', () => {
    const efforts = new Set<CursorEffort | 'default'>(['minimal', 'low', 'medium', 'high', 'extra-high'])
    const map = buildEffortMap(efforts)
    expect(map.minimal).toBe('minimal')
    expect(map.low).toBe('low')
    expect(map.xhigh).toBe('extra-high')
  })

  it('maps medium to empty string for default-only', () => {
    const efforts = new Set<CursorEffort | 'default'>(['default', 'high'])
    const map = buildEffortMap(efforts)
    expect(map.medium).toBe('')
  })

  it('handles empty effort set', () => {
    const efforts = new Set<CursorEffort | 'default'>()
    const map = buildEffortMap(efforts)
    expect(map.minimal).toBe('')
    expect(map.xhigh).toBe('')
  })
})

// ---------------------------------------------------------------------------
// processModels — builds metadata from legacySlugs
// ---------------------------------------------------------------------------

describe('processModels', () => {
  it('extracts effort levels from legacy slugs', () => {
    const models = [
      makeModel('gpt-5.4', {
        legacySlugs: ['gpt-5.4-low', 'gpt-5.4-medium', 'gpt-5.4-high', 'gpt-5.4-xhigh'],
      }),
    ]
    const result = processModels(models)

    const meta = result.modelMeta.get('gpt-5.4')
    expect(meta).toBeDefined()
    expect(meta?.efforts.has('low')).toBeTruthy()
    expect(meta?.efforts.has('medium')).toBeTruthy()
    expect(meta?.efforts.has('high')).toBeTruthy()
    expect(meta?.efforts.has('xhigh')).toBeTruthy()
    expect(meta?.efforts.has('default')).toBeTruthy()

    expect(result.effortMaps.has('gpt-5.4')).toBeTruthy()
  })

  it('detects fast support from legacy slugs', () => {
    const models = [
      makeModel('gpt-5.4', {
        legacySlugs: ['gpt-5.4-low', 'gpt-5.4-low-fast', 'gpt-5.4-high', 'gpt-5.4-high-fast'],
      }),
    ]
    const result = processModels(models)

    const meta = result.modelMeta.get('gpt-5.4')
    expect(meta?.supportsFast).toBeTruthy()
  })

  it('detects thinking support from legacy slugs', () => {
    const models = [
      makeModel('claude-opus-4-6', {
        legacySlugs: ['claude-4.6-opus-high', 'claude-4.6-opus-high-thinking', 'claude-4.6-opus-high-thinking-fast'],
      }),
    ]
    const result = processModels(models)

    const meta = result.modelMeta.get('claude-opus-4-6')
    expect(meta?.supportsThinking).toBeTruthy()
    expect(meta?.supportsFast).toBeTruthy()
  })

  it('model with no legacy slugs gets default-only metadata', () => {
    const models = [makeModel('gemini-3.1-pro')]
    const result = processModels(models)

    const meta = result.modelMeta.get('gemini-3.1-pro')
    expect(meta?.efforts.size).toBe(1)
    expect(meta?.efforts.has('default')).toBeTruthy()
    expect(meta?.supportsFast).toBeFalsy()
    expect(meta?.supportsThinking).toBeFalsy()

    expect(result.effortMaps.has('gemini-3.1-pro')).toBeFalsy()
  })

  it('builds slug lookup table', () => {
    const models = [
      makeModel('gpt-5.4', {
        legacySlugs: ['gpt-5.4-high', 'gpt-5.4-high-fast'],
      }),
    ]
    const result = processModels(models)

    expect(result.slugLookup.get('gpt-5.4|high|false|false')).toBe('gpt-5.4-high')
    expect(result.slugLookup.get('gpt-5.4|high|true|false')).toBe('gpt-5.4-high-fast')
  })

  it('keeps the first slug when compatibility aliases collide', () => {
    const models = [
      makeModel('grok-4.5', {
        legacySlugs: ['cursor-grok-4.5-medium', 'grok-4.5-medium'],
      }),
    ]
    const result = processModels(models)

    expect(result.slugLookup.get('grok-4.5|medium|false|false')).toBe('cursor-grok-4.5-medium')
  })
})

// ---------------------------------------------------------------------------
// resolveModelId
// ---------------------------------------------------------------------------

describe('resolveModelId', () => {
  function buildGptModelSet(): NormalizedModelSet {
    return processModels([
      makeModel('gpt-5.4', {
        legacySlugs: [
          'gpt-5.4-none',
          'gpt-5.4-none-fast',
          'gpt-5.4-low',
          'gpt-5.4-low-fast',
          'gpt-5.4-medium',
          'gpt-5.4-medium-fast',
          'gpt-5.4-high',
          'gpt-5.4-high-fast',
          'gpt-5.4-xhigh',
          'gpt-5.4-xhigh-fast',
        ],
      }),
    ])
  }

  function buildClaudeModelSet(): NormalizedModelSet {
    return processModels([
      makeModel('claude-opus-4-6', {
        legacySlugs: [
          'claude-4.6-opus-low',
          'claude-4.6-opus-low-fast',
          'claude-4.6-opus-high',
          'claude-4.6-opus-high-fast',
          'claude-4.6-opus-max',
          'claude-4.6-opus-max-fast',
          'claude-4.6-opus-low-thinking',
          'claude-4.6-opus-low-thinking-fast',
          'claude-4.6-opus-high-thinking',
          'claude-4.6-opus-high-thinking-fast',
          'claude-4.6-opus-max-thinking',
          'claude-4.6-opus-max-thinking-fast',
        ],
      }),
    ])
  }

  it('resolves GPT with high effort', () => {
    const modelSet = buildGptModelSet()
    expect(resolveModelId('gpt-5.4', 'high', false, false, modelSet)).toBe('gpt-5.4-high')
  })

  it('resolves GPT with high effort + fast', () => {
    const modelSet = buildGptModelSet()
    expect(resolveModelId('gpt-5.4', 'high', true, false, modelSet)).toBe('gpt-5.4-high-fast')
  })

  it('resolves GPT with xhigh → maps to xhigh', () => {
    const modelSet = buildGptModelSet()
    expect(resolveModelId('gpt-5.4', 'xhigh', false, false, modelSet)).toBe('gpt-5.4-xhigh')
  })

  it('resolves GPT with no effort → returns model ID as-is', () => {
    const modelSet = buildGptModelSet()
    expect(resolveModelId('gpt-5.4', null, false, false, modelSet)).toBe('gpt-5.4')
  })

  it('silently ignores fast for models without fast support', () => {
    const modelSet = processModels([makeModel('gemini-3.1-pro')])
    expect(resolveModelId('gemini-3.1-pro', null, true, false, modelSet)).toBe('gemini-3.1-pro')
  })

  it('silently ignores thinking for models without thinking support', () => {
    const modelSet = buildGptModelSet()
    expect(resolveModelId('gpt-5.4', 'high', false, true, modelSet)).toBe('gpt-5.4-high')
  })

  it('resolves Claude with thinking on', () => {
    const modelSet = buildClaudeModelSet()
    expect(resolveModelId('claude-opus-4-6', 'high', false, true, modelSet)).toBe('claude-4.6-opus-high-thinking')
  })

  it('resolves Claude with thinking off', () => {
    const modelSet = buildClaudeModelSet()
    expect(resolveModelId('claude-opus-4-6', 'high', false, false, modelSet)).toBe('claude-4.6-opus-high')
  })

  it('resolves Claude with thinking + fast', () => {
    const modelSet = buildClaudeModelSet()
    expect(resolveModelId('claude-opus-4-6', 'high', true, true, modelSet)).toBe('claude-4.6-opus-high-thinking-fast')
  })

  it('resolves Claude with xhigh thinking → maps to max thinking', () => {
    const modelSet = buildClaudeModelSet()
    expect(resolveModelId('claude-opus-4-6', 'xhigh', false, true, modelSet)).toBe('claude-4.6-opus-max-thinking')
  })

  it('ignores effort when a model only has default thinking variants', () => {
    const modelSet = processModels([
      makeModel('claude-haiku-4-5', {
        legacySlugs: ['claude-4.5-haiku', 'claude-4.5-haiku-thinking'],
      }),
    ])

    expect(resolveModelId('claude-haiku-4-5', 'low', false, true, modelSet)).toBe('claude-4.5-haiku-thinking')
    expect(resolveModelId('claude-haiku-4-5', 'low', false, false, modelSet)).toBe('claude-4.5-haiku')
  })

  it('preserves thinking by falling back to its default effort', () => {
    const modelSet = processModels([
      makeModel('claude-example', {
        legacySlugs: ['claude-example-low', 'claude-example-thinking'],
      }),
    ])

    expect(resolveModelId('claude-example', 'low', false, true, modelSet)).toBe('claude-example-thinking')
  })

  it('drops fast before thinking when their combination is unavailable', () => {
    const modelSet = processModels([
      makeModel('claude-example', {
        legacySlugs: ['claude-example-low-fast', 'claude-example-high', 'claude-example-high-thinking'],
      }),
    ])

    expect(resolveModelId('claude-example', 'high', true, true, modelSet)).toBe('claude-example-high-thinking')
  })

  it('resolves unknown model ID → returns as-is', () => {
    const modelSet = buildGptModelSet()
    expect(resolveModelId('unknown-model', 'high', true, false, modelSet)).toBe('unknown-model')
  })
})

// ---------------------------------------------------------------------------
// Current Cursor legacy slug regressions
// ---------------------------------------------------------------------------

describe('current Cursor legacy slug regressions', () => {
  const cases: {
    name: string
    id: string
    legacySlugs: string[]
    effort: string
    fast: boolean
    thinking: boolean
    expected: string
  }[] = [
    {
      name: 'Claude Haiku 4.5 default thinking variant',
      id: 'claude-haiku-4-5',
      legacySlugs: ['claude-4.5-haiku', 'claude-4.5-haiku-thinking'],
      effort: 'low',
      fast: false,
      thinking: true,
      expected: 'claude-4.5-haiku-thinking',
    },
    {
      name: 'Claude Sonnet 4 default thinking variant',
      id: 'claude-sonnet-4',
      legacySlugs: ['claude-4-sonnet', 'claude-4-sonnet-thinking'],
      effort: 'high',
      fast: false,
      thinking: true,
      expected: 'claude-4-sonnet-thinking',
    },
    {
      name: 'Claude Sonnet 4.5 default thinking variant',
      id: 'claude-sonnet-4-5',
      legacySlugs: ['claude-4.5-sonnet', 'claude-4.5-sonnet-thinking'],
      effort: 'xhigh',
      fast: false,
      thinking: true,
      expected: 'claude-4.5-sonnet-thinking',
    },
    {
      name: 'Claude Fable 5 reordered thinking suffix',
      id: 'claude-fable-5',
      legacySlugs: ['claude-fable-5-medium', 'claude-fable-5-thinking-medium'],
      effort: 'medium',
      fast: false,
      thinking: true,
      expected: 'claude-fable-5-thinking-medium',
    },
    {
      name: 'Claude Opus 4.7 reordered thinking and fast suffixes',
      id: 'claude-opus-4-7',
      legacySlugs: [
        'claude-opus-4-7-high',
        'claude-opus-4-7-high-fast',
        'claude-opus-4-7-thinking-high',
        'claude-opus-4-7-thinking-high-fast',
      ],
      effort: 'high',
      fast: true,
      thinking: true,
      expected: 'claude-opus-4-7-thinking-high-fast',
    },
    {
      name: 'Claude Opus 4.8 reordered thinking suffix',
      id: 'claude-opus-4-8',
      legacySlugs: ['claude-opus-4-8-medium', 'claude-opus-4-8-thinking-medium'],
      effort: 'medium',
      fast: false,
      thinking: true,
      expected: 'claude-opus-4-8-thinking-medium',
    },
    {
      name: 'Claude Opus 5 sparse non-thinking efforts',
      id: 'claude-opus-5',
      legacySlugs: [
        'claude-opus-5-low',
        'claude-opus-5-medium',
        'claude-opus-5-high',
        'claude-opus-5-thinking-high',
        'claude-opus-5-thinking-xhigh',
        'claude-opus-5-thinking-max',
      ],
      effort: 'xhigh',
      fast: false,
      thinking: false,
      expected: 'claude-opus-5-high',
    },
    {
      name: 'Claude Sonnet 5 reordered thinking suffix',
      id: 'claude-sonnet-5',
      legacySlugs: [
        'claude-sonnet-5-high',
        'claude-sonnet-5-max',
        'claude-sonnet-5-thinking-high',
        'claude-sonnet-5-thinking-max',
      ],
      effort: 'xhigh',
      fast: false,
      thinking: true,
      expected: 'claude-sonnet-5-thinking-max',
    },
    {
      name: 'Gemini 3.6 Flash minimal effort',
      id: 'gemini-3.6-flash',
      legacySlugs: [
        'gemini-3.6-flash-minimal',
        'gemini-3.6-flash-low',
        'gemini-3.6-flash-medium',
        'gemini-3.6-flash-high',
      ],
      effort: 'minimal',
      fast: false,
      thinking: false,
      expected: 'gemini-3.6-flash-minimal',
    },
    {
      name: 'GPT-5.5 extra-high fast effort',
      id: 'gpt-5.5',
      legacySlugs: ['gpt-5.5-high', 'gpt-5.5-high-fast', 'gpt-5.5-extra-high', 'gpt-5.5-extra-high-fast'],
      effort: 'xhigh',
      fast: true,
      thinking: false,
      expected: 'gpt-5.5-extra-high-fast',
    },
    {
      name: 'Grok 4.5 canonical non-fast alias',
      id: 'grok-4.5',
      legacySlugs: ['cursor-grok-4.5-medium', 'cursor-grok-4.5-medium-fast', 'grok-4.5-medium', 'grok-4.5-fast-medium'],
      effort: 'medium',
      fast: false,
      thinking: false,
      expected: 'cursor-grok-4.5-medium',
    },
  ]

  it.each(cases)('$name', ({ id, legacySlugs, effort, fast, thinking, expected }) => {
    const modelSet = processModels([makeModel(id, { legacySlugs })])
    expect(resolveModelId(id, effort, fast, thinking, modelSet)).toBe(expected)
  })
})
