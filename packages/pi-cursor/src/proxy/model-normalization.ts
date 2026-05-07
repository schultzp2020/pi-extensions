import type { CursorModel } from './models.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Effort suffixes that Cursor uses on model IDs */
export type CursorEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Pi's reasoning-effort levels */
// fallow-ignore-next-line unused-type
export type PiEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** Result of parsing a raw Cursor model ID into its components */
export interface ParsedModelId {
  /** Base model name without any suffixes (e.g. "claude-4.6-opus") */
  base: string
  /** Effort level suffix if present (e.g. "high", "max") */
  effort: CursorEffort | null
  /** Whether -thinking suffix was present */
  thinking: boolean
  /** Whether -fast suffix was present */
  fast: boolean
  /** Whether trailing -max (maxMode flag) was present */
  maxMode: boolean
}

/** Metadata about a model family (all variants sharing a base name) */
export interface FamilyMeta {
  /** All effort suffixes seen for this family+variant */
  efforts: Set<CursorEffort | 'default'>
  /** Whether the family has a maxMode variant (trailing -max) */
  hasMaxMode: boolean
  /** One representative CursorModel from this family (for metadata) */
  representative: CursorModel
}

/** The complete normalized model set returned by processModels */
export interface NormalizedModelSet {
  /** Deduplicated models for the /v1/models endpoint */
  models: CursorModel[]
  /** Per-family metadata keyed by "base|thinking|fast" */
  families: Map<string, FamilyMeta>
  /** Effort maps keyed by "base|thinking|fast" */
  effortMaps: Map<string, Record<string, string>>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EFFORT_SUFFIXES: ReadonlySet<string> = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])

// Known base model names where `-max` is part of the identity, not a maxMode flag.
// These models would be misparsed if `-max` were stripped as maxMode.
const BASE_NAME_MAX_MODELS: ReadonlySet<string> = new Set(['gpt-5.1-codex-max'])

// ---------------------------------------------------------------------------
// parseModelId
// ---------------------------------------------------------------------------

/**
 * Parse a raw Cursor model ID by stripping suffixes in order:
 *
 * 1. Strip trailing `-max` → maxMode flag (NOT effort)
 * 2. Strip `-fast` → speed variant
 * 3. Strip `-thinking` → thinking variant
 * 4. Parse effort from last remaining segment
 * 5. Remaining segments → base name
 *
 * Handles triple-max correctly:
 *   `claude-4.6-opus-max-thinking-fast-max`
 *   → base "claude-4.6-opus", effort "max", thinking true, fast true, maxMode true
 *
 * Handles base name max:
 *   `gpt-5.1-codex-max` → base "gpt-5.1-codex-max", effort null
 */
export function parseModelId(rawId: string): ParsedModelId {
  let remaining = rawId

  // 1. Strip trailing -max → maxMode flag
  //    But first check if the raw ID (or what remains after stripping) is a
  //    known base-name-max model where "-max" is part of the identity.
  let maxMode = false
  if (remaining.endsWith('-max')) {
    // Don't strip if the full string is a known base-name-max model
    if (BASE_NAME_MAX_MODELS.has(remaining)) {
      // -max is part of the base name, not maxMode
    } else {
      const withoutMax = remaining.slice(0, -4)
      if (withoutMax.length > 0) {
        maxMode = true
        remaining = withoutMax
      }
    }
  }

  // 2. Strip -fast
  let fast = false
  if (remaining.endsWith('-fast')) {
    fast = true
    remaining = remaining.slice(0, -5)
  }

  // 3. Strip -thinking
  let thinking = false
  if (remaining.endsWith('-thinking')) {
    thinking = true
    remaining = remaining.slice(0, -9)
  }

  // 4. Parse effort from last remaining segment
  let effort: CursorEffort | null = null
  const segments = remaining.split('-')

  if (segments.length > 1) {
    const lastSegment = segments.at(-1) ?? ''
    if (EFFORT_SUFFIXES.has(lastSegment)) {
      // Check if the full remaining string is a known base name that ends with
      // this "effort" segment (e.g. "gpt-5.1-codex-max")
      if (!BASE_NAME_MAX_MODELS.has(remaining)) {
        effort = lastSegment as CursorEffort
        segments.pop()
        remaining = segments.join('-')
      }
    }
  }

  return {
    base: remaining,
    effort,
    thinking,
    fast,
    maxMode,
  }
}

