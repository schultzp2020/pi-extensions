import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, beforeEach, afterEach, expect } from 'vitest'

import {
  computeLineageFingerprint,
  invalidateConversationState,
  persistConversation,
  resolveConversationState,
  shouldDiscardCheckpoint,
  validateLineage,
  type StoredConversation,
} from './conversation-state.ts'

const TEST_DIR = join(tmpdir(), `pi-cursor-test-${process.pid}`)

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  invalidateConversationState('test-key')
})

describe('conversation-state', () => {
  it('creates a fresh conversation when none exists', () => {
    const stored = resolveConversationState('test-key', { conversationDiskDir: TEST_DIR })
    expect(stored.conversationId).toBeTruthy()
    expect(stored.checkpoint).toBeNull()
    expect(stored.blobStore.size).toBe(0)
  })

  it('persists and restores from disk', () => {
    const stored = resolveConversationState('test-key', { conversationDiskDir: TEST_DIR })
    stored.checkpoint = new Uint8Array([1, 2, 3])
    stored.blobStore.set('abc', new Uint8Array([4, 5, 6]))
    persistConversation('test-key', stored, { conversationDiskDir: TEST_DIR })

    // Clear in-memory cache
    invalidateConversationState('test-key')

    // Should restore from disk
    const restored = resolveConversationState('test-key', { conversationDiskDir: TEST_DIR })
    expect(Buffer.from(restored.checkpoint as Uint8Array)).toEqual(Buffer.from([1, 2, 3]))
    expect(Buffer.from(restored.blobStore.get('abc') as Uint8Array)).toEqual(Buffer.from([4, 5, 6]))
    expect(restored.conversationId).toBe(stored.conversationId)
  })

  it('returns same instance from in-memory cache', () => {
    const a = resolveConversationState('test-key', { conversationDiskDir: TEST_DIR })
    const b = resolveConversationState('test-key', { conversationDiskDir: TEST_DIR })
    expect(a).toBe(b) // same reference
  })
})

