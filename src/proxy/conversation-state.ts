import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface StoredConversation {
  conversationId: string
  checkpoint: Uint8Array | null
  blobStore: Map<string, Uint8Array>
  lastAccessMs: number
  checkpointHistory: Map<string, Uint8Array>
  checkpointArchive: Map<string, Uint8Array>
}

export interface ConversationConfig {
  conversationDiskDir: string
}

interface DiskFormat {
  conversationId: string
  checkpoint: string | null
  blobStore: Record<string, string>
  checkpointHistory: Record<string, string>
  checkpointArchive: Record<string, string>
}

const cache = new Map<string, StoredConversation>()

function diskPath(convKey: string, config: ConversationConfig): string {
  return join(config.conversationDiskDir, `${convKey}.json`)
}

function encodeMap(map: Map<string, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of map) {
    out[k] = Buffer.from(v).toString('base64')
  }
  return out
}

function decodeMap(obj: Record<string, string> | undefined): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>()
  if (!obj) {
    return map
  }
  for (const [k, v] of Object.entries(obj)) {
    map.set(k, Uint8Array.from(Buffer.from(v, 'base64')))
  }
  return map
}

function createFreshConversation(): StoredConversation {
  return {
    conversationId: randomUUID(),
    checkpoint: null,
    blobStore: new Map(),
    lastAccessMs: Date.now(),
    checkpointHistory: new Map(),
    checkpointArchive: new Map(),
  }
}

function loadFromDisk(convKey: string, config: ConversationConfig): StoredConversation | null {
  const filePath = diskPath(convKey, config)
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as DiskFormat
    const stored: StoredConversation = {
      conversationId: data.conversationId,
      checkpoint: data.checkpoint ? Uint8Array.from(Buffer.from(data.checkpoint, 'base64')) : null,
      blobStore: decodeMap(data.blobStore),
      lastAccessMs: Date.now(),
      checkpointHistory: decodeMap(data.checkpointHistory),
      checkpointArchive: decodeMap(data.checkpointArchive),
    }
    return stored
  } catch {
    return null
  }
}

/**
 * Get a conversation from in-memory cache only. Returns undefined if not cached.
 */
export function getConversationState(convKey: string): StoredConversation | undefined {
  const stored = cache.get(convKey)
  if (stored) {
    stored.lastAccessMs = Date.now()
  }
  return stored
}

/**
 * Resolve a conversation by key: check cache first, then disk, then create fresh.
 * The result is always cached in memory.
 */
export function resolveConversationState(convKey: string, config: ConversationConfig): StoredConversation {
  const cached = cache.get(convKey)
  if (cached) {
    cached.lastAccessMs = Date.now()
    return cached
  }

  const fromDisk = loadFromDisk(convKey, config)
  if (fromDisk) {
    cache.set(convKey, fromDisk)
    return fromDisk
  }

  const fresh = createFreshConversation()
  cache.set(convKey, fresh)
  return fresh
}

/**
 * Persist conversation state to disk atomically (write to temp file, then rename).
 */
export function persistConversation(convKey: string, stored: StoredConversation, config: ConversationConfig): void {
  mkdirSync(config.conversationDiskDir, { recursive: true })

  const data: DiskFormat = {
    conversationId: stored.conversationId,
    checkpoint: stored.checkpoint ? Buffer.from(stored.checkpoint).toString('base64') : null,
    blobStore: encodeMap(stored.blobStore),
    checkpointHistory: encodeMap(stored.checkpointHistory),
    checkpointArchive: encodeMap(stored.checkpointArchive),
  }

  const filePath = diskPath(convKey, config)
  const tmpPath = `${filePath}.tmp.${randomUUID()}`
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmpPath, filePath)
}

/**
 * Remove a conversation from the in-memory cache.
 */
export function invalidateConversationState(convKey: string): void {
  cache.delete(convKey)
}