// ---------------------------------------------------------------------------
// Variant key helpers
// ---------------------------------------------------------------------------

function variantKey(thinking: boolean, fast: boolean): string {
  return `${String(thinking)}|${String(fast)}`
}

export function familyKey(base: string, thinking: boolean, fast: boolean): string {
  return `${base}|${variantKey(thinking, fast)}`
}

// ---------------------------------------------------------------------------
// buildEffortMap
// ---------------------------------------------------------------------------

/**
 * Map Pi's effort levels to the best available Cursor effort suffix.
 *
 * - minimal → none if available, else low, else lowest available
 * - low → low if available, else none, else lowest available
 * - medium → medium if available, else 'default' (no suffix)
 * - high → high if available, else highest below xhigh
 * - xhigh → max if available, else xhigh, else high
 *
 * When xhigh and max coexist (e.g. gpt-5.2 family), max is higher.
 */
export function buildEffortMap(availableEfforts: Set<CursorEffort | 'default'>): Record<string, string> {
  const map: Record<string, string> = {}

  // Order from lowest to highest
  const orderedEfforts: (CursorEffort | 'default')[] = ['none', 'low', 'default', 'medium', 'high', 'xhigh', 'max']

  // Filter to only available efforts
  const available = orderedEfforts.filter((e) => availableEfforts.has(e))

  if (available.length === 0) {
    // No efforts available - map everything to default (no suffix)
    return {
      minimal: '',
      low: '',
      medium: '',
      high: '',
      xhigh: '',
    }
  }

  // Safe: we already returned early if available.length === 0
  const lowest = available.at(0) ?? 'default'
  const highest = available.at(-1) ?? 'default'

  // Helper: find best match or fallback
  function pick(preferred: (CursorEffort | 'default')[], fallback: CursorEffort | 'default'): string {
    for (const p of preferred) {
      if (availableEfforts.has(p)) {
        return effortToSuffix(p)
      }
    }
    return effortToSuffix(fallback)
  }

  // minimal → none, low, then lowest
  map.minimal = pick(['none', 'low'], lowest)

  // low → low, none, then lowest
  map.low = pick(['low', 'none'], lowest)

  // medium → medium, default (no suffix), then closest available
  map.medium = pick(['medium', 'default'], lowest)

  // high → high, then closest available below xhigh level
  const highFallback: CursorEffort | 'default' = highest === 'max' || highest === 'xhigh' ? 'high' : highest
  map.high = pick(['high'], highFallback)

  // xhigh → max, xhigh, high, then highest available
  map.xhigh = pick(['max', 'xhigh', 'high'], highest)

  return map
}

/**
 * Convert an effort level to the suffix string used in model IDs.
 * 'default' means no suffix (empty string).
 */
function effortToSuffix(effort: CursorEffort | 'default'): string {
  return effort === 'default' ? '' : effort
}

// ---------------------------------------------------------------------------
// processModels
// ---------------------------------------------------------------------------

/**
 * Group raw models by (base, variant) where variant = fast/thinking combo.
 * Collapse groups with multiple effort levels into single entries with
 * supportsReasoningEffort: true. Build effort maps per family.
 */
