import { describe, expect, it } from 'vitest'

import { deriveConversationKey, deriveSessionKey } from './session-manager.ts'

describe('deriveSessionKey', () => {
  it('produces same key for same session ID', () => {
    const sessionId = 'test-session-id-abc123'

    const key1 = deriveSessionKey(sessionId)
    const key2 = deriveSessionKey(sessionId)

    expect(key1).toBe(key2)
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
  it('produces same key for same session ID', () => {
    const sessionId = 'test-session-id-abc123'

    const key1 = deriveConversationKey(sessionId)
    const key2 = deriveConversationKey(sessionId)

    expect(key1).toBe(key2)
  })

  it('produces different keys than deriveSessionKey for same input', () => {
    const sessionId = 'test-id'
    const sessionKey = deriveSessionKey(sessionId)
    const convKey = deriveConversationKey(sessionId)
    expect(sessionKey).not.toBe(convKey)
  })
})