describe('computeLineageFingerprint', () => {
  it('produces deterministic output', () => {
    const turns = [
      { userText: 'hello', assistantText: 'hi', images: [] },
      { userText: 'how are you', assistantText: 'fine', images: [] },
    ]
    const fp1 = computeLineageFingerprint(turns)
    const fp2 = computeLineageFingerprint(turns)
    expect(fp1).toBe(fp2)
    expect(fp1).toMatch(/^[0-9a-f]{64}$/) // SHA256 hex
  })

  it('different user texts produce different fingerprints', () => {
    const turnsA = [{ userText: 'hello', assistantText: 'hi', images: [] }]
    const turnsB = [{ userText: 'goodbye', assistantText: 'hi', images: [] }]
    expect(computeLineageFingerprint(turnsA)).not.toBe(computeLineageFingerprint(turnsB))
  })

  it('same user texts with different assistant texts produce same fingerprint', () => {
    // Fingerprint only covers user text, so different assistant text does not matter
    const turnsA = [{ userText: 'hello', assistantText: 'response-A', images: [] }]
    const turnsB = [{ userText: 'hello', assistantText: 'response-B', images: [] }]
    expect(computeLineageFingerprint(turnsA)).toBe(computeLineageFingerprint(turnsB))
  })

  it('accepts minimal objects with just userText', () => {
    const turns = [{ userText: 'hello' }]
    const fp = computeLineageFingerprint(turns)
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('validateLineage', () => {
  function makeStored(overrides: Partial<StoredConversation> = {}): StoredConversation {
    return {
      conversationId: 'test',
      checkpoint: null,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
      checkpointHistory: new Map(),
      checkpointArchive: new Map(),
      lineageTurnCount: 0,
      lineageFingerprint: null,
      ...overrides,
    }
  }

  it('matching lineage passes', () => {
    const stored = makeStored({ lineageTurnCount: 3, lineageFingerprint: 'abc123' })
    expect(validateLineage(stored, { turnCount: 3, fingerprint: 'abc123' })).toBeTruthy()
  })

  it('turn count mismatch fails', () => {
    const stored = makeStored({ lineageTurnCount: 3, lineageFingerprint: 'abc123' })
    expect(validateLineage(stored, { turnCount: 4, fingerprint: 'abc123' })).toBeFalsy()
  })

  it('same-depth fork (same count, different fingerprint) fails', () => {
    const stored = makeStored({ lineageTurnCount: 3, lineageFingerprint: 'abc123' })
    expect(validateLineage(stored, { turnCount: 3, fingerprint: 'xyz789' })).toBeFalsy()
  })

  it('null stored fingerprint is always valid (fresh conversation)', () => {
    const stored = makeStored({ lineageTurnCount: 0, lineageFingerprint: null })
    expect(validateLineage(stored, { turnCount: 0, fingerprint: 'any-fp' })).toBeTruthy()
  })
})

describe('shouldDiscardCheckpoint', () => {
  function makeStored(overrides: Partial<StoredConversation> = {}): StoredConversation {
    return {
      conversationId: 'test',
      checkpoint: null,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
      checkpointHistory: new Map(),
      checkpointArchive: new Map(),
      lineageTurnCount: 0,
      lineageFingerprint: null,
      ...overrides,
    }
  }

  it('returns true on mismatch with non-null checkpoint', () => {
    const stored = makeStored({
      checkpoint: new Uint8Array([1, 2, 3]),
      lineageTurnCount: 3,
      lineageFingerprint: 'abc',
    })
    expect(shouldDiscardCheckpoint(stored, { turnCount: 4, fingerprint: 'abc' })).toBeTruthy()
  })

  it('returns false on mismatch with null checkpoint', () => {
    const stored = makeStored({
      checkpoint: null,
      lineageTurnCount: 3,
      lineageFingerprint: 'abc',
    })
    expect(shouldDiscardCheckpoint(stored, { turnCount: 4, fingerprint: 'abc' })).toBeFalsy()
  })

  it('returns false on valid lineage', () => {
    const stored = makeStored({
      checkpoint: new Uint8Array([1, 2, 3]),
      lineageTurnCount: 3,
      lineageFingerprint: 'abc',
    })
    expect(shouldDiscardCheckpoint(stored, { turnCount: 3, fingerprint: 'abc' })).toBeFalsy()
  })
})

describe('backward compatibility', () => {
  it('stored conversations without lineage fields load with defaults', () => {
    // Persist a conversation with lineage fields
    const stored = resolveConversationState('compat-key', { conversationDiskDir: TEST_DIR })
    stored.checkpoint = new Uint8Array([10, 20])
    persistConversation('compat-key', stored, { conversationDiskDir: TEST_DIR })

    // Manually strip lineage fields from the disk file to simulate old format
    const filePath = join(TEST_DIR, 'compat-key.json')
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>
    delete data.lineageTurnCount
    delete data.lineageFingerprint
    writeFileSync(filePath, JSON.stringify(data))

    // Clear cache and reload
    invalidateConversationState('compat-key')
    const restored = resolveConversationState('compat-key', { conversationDiskDir: TEST_DIR })

    expect(restored.lineageTurnCount).toBe(0)
    expect(restored.lineageFingerprint).toBeNull()
    expect(Buffer.from(restored.checkpoint as Uint8Array)).toEqual(Buffer.from([10, 20]))
  })

  it('persists and restores lineage fields', () => {
    const stored = resolveConversationState('lineage-key', { conversationDiskDir: TEST_DIR })
    stored.lineageTurnCount = 5
    stored.lineageFingerprint = 'deadbeef'
    stored.checkpoint = new Uint8Array([1])
    persistConversation('lineage-key', stored, { conversationDiskDir: TEST_DIR })

    invalidateConversationState('lineage-key')
    const restored = resolveConversationState('lineage-key', { conversationDiskDir: TEST_DIR })

    expect(restored.lineageTurnCount).toBe(5)
    expect(restored.lineageFingerprint).toBe('deadbeef')
  })
})
