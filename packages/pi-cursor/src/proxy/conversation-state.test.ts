import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, beforeEach, afterEach, expect } from 'vitest'

import { resolveConversationState, persistConversation, invalidateConversationState } from './conversation-state.ts'

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
