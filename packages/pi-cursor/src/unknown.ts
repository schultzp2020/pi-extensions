/**
 * Typed reads at `unknown` / JSON trust boundaries.
 *
 * Keep casts and narrowing for external data here so TypeScript / type-aware
 * lint upgrades change one module instead of fanning out across call sites.
 */

export type JsonPrimitive = string | number | boolean | null
export interface JsonObject {
  [key: string]: JsonValue
}
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getOwnNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const field = value[key]
  return typeof field === 'number' ? field : undefined
}

export function getOwnString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

/** Recursively accept JSON-shaped values; reject functions, undefined, symbols, etc. */
export function asJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = []
    for (const item of value) {
      const parsed = asJsonValue(item)
      if (parsed === undefined) {
        return undefined
      }
      items.push(parsed)
    }
    return items
  }
  if (!isRecord(value)) {
    return undefined
  }
  const obj: JsonObject = {}
  for (const [key, nested] of Object.entries(value)) {
    if (nested === undefined) {
      continue
    }
    const parsed = asJsonValue(nested)
    if (parsed === undefined) {
      return undefined
    }
    obj[key] = parsed
  }
  return obj
}

/** Get a map entry, creating and storing it when missing (avoids non-null casts after `set`). */
export function mapEntry<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key)
  if (existing !== undefined) {
    return existing
  }
  const created = create()
  map.set(key, created)
  return created
}
