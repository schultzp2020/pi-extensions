#!/usr/bin/env node
/**
 * debug-log-timeline.mjs — Transform JSONL debug logs into human-readable timelines.
 *
 * Usage:
 *   node debug-log-timeline.mjs [logfile]
 *   cat cursor-debug.jsonl | node debug-log-timeline.mjs
 *
 * Options:
 *   --session <id>   Filter by session ID
 *   --since <iso>    Show events after this ISO 8601 timestamp
 *   --until <iso>    Show events before this ISO 8601 timestamp
 *   --help           Show this help message
 *
 * Node.js built-ins only — no external dependencies.
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

// ── Argument parsing ──

const args = process.argv.slice(2)
let inputFile = null
let filterSession = null
let filterSince = null
let filterUntil = null

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--session') {
    filterSession = args[++i]
  } else if (arg === '--since') {
    filterSince = new Date(args[++i])
  } else if (arg === '--until') {
    filterUntil = new Date(args[++i])
  } else if (arg === '--help' || arg === '-h') {
    console.log(
      `Usage: node debug-log-timeline.mjs [logfile] [--session <id>] [--since <iso>] [--until <iso>]

Reads JSONL debug logs from a file (first argument) or stdin.
Groups events by requestId and outputs a human-readable timeline.

Options:
  --session <id>   Filter by session ID
  --since <iso>    Show events after this ISO 8601 timestamp
  --until <iso>    Show events before this ISO 8601 timestamp
  --help           Show this help message`,
    )
    process.exit(0)
  } else if (!arg.startsWith('-')) {
    inputFile = arg
  }
}

// ── Read and parse ──

const inputStream = inputFile ? createReadStream(inputFile, 'utf8') : process.stdin

const rl = createInterface({ input: inputStream, crlfDelay: Infinity })

/** @type {Map<string, object[]>} requestId → events */
const byRequest = new Map()
/** @type {object[]} events without a requestId (lifecycle, etc.) */
const standalone = []

let totalLines = 0
let parseErrors = 0

for await (const line of rl) {
  if (!line.trim()) continue
  totalLines++

  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    parseErrors++
    continue
  }

  // Apply filters
  if (filterSession && entry.sessionId !== filterSession) continue
  if (filterSince && new Date(entry.timestamp) < filterSince) continue
  if (filterUntil && new Date(entry.timestamp) > filterUntil) continue

  const rid = entry.requestId
  if (!rid) {
    standalone.push(entry)
    continue
  }

  if (!byRequest.has(rid)) {
    byRequest.set(rid, [])
  }
  byRequest.get(rid).push(entry)
}

// ── Formatting helpers ──

function ts(isoStr) {
  return isoStr ? isoStr.replace('T', ' ').replace('Z', '') : '?'
}

function pad(str, len) {
  return String(str).padEnd(len)
}

function formatEvent(ev) {
  switch (ev.type) {
    case 'request_start':
      return `▶ REQUEST  model=${ev.model}  msgs=${ev.messageCount}  tools=${ev.toolsCount}`
    case 'request_end': {
      const dur = ev.durationMs != null ? `${ev.durationMs}ms` : '?'
      const err = ev.error ? `  ERROR: ${ev.error}` : ''
      return `◼ DONE     duration=${dur}${err}`
    }
    case 'session_create':
      return `+ SESSION  key=${ev.sessionKey}  conv=${ev.conversationKey}`
    case 'session_resume':
      return `↻ RESUME   key=${ev.sessionKey}`
    case 'checkpoint_commit':
      return `✓ CKPT     size=${ev.sizeBytes}B`
    case 'checkpoint_discard':
      return `✗ CKPT     reason=${ev.reason}`
    case 'retry':
      return `⟳ RETRY    attempt=${ev.attempt}  hint=${ev.hint}  delay=${ev.delayMs}ms`
    case 'tool_call':
      return `⚙ TOOL     name=${ev.toolName}  mode=${ev.mode}  result=${ev.resultType}`
    case 'bridge_open':
      return `⇡ BRIDGE   opened`
    case 'bridge_close': {
      const dur = ev.durationMs != null ? `${ev.durationMs}ms` : '?'
      return `⇣ BRIDGE   closed  reason=${ev.reason}  duration=${dur}`
    }
    case 'lifecycle':
      return `◉ LIFECYCLE  ${ev.event}`
    default:
      return `? ${ev.type}  ${JSON.stringify(ev)}`
  }
}

// ── Output timelines ──

console.log('═'.repeat(80))
console.log('  CURSOR DEBUG LOG TIMELINE')
console.log('═'.repeat(80))
console.log()

// Standalone events (lifecycle, etc.)
if (standalone.length > 0) {
  console.log('── Lifecycle Events ──')
  for (const ev of standalone) {
    console.log(`  ${ts(ev.timestamp)}  ${formatEvent(ev)}`)
  }
  console.log()
}

// Group by request
const requests = [...byRequest.entries()]

// Sort by first event timestamp within each request
requests.sort((a, b) => {
  const aTs = a[1][0]?.timestamp ?? ''
  const bTs = b[1][0]?.timestamp ?? ''
  return aTs.localeCompare(bTs)
})

let totalRequests = 0
let totalErrors = 0
let totalRetries = 0
let totalDurationMs = 0
let durationCount = 0

for (const [requestId, events] of requests) {
  totalRequests++

  console.log(`── Request ${requestId.slice(0, 8)}… ──`)

  // Sort events by timestamp within request
  events.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))

  for (const ev of events) {
    console.log(`  ${ts(ev.timestamp)}  ${formatEvent(ev)}`)

    // Aggregate stats
    if (ev.type === 'request_end') {
      if (ev.error) totalErrors++
      if (ev.durationMs != null) {
        totalDurationMs += ev.durationMs
        durationCount++
      }
    }
    if (ev.type === 'retry') totalRetries++
  }

  console.log()
}

// ── Summary ──

console.log('═'.repeat(80))
console.log('  SUMMARY')
console.log('═'.repeat(80))
console.log(`  Total lines read:   ${totalLines}`)
if (parseErrors > 0) {
  console.log(`  Parse errors:       ${parseErrors}`)
}
console.log(`  Requests:           ${totalRequests}`)
console.log(`  Errors:             ${totalErrors}`)
console.log(`  Retries:            ${totalRetries}`)
if (durationCount > 0) {
  console.log(`  Avg duration:       ${Math.round(totalDurationMs / durationCount)}ms`)
}
if (filterSession) {
  console.log(`  Session filter:     ${filterSession}`)
}
if (filterSince) {
  console.log(`  Since filter:       ${filterSince.toISOString()}`)
}
if (filterUntil) {
  console.log(`  Until filter:       ${filterUntil.toISOString()}`)
}
console.log()
