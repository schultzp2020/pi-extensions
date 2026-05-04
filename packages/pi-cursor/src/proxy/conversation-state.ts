import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ParsedConversationTurn } from './openai-messages.ts'

/** Maximum number of blobs retained per conversation. LRU-evicted on overflow. */
const MAX_BLOB_COUNT = 128

export interface StoredConversation {
  conversationId: string
  checkpoint: Uint8Array | null
  blobStore: Map<string, Uint8Array>
  lastAccessMs: number
  checkpointHistory: Map<string, Uint8Array>
  checkpointArchive: Map<string, Uint8Array>
  lineageTurnCount: number
  lineageFingerprint: string | null
}

export interface LineageMetadata {
  turnCount: number
  fingerprint: string
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
  lineageTurnCount?: number
  lineageFingerprint?: string | null
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
    lineageTurnCount: 0,
    lineageFingerprint: null,
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
      lineageTurnCount: data.lineageTurnCount ?? 0,
      lineageFingerprint: data.lineageFingerprint ?? null,
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
  mkdirSync(config.conversationDiskDir, { recursive: true, mode: 0o700 })

  const data: DiskFormat = {
    conversationId: stored.conversationId,
    checkpoint: stored.checkpoint ? Buffer.from(stored.checkpoint).toString('base64') : null,
    blobStore: encodeMap(stored.blobStore),
    checkpointHistory: encodeMap(stored.checkpointHistory),
    checkpointArchive: encodeMap(stored.checkpointArchive),
    lineageTurnCount: stored.lineageTurnCount,
    lineageFingerprint: stored.lineageFingerprint,
  }

  const filePath = diskPath(convKey, config)
  const tmpPath = `${filePath}.tmp.${randomUUID()}`
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmpPath, filePath)
}

/**
 * Compute a SHA256 fingerprint from the completed conversation turns.
 * The fingerprint covers only user text of each turn in order, so that
 * it can be computed after turn completion without capturing the streamed
 * assistant response text.  Same-depth forks with different user messages
 * are detected; same-message re-rolls are exceedingly rare and tolerated.
 */
export function computeLineageFingerprint(turns: Pick<ParsedConversationTurn, 'userText'>[]): string {
  const hash = createHash('sha256')
  for (const turn of turns) {
    hash.update(turn.userText)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Check whether the stored lineage matches the incoming lineage.
 * Returns false if turn count or fingerprint mismatch.
 */
export function validateLineage(stored: StoredConversation, incoming: LineageMetadata): boolean {
  if (stored.lineageTurnCount !== incoming.turnCount) {
    return false
  }
  // Fresh conversations (no fingerprint stored yet) are always valid
  if (stored.lineageFingerprint === null) {
    return true
  }
  return stored.lineageFingerprint === incoming.fingerprint
}

/**
 * Discard checkpoint and history but preserve blobStore.
 * Use on lineage mismatch (compaction, fork, branch switch) so that
 * Cursor can still GetBlob for previously-stored data after a fresh rebuild.
 */
export function discardCheckpoint(stored: StoredConversation): void {
  stored.checkpoint = null
  stored.checkpointHistory.clear()
  stored.checkpointArchive.clear()
}

/**
 * Evict oldest blobs when the store exceeds MAX_BLOB_COUNT.
 * Map iteration order is insertion-order, so deleting from the front
 * evicts the oldest entries first (LRU approximation).
 */
export function pruneBlobs(blobStore: Map<string, Uint8Array>): number {
  const excess = blobStore.size - MAX_BLOB_COUNT
  if (excess <= 0) {
    return 0
  }
  let evicted = 0
  for (const key of blobStore.keys()) {
    if (evicted >= excess) {
      break
    }
    blobStore.delete(key)
    evicted++
  }
  return evicted
}

/**
 * Remove a conversation from the in-memory cache.
 */
export function invalidateConversationState(convKey: string): void {
  cache.delete(convKey)
}

const CONVERSATION_TTL_MS = 30 * 60 * 1000

/** Evicts conversations not accessed within the TTL. Returns the number evicted. */
export function evictStaleConversations(): number {
  const now = Date.now()
  let evicted = 0
  for (const [key, stored] of cache) {
    if (now - stored.lastAccessMs > CONVERSATION_TTL_MS) {
      cache.delete(key)
      evicted++
    }
  }
  return evicted
}
