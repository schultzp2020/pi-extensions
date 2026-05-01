/**
 * Session manager — tracks active CursorSession instances keyed by
 * session ID + conversation key.  Provides TTL-based eviction and
 * clean shutdown of all sessions.
 */
import { createHash } from 'node:crypto'

import type { CursorSession } from './cursor-session.ts'
import type { OpenAIMessage } from './openai-messages.ts'
import { textContent } from './openai-messages.ts'

// ── Types ──

interface ActiveSession {
  session: CursorSession
  lastAccessMs: number
}

// ── State ──

const activeSessions = new Map<string, ActiveSession>()
const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes

// ── Key derivation ──

export function deriveSessionKey(sessionId: string, messages: OpenAIMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === 'user')
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : ''
  return createHash('sha256')
    .update(`session:${sessionId}:${firstUserText.slice(0, 200)}`)
    .digest('hex')
    .slice(0, 16)
}

export function deriveConversationKey(sessionId: string, messages: OpenAIMessage[]): string {
  const firstUserMsg = messages.find((m) => m.role === 'user')
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : ''
  return createHash('sha256')
    .update(`conv:${sessionId}:${firstUserText.slice(0, 200)}`)
    .digest('hex')
    .slice(0, 16)
}

// ── Session CRUD ──

export function getActiveSession(key: string): CursorSession | undefined {
  const entry = activeSessions.get(key)
  if (entry) {
    entry.lastAccessMs = Date.now()
    return entry.session
  }
  return undefined
}

export function setActiveSession(key: string, session: CursorSession): void {
  activeSessions.set(key, { session, lastAccessMs: Date.now() })
}

export function removeActiveSession(key: string): void {
  const entry = activeSessions.get(key)
  if (entry) {
    entry.session.close()
    activeSessions.delete(key)
  }
}

// ── Lifecycle ──

export function evictStaleSessions(): void {
  const now = Date.now()
  for (const [key, entry] of activeSessions) {
    if (now - entry.lastAccessMs > SESSION_TTL_MS) {
      entry.session.close()
      activeSessions.delete(key)
    }
  }
}

export function closeAllSessions(): void {
  for (const [, entry] of activeSessions) {
    entry.session.close()
  }
  activeSessions.clear()
}
