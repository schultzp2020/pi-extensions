import { describe, it, expect } from 'vitest'

import {
  buildEffortMap,
  parseModelId,
  processModels,
  resolveModelId,
  supportsReasoningModelId,
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
    maxTokens: 16384,
    supportsImages: true,
    supportsMaxMode: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// parseModelId
// ---------------------------------------------------------------------------

describe('parseModelId', () => {
  it('parses a simple model ID with no suffixes', () => {
    const result = parseModelId('claude-4.5-sonnet')
    expect(result).toEqual({
      base: 'claude-4.5-sonnet',
      effort: null,
      thinking: false,
      fast: false,
      maxMode: false,
    })
  })

  it('parses an effort suffix', () => {
    const result = parseModelId('gpt-5.4-high')
    expect(result).toEqual({
      base: 'gpt-5.4',
      effort: 'high',
      thinking: false,
      fast: false,
      maxMode: false,
    })
  })

  it('parses the -fast suffix', () => {
    const result = parseModelId('gpt-5.4-fast')
    expect(result).toEqual({
      base: 'gpt-5.4',
      effort: null,
      thinking: false,
      fast: true,
      maxMode: false,
    })
  })

  it('parses the -thinking suffix', () => {
    const result = parseModelId('claude-4.6-opus-thinking')
    expect(result).toEqual({
      base: 'claude-4.6-opus',
      effort: null,
      thinking: true,
      fast: false,
      maxMode: false,
    })
  })

  it('strips trailing -max as maxMode flag', () => {
    const result = parseModelId('claude-4.5-sonnet-max')
    expect(result).toEqual({
      base: 'claude-4.5-sonnet',
      effort: null,
      thinking: false,
      fast: false,
      maxMode: true,
    })
  })

  it('parses effort suffix with -fast', () => {
    const result = parseModelId('gpt-5.4-high-fast')
    expect(result).toEqual({
      base: 'gpt-5.4',
      effort: 'high',
      thinking: false,
      fast: true,
      maxMode: false,
    })
  })

  it('parses effort suffix with -thinking', () => {
    const result = parseModelId('claude-4.6-opus-max-thinking')
    expect(result).toEqual({
      base: 'claude-4.6-opus',
      effort: 'max',
      thinking: true,
      fast: false,
      maxMode: false,
    })
  })

  it('handles triple-max: effort max + thinking + fast + maxMode', () => {
    const result = parseModelId('claude-4.6-opus-max-thinking-fast-max')
    expect(result).toEqual({
      base: 'claude-4.6-opus',
      effort: 'max',
      thinking: true,
      fast: true,
      maxMode: true,
    })
  })

  it('handles base name max (gpt-5.1-codex-max) — no effort', () => {
    const result = parseModelId('gpt-5.1-codex-max')
    expect(result).toEqual({
      base: 'gpt-5.1-codex-max',
      effort: null,
      thinking: false,
      fast: false,
      maxMode: false,
    })
  })

  it('handles base name max with maxMode trailing -max', () => {
    // gpt-5.1-codex-max-max → base gpt-5.1-codex-max, maxMode true
    const result = parseModelId('gpt-5.1-codex-max-max')
    expect(result).toEqual({
      base: 'gpt-5.1-codex-max',
      effort: null,
      thinking: false,
      fast: false,
      maxMode: true,
    })
  })

  it('parses -none effort suffix', () => {
    const result = parseModelId('gpt-5.4-none')
    expect(result).toEqual({
      base: 'gpt-5.4',
      effort: 'none',
      thinking: false,
      fast: false,
      maxMode: false,
    })
  })

  it('parses -low effort suffix', () => {
    const result = parseModelId('gpt-5.4-low')
    expect(result).toEqual({
      base: 'gpt-5.4',
      effort: 'low',
      thinking: false,
      fast: false,
      maxMode: false,
    })
  })

  it('parses -medium effort suffix', () => {
    const result = parseModelId('gpt-5.4-medium')
    expect(result).toEqual({
      base: 'gpt-5.4',
      effort: 'medium',
      thinking: false,
      fast: false,
      maxMode: false,
    })
  })

  it('parses -xhigh effort suffix', () => {
    const result = parseModelId('gpt-5.2-xhigh')
    expect(result).toEqual({
      base: 'gpt-5.2',
      effort: 'xhigh',
      thinking: false,
      fast: false,
      maxMode: false,
    })
  })

  it('parses effort + thinking + maxMode', () => {
    const result = parseModelId('claude-4.6-sonnet-high-thinking-max')
    expect(result).toEqual({
      base: 'claude-4.6-sonnet',
      effort: 'high',
      thinking: true,
      fast: false,
      maxMode: true,
    })
  })

  it('parses -fast only (no effort, no thinking)', () => {
    const result = parseModelId('gemini-3-flash-fast')
    expect(result).toEqual({
      base: 'gemini-3-flash',
      effort: null,
      thinking: false,
      fast: true,
      maxMode: false,
    })
  })

  it('parses -thinking only', () => {
    const result = parseModelId('gemini-3-flash-thinking')
    expect(result).toEqual({
      base: 'gemini-3-flash',
      effort: null,
      thinking: true,
      fast: false,
      maxMode: false,
    })
  })

  it('handles single-segment model name', () => {
    const result = parseModelId('composer')
    expect(result).toEqual({
      base: 'composer',
      effort: null,
      thinking: false,
      fast: false,
      maxMode: false,
    })
  })

  it('handles base name max with -fast suffix', () => {
    const result = parseModelId('gpt-5.1-codex-max-fast')
    expect(result).toEqual({
      base: 'gpt-5.1-codex-max',
      effort: null,
      thinking: false,
      fast: true,
      maxMode: false,
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

  it('handles xhigh and max coexistence — max wins for xhigh', () => {
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

  it('maps minimal to none if available', () => {
    const efforts = new Set<CursorEffort | 'default'>(['none', 'low', 'high'])
    const map = buildEffortMap(efforts)
    expect(map.minimal).toBe('none')
  })

  it('maps minimal to low if no none available', () => {
    const efforts = new Set<CursorEffort | 'default'>(['low', 'high'])
    const map = buildEffortMap(efforts)
    expect(map.minimal).toBe('low')
  })

  it('maps medium to empty string (default/no suffix) when only default', () => {
    const efforts = new Set<CursorEffort | 'default'>(['default', 'high'])
    const map = buildEffortMap(efforts)
    expect(map.medium).toBe('')
  })

  it('handles single-effort set', () => {
    const efforts = new Set<CursorEffort | 'default'>(['high'])
    const map = buildEffortMap(efforts)
    expect(map.minimal).toBe('high')
    expect(map.low).toBe('high')
    expect(map.medium).toBe('high')
    expect(map.high).toBe('high')
    expect(map.xhigh).toBe('high')
  })

  it('handles empty effort set — all map to empty string', () => {
    const efforts = new Set<CursorEffort | 'default'>()
    const map = buildEffortMap(efforts)
    expect(map.minimal).toBe('')
    expect(map.low).toBe('')
    expect(map.medium).toBe('')
    expect(map.high).toBe('')
    expect(map.xhigh).toBe('')
  })

  it('handles default-only set (no suffix models)', () => {
    const efforts = new Set<CursorEffort | 'default'>(['default'])
    const map = buildEffortMap(efforts)
    expect(map.medium).toBe('')
  })
})

// ---------------------------------------------------------------------------
// processModels
// ---------------------------------------------------------------------------

describe('processModels', () => {
  it('collapses multi-effort family into single entry', () => {
    const raw = [makeModel('gpt-5.4'), makeModel('gpt-5.4-low'), makeModel('gpt-5.4-medium'), makeModel('gpt-5.4-high')]
    const result = processModels(raw)

    // Should collapse to a single gpt-5.4 entry
    const gpt54 = result.models.filter((m) => m.id === 'gpt-5.4')
    expect(gpt54).toHaveLength(1)

    // Should have effort map
    const fKey = 'gpt-5.4|false|false'
    expect(result.effortMaps.has(fKey)).toBeTruthy()
  })

  it('keeps variant-different models separate', () => {
    const raw = [makeModel('gpt-5.4'), makeModel('gpt-5.4-fast'), makeModel('gpt-5.4-thinking')]
    const result = processModels(raw)

    // Should have 3 entries (base, fast, thinking are different variants)
    expect(result.models).toHaveLength(3)
    const ids = result.models.map((m) => m.id)
    expect(ids).toContain('gpt-5.4')
    expect(ids).toContain('gpt-5.4-fast')
    expect(ids).toContain('gpt-5.4-thinking')
  })

  it('collapses effort variants within the same variant group', () => {
    const raw = [makeModel('gpt-5.4-fast'), makeModel('gpt-5.4-low-fast'), makeModel('gpt-5.4-high-fast')]
    const result = processModels(raw)

    // Should collapse to one gpt-5.4-fast entry
    expect(result.models).toHaveLength(1)
    expect(result.models[0]?.id).toBe('gpt-5.4-fast')
  })

  it('tracks maxMode availability from raw models', () => {
    const raw = [makeModel('claude-4.6-opus'), makeModel('claude-4.6-opus-max', { supportsMaxMode: true })]
    const result = processModels(raw)

    const fKey = 'claude-4.6-opus|false|false'
    expect(result.families.get(fKey)?.hasMaxMode).toBeTruthy()
    expect(result.models[0]?.supportsMaxMode).toBeTruthy()
  })

  it('produces no effort map for single-default-effort family', () => {
    const raw = [makeModel('composer-2')]
    const result = processModels(raw)

    expect(result.models).toHaveLength(1)
    const fKey = 'composer-2|false|false'
    expect(result.effortMaps.has(fKey)).toBeFalsy()
  })

  it('produces effort map for single non-default effort family', () => {
    const raw = [makeModel('gpt-5.4-high')]
    const result = processModels(raw)

    const fKey = 'gpt-5.4|false|false'
    expect(result.effortMaps.has(fKey)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// resolveModelId
// ---------------------------------------------------------------------------

describe('resolveModelId', () => {
  function buildTestModelSet(): NormalizedModelSet {
    const raw = [
      makeModel('gpt-5.4'),
      makeModel('gpt-5.4-low'),
      makeModel('gpt-5.4-medium'),
      makeModel('gpt-5.4-high'),
      makeModel('gpt-5.4-fast'),
      makeModel('gpt-5.4-low-fast'),
      makeModel('gpt-5.4-high-fast'),
      makeModel('claude-4.6-opus'),
      makeModel('claude-4.6-opus-max'),
      makeModel('claude-4.6-opus-thinking'),
      makeModel('claude-4.6-opus-max-thinking'),
      makeModel('claude-4.6-opus-max-thinking-max'),
      makeModel('claude-4.6-opus-max', { supportsMaxMode: true }),
      makeModel('claude-4.6-opus-max-max', { supportsMaxMode: true }),
      makeModel('composer-2'),
    ]
    return processModels(raw)
  }

  it('reconstructs correct raw ID for medium effort', () => {
    const modelSet = buildTestModelSet()
    const result = resolveModelId('gpt-5.4', 'medium', false, modelSet)
    expect(result).toBe('gpt-5.4-medium')
  })

  it('reconstructs correct raw ID for high effort', () => {
    const modelSet = buildTestModelSet()
    const result = resolveModelId('gpt-5.4', 'high', false, modelSet)
    expect(result).toBe('gpt-5.4-high')
  })

  it('accepts provider-specific suffixes from thinkingLevelMap', () => {
    const modelSet = buildTestModelSet()
    const result = resolveModelId('claude-4.6-opus-thinking', 'max', true, modelSet)
    expect(result).toBe('claude-4.6-opus-max-thinking-max')
  })

  it('uses empty suffix for medium when default is available', () => {
    // Build a model set where default (no effort) is available
    const raw = [makeModel('gpt-5.4'), makeModel('gpt-5.4-high')]
    const modelSet = processModels(raw)
    const result = resolveModelId('gpt-5.4', 'medium', false, modelSet)
    // medium maps to 'default' (empty), so just base name
    expect(result).toBe('gpt-5.4')
  })

  it('appends maxMode when supported', () => {
    const modelSet = buildTestModelSet()
    const result = resolveModelId('claude-4.6-opus', null, true, modelSet)
    expect(result).toBe('claude-4.6-opus-max')
  })

  it('silently ignores maxMode when unsupported', () => {
    const modelSet = buildTestModelSet()
    const result = resolveModelId('composer-2', null, true, modelSet)
    expect(result).toBe('composer-2')
  })

  it('resolves with no effort and no maxMode', () => {
    const modelSet = buildTestModelSet()
    const result = resolveModelId('gpt-5.4', null, false, modelSet)
    expect(result).toBe('gpt-5.4')
  })

  it('resolves fast variant with effort', () => {
    const modelSet = buildTestModelSet()
    const result = resolveModelId('gpt-5.4-fast', 'high', false, modelSet)
    expect(result).toBe('gpt-5.4-high-fast')
  })

  it('resolves thinking variant with effort and maxMode', () => {
    const modelSet = buildTestModelSet()
    const result = resolveModelId('claude-4.6-opus-thinking', 'xhigh', true, modelSet)
    // xhigh maps to max for claude family, plus maxMode
    expect(result).toBe('claude-4.6-opus-max-thinking-max')
  })
})

// ---------------------------------------------------------------------------
// supportsReasoningModelId
// ---------------------------------------------------------------------------

describe('supportsReasoningModelId', () => {
  it('returns true for multi-effort family', () => {
    const raw = [makeModel('gpt-5.4'), makeModel('gpt-5.4-low'), makeModel('gpt-5.4-high')]
    const modelSet = processModels(raw)
    expect(supportsReasoningModelId('gpt-5.4', modelSet)).toBeTruthy()
  })

  it('returns false for single-default-effort family', () => {
    const raw = [makeModel('composer-2')]
    const modelSet = processModels(raw)
    expect(supportsReasoningModelId('composer-2', modelSet)).toBeFalsy()
  })

  it('returns true for single non-default effort', () => {
    const raw = [makeModel('gpt-5.4-high')]
    const modelSet = processModels(raw)
    expect(supportsReasoningModelId('gpt-5.4-high', modelSet)).toBeTruthy()
  })

  it('returns true when using normalized ID', () => {
    const raw = [makeModel('gpt-5.4'), makeModel('gpt-5.4-low'), makeModel('gpt-5.4-high')]
    const modelSet = processModels(raw)
    // Normalized ID is just 'gpt-5.4'
    expect(supportsReasoningModelId('gpt-5.4', modelSet)).toBeTruthy()
  })
})
