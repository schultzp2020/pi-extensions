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

  it('maps xhigh to high when neither max nor xhigh available', () => {
    const efforts = new Set<CursorEffort | 'default'>(['low', 'medium', 'high'])
    const map = buildEffortMap(efforts)
    expect(map.xhigh).toBe('high')
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

  it('resolves unknown model ID → returns as-is', () => {
    const modelSet = buildGptModelSet()
    expect(resolveModelId('unknown-model', 'high', true, false, modelSet)).toBe('unknown-model')
  })
})
