import { describe, expect, it } from 'vitest'

import type { OpenAIMessage } from './openai-messages.ts'
import { deriveConversationKey, deriveSessionKey } from './session-manager.ts'

describe('deriveSessionKey', () => {
  it('produces same key for same session ID regardless of message content', () => {
    const sessionId = 'test-session-id-abc123'
    const messages1: OpenAIMessage[] = [{ role: 'user', content: 'Hello, world!' }]
    const messages2: OpenAIMessage[] = [{ role: 'user', content: 'Completely different message after compaction' }]
    const messagesEmpty: OpenAIMessage[] = []

    const key1 = deriveSessionKey(sessionId, messages1)
    const key2 = deriveSessionKey(sessionId, messages2)
    const key3 = deriveSessionKey(sessionId, messagesEmpty)
    const key4 = deriveSessionKey(sessionId)

    expect(key1).toBe(key2)
    expect(key2).toBe(key3)
    expect(key3).toBe(key4)
  })

  it('produces different keys for different session IDs', () => {
    const key1 = deriveSessionKey('session-a')
    const key2 = deriveSessionKey('session-b')
    expect(key1).not.toBe(key2)
  })

  it('returns a 16-character hex string', () => {
    const key = deriveSessionKey('some-id')
    expect(key).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('deriveConversationKey', () => {
  it('produces same key for same session ID regardless of message content', () => {
    const sessionId = 'test-session-id-abc123'
    const messages1: OpenAIMessage[] = [{ role: 'user', content: 'Hello, world!' }]
    const messages2: OpenAIMessage[] = [{ role: 'user', content: 'Completely different message after compaction' }]

    const key1 = deriveConversationKey(sessionId, messages1)
    const key2 = deriveConversationKey(sessionId, messages2)
    const key3 = deriveConversationKey(sessionId)

    expect(key1).toBe(key2)
    expect(key2).toBe(key3)
  })

  it('produces different keys than deriveSessionKey for same input', () => {
    const sessionId = 'test-id'
    const sessionKey = deriveSessionKey(sessionId)
    const convKey = deriveConversationKey(sessionId)
    expect(sessionKey).not.toBe(convKey)
  })
})
