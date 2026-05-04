/**
 * Session manager — tracks active CursorSession instances keyed by
 * session ID + conversation key.  Provides TTL-based eviction and
 * clean shutdown of all sessions.
 */
import { createHash } from 'node:crypto'

import type { CursorSession } from './cursor-session.ts'

interface ActiveSession {
  session: CursorSession
  lastAccessMs: number
}

const activeSessions = new Map<string, ActiveSession>()
const SESSION_TTL_MS = 30 * 60 * 1000 // 30 minutes

export function deriveSessionKey(sessionId: string): string {
  return createHash('sha256').update(`session:${sessionId}`).digest('hex').slice(0, 16)
}

export function deriveConversationKey(sessionId: string): string {
  return createHash('sha256').update(`conv:${sessionId}`).digest('hex').slice(0, 16)
}

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

export function evictStaleSessions(): void {
  const now = Date.now()
  for (const [key, entry] of activeSessions) {
    if (now - entry.lastAccessMs > SESSION_TTL_MS) {
      entry.session.close()
      activeSessions.delete(key)
    }
  }
}

/**
 * Close all active sessions for a given session ID and evict their state.
 * Derives the session key from the ID and removes the matching entry.
 */
export function cleanupSessionById(sessionId: string): void {
  const key = deriveSessionKey(sessionId)
  const entry = activeSessions.get(key)
  if (entry) {
    entry.session.cancel()
    activeSessions.delete(key)
  }
}

export function closeAllSessions(): void {
  for (const [, entry] of activeSessions) {
    entry.session.close()
  }
  activeSessions.clear()
}
