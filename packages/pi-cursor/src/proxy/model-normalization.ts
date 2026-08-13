import type { CursorModel } from './models.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Effort suffixes found in Cursor legacy slug model IDs */
export type CursorEffort = 'minimal' | 'none' | 'low' | 'medium' | 'high' | 'extra-high' | 'xhigh' | 'max'

/** Result of parsing a legacy slug into its components */
export interface ParsedSlug {
  /** Base model name without any suffixes */
  base: string
  /** Effort level suffix if present */
  effort: CursorEffort | null
  /** Whether -thinking suffix was present */
  thinking: boolean
  /** Whether -fast suffix was present */
  fast: boolean
}

/** Per-model metadata extracted from legacy slugs */
export interface ModelMeta {
  /** Available effort levels for this model */
  efforts: Set<CursorEffort | 'default'>
  /** Whether this model has fast variants */
  supportsFast: boolean
  /** Whether this model has thinking variants */
  supportsThinking: boolean
}

/** The complete normalized model set */
export interface NormalizedModelSet {
  /** Deduplicated models for the /v1/models endpoint */
  models: CursorModel[]
  /** Per-model metadata keyed by model ID */
  modelMeta: Map<string, ModelMeta>
  /** Effort maps keyed by model ID */
  effortMaps: Map<string, Record<string, string>>
  /** Available efforts keyed by "(modelId)|(fast)|(thinking)" */
  variantEfforts: Map<string, Set<CursorEffort | 'default'>>
  /**
   * Slug resolution table: maps "(modelId)|(effort)|(fast)|(thinking)" to the
   * legacy slug that Cursor's server accepts.
   */
  slugLookup: Map<string, string>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EFFORT_SUFFIXES: ReadonlySet<string> = new Set([
  'minimal',
  'none',
  'low',
  'medium',
  'high',
  'extra-high',
  'xhigh',
  'max',
])

// ---------------------------------------------------------------------------
// parseSlug
// ---------------------------------------------------------------------------

/** Parse a legacy slug whose effort, thinking, and fast suffixes can appear in any order. */
export function parseSlug(slug: string): ParsedSlug {
  const segments = slug.split('-')
  let effort: CursorEffort | null = null
  let thinking = false
  let fast = false

  while (segments.length > 1) {
    const lastSegment = segments.at(-1) ?? ''
    if (lastSegment === 'fast') {
      fast = true
      segments.pop()
      continue
    }
    if (lastSegment === 'thinking') {
      thinking = true
      segments.pop()
      continue
    }
    if (effort === null && lastSegment === 'high' && segments.at(-2) === 'extra') {
      effort = 'extra-high'
      segments.splice(-2)
      continue
    }
    if (effort === null && EFFORT_SUFFIXES.has(lastSegment)) {
      effort = lastSegment as CursorEffort
      segments.pop()
      continue
    }
    break
  }

  return { base: segments.join('-'), effort, thinking, fast }
}

// ---------------------------------------------------------------------------
// buildEffortMap
// ---------------------------------------------------------------------------

/**
 * Map Pi's effort levels to the best available Cursor effort suffix.
 *
 * - minimal → minimal if available, then none, then low
 * - low → low if available, then none, then minimal
 * - medium → medium if available, else 'default' (no suffix)
 * - high → high if available, else highest lower effort
 * - xhigh → max if available, then xhigh, then extra-high, then high
 */
export function buildEffortMap(availableEfforts: Set<CursorEffort | 'default'>): Record<string, string> {
  const orderedEfforts: (CursorEffort | 'default')[] = [
    'minimal',
    'none',
    'low',
    'default',
    'medium',
    'high',
    'extra-high',
    'xhigh',
    'max',
  ]
  const available = orderedEfforts.filter((e) => availableEfforts.has(e))

  if (available.length === 0) {
    return { minimal: '', low: '', medium: '', high: '', xhigh: '' }
  }

  const lowest = available.at(0) ?? 'default'
  const highest = available.at(-1) ?? 'default'

  function pick(preferred: (CursorEffort | 'default')[], fallback: CursorEffort | 'default'): string {
    for (const p of preferred) {
      if (availableEfforts.has(p)) {
        return effortToSuffix(p)
      }
    }
    return effortToSuffix(fallback)
  }

  let highFallback = highest
  for (const candidate of available) {
    if (candidate !== 'extra-high' && candidate !== 'xhigh' && candidate !== 'max') {
      highFallback = candidate
    }
  }

  return {
    minimal: pick(['minimal', 'none', 'low'], lowest),
    low: pick(['low', 'none', 'minimal'], lowest),
    medium: pick(['medium', 'default'], lowest),
    high: pick(['high'], highFallback),
    xhigh: pick(['max', 'xhigh', 'extra-high', 'high'], highest),
  }
}

function effortToSuffix(effort: CursorEffort | 'default'): string {
  return effort === 'default' ? '' : effort
}

// ---------------------------------------------------------------------------
// processModels
// ---------------------------------------------------------------------------

/**
 * Build the normalized model set from discovered models.
 *
 * Parses each model's `legacySlugs` to determine available effort levels,
 * fast support, and thinking support. Builds effort maps and a slug
 * resolution table for request-time model ID reconstruction.
 */
export function processModels(rawModels: CursorModel[]): NormalizedModelSet {
  const modelMeta = new Map<string, ModelMeta>()
  const effortMaps = new Map<string, Record<string, string>>()
  const variantEfforts = new Map<string, Set<CursorEffort | 'default'>>()
  const slugLookup = new Map<string, string>()

  for (const model of rawModels) {
    const meta: ModelMeta = {
      efforts: new Set(['default']),
      supportsFast: false,
      supportsThinking: false,
    }

    if (model.legacySlugs) {
      for (const slug of model.legacySlugs) {
        const parsed = parseSlug(slug)

        if (parsed.effort) {
          meta.efforts.add(parsed.effort)
        }
        if (parsed.fast) {
          meta.supportsFast = true
        }
        if (parsed.thinking) {
          meta.supportsThinking = true
        }

        // Cursor lists preferred slugs before compatibility aliases.
        const effort = parsed.effort ?? 'default'
        const variantKey = `${model.id}|${String(parsed.fast)}|${String(parsed.thinking)}`
        const availableEfforts = variantEfforts.get(variantKey) ?? new Set<CursorEffort | 'default'>()
        availableEfforts.add(effort)
        variantEfforts.set(variantKey, availableEfforts)

        const key = `${model.id}|${effort}|${String(parsed.fast)}|${String(parsed.thinking)}`
        if (!slugLookup.has(key)) {
          slugLookup.set(key, slug)
        }
      }
    }

    modelMeta.set(model.id, meta)

    // Build effort map if model has effort variants
    const hasEffortVariants = meta.efforts.size > 1 || (meta.efforts.size === 1 && !meta.efforts.has('default'))
    if (hasEffortVariants) {
      effortMaps.set(model.id, buildEffortMap(meta.efforts))
    }
  }

  return { models: rawModels, modelMeta, effortMaps, variantEfforts, slugLookup }
}

// ---------------------------------------------------------------------------
// resolveModelId
// ---------------------------------------------------------------------------

/**
 * Resolve a normalized model ID + settings into the legacy slug that
 * Cursor's server accepts.
 *
 * Looks up the slug resolution table first. If no match, returns the
 * model ID as-is (works for models without legacy slugs like gemini).
 */
export function resolveModelId(
  modelId: string,
  effort: string | null,
  fast: boolean,
  thinking: boolean,
  modelSet: NormalizedModelSet,
): string {
  const meta = modelSet.modelMeta.get(modelId)
  if (!meta) {
    return modelId
  }

  // Silently ignore flags the model doesn't support.
  const effectiveFast = fast && meta.supportsFast
  const effectiveThinking = thinking && meta.supportsThinking
  const flagCandidates: [fast: boolean, thinking: boolean][] = [[effectiveFast, effectiveThinking]]

  // Preserve thinking when the exact fast variant is unavailable.
  if (effectiveFast) {
    flagCandidates.push([false, effectiveThinking])
  }
  if (effectiveThinking) {
    flagCandidates.push([effectiveFast, false])
  }
  if (effectiveFast && effectiveThinking) {
    flagCandidates.push([false, false])
  }

  for (const [candidateFast, candidateThinking] of flagCandidates) {
    const variantKey = `${modelId}|${String(candidateFast)}|${String(candidateThinking)}`
    const availableEfforts = modelSet.variantEfforts.get(variantKey)
    if (!availableEfforts) {
      continue
    }

    let resolvedEffort = 'default'
    if (effort) {
      const effortMap = buildEffortMap(availableEfforts)
      if (Object.hasOwn(effortMap, effort)) {
        const suffix = effortMap[effort]
        resolvedEffort = suffix || 'default'
      } else if (EFFORT_SUFFIXES.has(effort) && availableEfforts.has(effort as CursorEffort)) {
        resolvedEffort = effort
      } else {
        let piEffort: 'minimal' | 'xhigh' | null = null
        if (effort === 'none') {
          piEffort = 'minimal'
        } else if (effort === 'extra-high' || effort === 'max') {
          piEffort = 'xhigh'
        }
        if (piEffort) {
          const suffix = effortMap[piEffort]
          resolvedEffort = suffix || 'default'
        }
      }
    }

    const key = `${modelId}|${resolvedEffort}|${String(candidateFast)}|${String(candidateThinking)}`
    const slug = modelSet.slugLookup.get(key)
    if (slug) {
      return slug
    }
  }

  // The normalized model ID represents the default non-fast, non-thinking variant.
  return modelId
}
