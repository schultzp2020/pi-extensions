/**
 * Structured JSONL debug logger for the Cursor proxy.
 *
 * Gated behind `PI_CURSOR_PROVIDER_DEBUG=1`. When disabled, all log
 * functions are zero-cost no-ops (function references point to empty stubs).
 *
 * Log entries are appended to `~/.pi/agent/cursor-debug.jsonl` by default.
 * Override the path via `PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE`.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ── Types ──

export type DebugEventType =
  | 'request_start'
  | 'request_end'
  | 'session_create'
  | 'session_resume'
  | 'checkpoint_commit'
  | 'checkpoint_discard'
  | 'retry'
  | 'tool_call'
  | 'bridge_open'
  | 'bridge_close'
  | 'lifecycle'

export interface DebugLogEntry {
  timestamp: string
  type: DebugEventType
  sessionId: string
  requestId: string
  [key: string]: unknown
}

// ── No-op stubs (used when debug is disabled) ──

/* eslint-disable @typescript-eslint/no-unused-vars */
const noop = (): void => {}
const noopStr = (): string => ''

// ── Logger implementation ──

let _enabled = false
let _logFilePath = ''
let _dirEnsured = false

function ensureDir(): void {
  if (_dirEnsured) {return}
  try {
    mkdirSync(dirname(_logFilePath), { recursive: true })
    _dirEnsured = true
  } catch {
    // best-effort
  }
}

function writeEntry(entry: DebugLogEntry): void {
  if (!_enabled) {return}
  ensureDir()
  try {
    appendFileSync(_logFilePath, `${JSON.stringify(entry)  }\n`)
  } catch {
    // best-effort — never crash the proxy for debug logging
  }
}

// ── Public API ──

/** Check if debug logging is enabled. */
export function isDebugEnabled(): boolean {
  return _enabled
}

/** Generate a per-request UUID. Returns empty string when disabled. */
export function debugRequestId(): string {
  if (!_enabled) {return ''}
  return crypto.randomUUID()
}

/** Log a new chat completion request. */
export function logRequestStart(
  sessionId: string,
  requestId: string,
  payload: { model: string; messageCount: number; toolsCount: number },
): void {
  if (!_enabled) {return}
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'request_start',
    sessionId,
    requestId,
    model: payload.model,
    messageCount: payload.messageCount,
    toolsCount: payload.toolsCount,
  })
}

/** Log a completed request. */
export function logRequestEnd(
  sessionId: string,
  requestId: string,
  payload: { durationMs: number; error?: string },
): void {
  if (!_enabled) {return}
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'request_end',
    sessionId,
    requestId,
    durationMs: payload.durationMs,
    ...(payload.error ? { error: payload.error } : {}),
  })
}

/** Log session creation. */
export function logSessionCreate(
  sessionId: string,
  requestId: string,
  payload: { sessionKey: string; conversationKey: string },
): void {
  if (!_enabled) {return}
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'session_create',
    sessionId,
    requestId,
    sessionKey: payload.sessionKey,
    conversationKey: payload.conversationKey,
  })
}

/** Log session reuse. */
export function logSessionResume(sessionId: string, requestId: string, payload: { sessionKey: string }): void {
  if (!_enabled) {return}
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'session_resume',
    sessionId,
    requestId,
    sessionKey: payload.sessionKey,
  })
}

/** Log checkpoint commit. */
export function logCheckpointCommit(sessionId: string, requestId: string, payload: { sizeBytes: number }): void {
  if (!_enabled) {return}
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'checkpoint_commit',
    sessionId,
    requestId,
    sizeBytes: payload.sizeBytes,
  })
}

/** Log checkpoint discard. */
export function logCheckpointDiscard(sessionId: string, requestId: string, payload: { reason: string }): void {
  if (!_enabled) {return}
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'checkpoint_discard',
    sessionId,
    requestId,
    reason: payload.reason,
  })
}

/** Log a retry attempt. */
export function logRetry(
  sessionId: string,
  requestId: string,
  payload: { attempt: number; hint: string; delayMs: number },
): void {
  if (!_enabled) {return}
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'retry',
    sessionId,
    requestId,
    attempt: payload.attempt,
    hint: payload.hint,
    delayMs: payload.delayMs,
  })
}

/** Log a tool call execution. */
export function logToolCall(
  sessionId: string,
  requestId: string,
  payload: { toolName: string; mode: string; resultType: string },
): void {
  if (!_enabled) {return}
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'tool_call',
    sessionId,
    requestId,
    toolName: payload.toolName,
    mode: payload.mode,
    resultType: payload.resultType,
  })
}

/** Log H2 stream opened to Cursor. */
export function logBridgeOpen(sessionId: string, requestId: string): void {
  if (!_enabled) {return}
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'bridge_open',
    sessionId,
    requestId,
  })
}

/** Log H2 stream closed. */
export function logBridgeClose(
  sessionId: string,
  requestId: string,
  payload: { reason: string; durationMs: number },
): void {
  if (!_enabled) {return}
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'bridge_close',
    sessionId,
    requestId,
    reason: payload.reason,
    durationMs: payload.durationMs,
  })
}

/** Log extension lifecycle event. */
export function logLifecycle(sessionId: string, requestId: string, payload: { event: string }): void {
  if (!_enabled) {return}
  writeEntry({
    timestamp: new Date().toISOString(),
    type: 'lifecycle',
    sessionId,
    requestId,
    event: payload.event,
  })
}

// ── Initialization ──

/**
 * Initialize the debug logger from environment variables.
 * Call once at startup. Safe to call multiple times (idempotent).
 */
export function initDebugLogger(): void {
  _enabled = process.env.PI_CURSOR_PROVIDER_DEBUG === '1'
  if (!_enabled) {return}

  _logFilePath =
    process.env.PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE ?? join(homedir(), '.pi', 'agent', 'cursor-debug.jsonl')
  _dirEnsured = false
}

// Auto-initialize on import so the env var is read once
initDebugLogger()