export function processModels(rawModels: CursorModel[]): NormalizedModelSet {
  const families = new Map<string, FamilyMeta>()

  // First pass: group models by family
  for (const model of rawModels) {
    const parsed = parseModelId(model.id)
    const fKey = familyKey(parsed.base, parsed.thinking, parsed.fast)

    let family = families.get(fKey)
    if (!family) {
      family = {
        efforts: new Set(),
        hasMaxMode: false,
        representative: model,
      }
      families.set(fKey, family)
    }

    // Track the effort level
    if (parsed.effort !== null) {
      family.efforts.add(parsed.effort)
    } else {
      family.efforts.add('default')
    }

    // Track maxMode availability
    if (parsed.maxMode) {
      family.hasMaxMode = true
    }

    // Prefer the default-effort variant as representative (most "base" model)
    if (parsed.effort === null && !parsed.maxMode) {
      family.representative = model
    }
  }

  // Second pass: build deduplicated model list and effort maps
  const models: CursorModel[] = []
  const effortMaps = new Map<string, Record<string, string>>()

  for (const [fKey, family] of families) {
    const rep = family.representative
    const parsed = parseModelId(rep.id)

    // Build the normalized model ID: base + variant suffixes (no effort, no maxMode)
    let normalizedId = parsed.base
    if (parsed.thinking) {
      normalizedId += '-thinking'
    }
    if (parsed.fast) {
      normalizedId += '-fast'
    }

    // For families with multiple effort levels (or a single non-default effort),
    // mark as supporting reasoning effort
    const hasMultipleEfforts = family.efforts.size > 1
    const hasSingleNonDefault = family.efforts.size === 1 && !family.efforts.has('default')

    const supportsReasoningEffort = hasMultipleEfforts || hasSingleNonDefault

    // Build effort map for this family
    if (supportsReasoningEffort) {
      effortMaps.set(fKey, buildEffortMap(family.efforts))
    }

    // Build the pretty name from normalized ID
    const name = rep.name || normalizedId

    models.push({
      id: normalizedId,
      name,
      reasoning: rep.reasoning,
      contextWindow: rep.contextWindow,
      maxTokens: rep.maxTokens,
      supportsImages: rep.supportsImages,
      supportsMaxMode: family.hasMaxMode,
    })
  }

  return { models, families, effortMaps }
}

// ---------------------------------------------------------------------------
// resolveModelId
// ---------------------------------------------------------------------------

/**
 * Reconstruct the final Cursor model ID at request time.
 *
 * Takes a normalized model ID + effort setting + maxMode toggle and produces
 * the raw Cursor model ID: base + effort suffix + variant suffixes + maxMode suffix.
 *
 * Silently skips maxMode if the family has no max variant.
 */
export function resolveModelId(
  normalizedId: string,
  effort: string | null,
  maxMode: boolean,
  modelSet: NormalizedModelSet,
): string {
  // Parse the normalized ID to extract base and variant info
  const parsed = parseModelId(normalizedId)

  const fKey = familyKey(parsed.base, parsed.thinking, parsed.fast)
  const family = modelSet.families.get(fKey)

  // Start with base
  let result = parsed.base

  // Add effort suffix if provided and the family supports it
  if (effort) {
    const effortMap = modelSet.effortMaps.get(fKey)
    if (effortMap) {
      // Accept both Pi thinking levels and the provider-specific values Pi core
      // now sends from model.thinkingLevelMap.
      if (Object.hasOwn(effortMap, effort)) {
        const cursorSuffix = effortMap[effort]
        if (cursorSuffix) {
          result += `-${cursorSuffix}`
        }
        // empty string means no suffix (default effort)
      } else if (EFFORT_SUFFIXES.has(effort)) {
        result += `-${effort}`
      }
    } else if (EFFORT_SUFFIXES.has(effort)) {
      // No effort map — if a raw effort string was passed, append it directly
      result += `-${effort}`
    }
  }

  // Add variant suffixes
  if (parsed.thinking) {
    result += '-thinking'
  }
  if (parsed.fast) {
    result += '-fast'
  }

  // Add maxMode suffix (only if family supports it)
  if (maxMode && family?.hasMaxMode) {
    result += '-max'
  }

  return result
}

// ---------------------------------------------------------------------------
// supportsReasoningModelId
// ---------------------------------------------------------------------------

/**
 * Check if a given raw or normalized model ID supports reasoning effort
 * (i.e., has multiple effort variants in its family).
 */
export function supportsReasoningModelId(rawId: string, modelSet: NormalizedModelSet): boolean {
  const parsed = parseModelId(rawId)
  const fKey = familyKey(parsed.base, parsed.thinking, parsed.fast)
  return modelSet.effortMaps.has(fKey)
}
