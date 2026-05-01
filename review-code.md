# Code Review: pi-cursor

**Reviewer:** Automated code review subagent  
**Date:** 2026-05-01  
**Scope:** All source files in `src/` excluding `src/proto/` (vendored/generated)  
**Tests:** All 54 tests pass (7 test files).

---

## Summary

The codebase is well-structured, cleanly layered, and demonstrates solid engineering for a protocol bridge of this complexity. The Connect protocol framing, batch state machine, and conversation persistence are all carefully implemented. There are no critical blockers, but several high- and medium-severity issues that should be addressed — particularly around command injection, missing JSON parse guards, unrecoverable event queue states, and conversation state memory leaks.

---

## Critical

*None.*

---

## High

### H1. Command injection via `fetchArgs` URL
**File:** `src/proxy/cursor-messages.ts:221-226`  
**Category:** Security

The `fetchArgs` handler interpolates a URL directly into a shell command with only single-quote wrapping, but does **not** sanitize the URL for shell metacharacters:

```typescript
decodedArgs: JSON.stringify({ command: `curl -sL '${url}'`, description: `Fetch ${url}` }),
```

A malicious URL like `http://example.com'; rm -rf / #` would break out of the single quotes. The `deleteArgs` handler (line 175) correctly sanitizes with `.replaceAll("'", "'\\''")` and NUL stripping, but `fetchArgs` does not.

**Fix:** Apply the same sanitization to `url`, or better yet use an array-based command to avoid shell interpretation entirely.

---

### H2. Missing `try/catch` on `JSON.parse` in internal API heartbeat and token endpoints
**File:** `src/proxy/internal-api.ts:94, 106`  
**Category:** Robustness / Error handling

Both the heartbeat and token endpoints call `JSON.parse(await readBody(req))` with no try/catch. Malformed JSON from any client crashes the request handler and sends an unhandled rejection up, potentially crashing the proxy.

```typescript
// Line 94 — heartbeat
const body = JSON.parse(await readBody(req)) as { sessionId?: string }

// Line 106 — token
const body = JSON.parse(await readBody(req)) as { access?: string }
```

The chat completion handler in `main.ts:270` correctly wraps its parse in try/catch. These two do not.

**Fix:** Wrap in try/catch and return a 400 JSON error response.

---

### H3. `EventQueue.next()` creates unresolvable promises on session close
**File:** `src/proxy/event-queue.ts:45-49`, `src/proxy/cursor-session.ts`  
**Category:** Resource leak / Correctness

When a consumer calls `next()` and the queue is empty, a Promise is created that waits for a `push()`. If the session closes without pushing a final event (e.g., due to the `onOverflow` path closing the session), the `pumpSession` loop in `openai-stream.ts` will hang forever on `await session.next()`.

The `pushForce` on the `done` event (cursor-session.ts:628) handles the normal case, but there is a race: if `onOverflow` fires and calls `close()` (cursor-session.ts:311-313), the `pushDone` inside `close()` is NOT called — `close()` only clears timers and closes transport, it doesn't push a done event. The `done` event is pushed from the `finish()` method, but `onOverflow` calls `close()`, not `finish()`.

**Evidence:** `close()` at line 379 sets `_alive = false`, clears timers, closes transport — but never calls `pushDone`. The `finish()` method at line 607 does call `pushDone`, but is only invoked by H2 events, not by the overflow callback.

**Fix:** The overflow callback should call `this.finish(CLOSE_ERR)` instead of (or in addition to) `this.close()`, or `close()` should call `pushDone` if not yet sent.

---

### H4. Conversation state module-level cache never evicted
**File:** `src/proxy/conversation-state.ts` (entire module)  
**Category:** Resource leak

The `cache` Map (line 16) grows unboundedly. `resolveConversationState` adds entries but there is no TTL eviction. The plan mentions `evictStaleConversations()` but it was never implemented. The `invalidateConversationState` export exists but is only called in tests.

For long-running proxy processes with many conversation keys, this accumulates indefinitely. Each entry contains blob stores (potentially large binary data), making this a meaningful memory leak.

**Fix:** Implement `evictStaleConversations()` with TTL-based cleanup and call it from the same 60-second eviction timer in `main.ts:523` that already calls `evictStaleSessions()`.

---

## Medium

### M1. `pumpAndFinalize` doesn't handle `retry` outcome
**File:** `src/proxy/main.ts:391-413`  
**Category:** Correctness

`pumpSession` can return `{ outcome: 'retry', ... }`, but `pumpAndFinalize` only has branches for `batchReady` and `else` (which covers both `done` and `retry`). The retry case falls into the same code path as `done`, which closes the session and persists state — but doesn't actually retry. The SSE stream is closed with no stop chunk or error indicator sent.

The `pumpSession` function explicitly returns without writing stop/DONE for retry hints (openai-stream.ts:215), expecting the caller to create a new session and call pumpSession again. `pumpAndFinalize` doesn't do this.

**Fix:** Add retry logic in `pumpAndFinalize` or at minimum surface the error to the client as a final SSE chunk before closing.

---

### M2. `deriveSessionKey` and `deriveConversationKey` are nearly identical
**File:** `src/proxy/session-manager.ts:20-34`  
**Category:** Correctness / Subtle bug risk

Both functions hash a string derived from `sessionId` + first user message text. The only difference is the prefix `session:` vs `conv:`. This means:
- A conversation is identified solely by the first user message (first 200 chars). Subsequent messages don't affect the key.
- Two completely different conversations that happen to start with the same first user message will collide.

This is a design tradeoff, not a bug per se, but it can cause incorrect conversation state sharing when a user starts multiple conversations with similar opening messages.

---

### M3. Non-streaming response doesn't handle tool calls gracefully
**File:** `src/proxy/openai-stream.ts:285-290`  
**Category:** API contract

When `stream: false`, `collectNonStreamingResponse` returns a 502 error if any `toolCall` or `batchReady` event arrives. However, the OpenAI API spec allows non-streaming responses with `tool_calls` in the response message. The current implementation rejects these rather than collecting them into the response object.

This means `stream: false` cannot work with any model that decides to use tools.

---

### M4. `configureInternalApi` called twice in `main.ts` — second call overwrites `onModelsRefreshed`
**File:** `src/proxy/main.ts:460-467, 475-483`  
**Category:** Correctness

`configureInternalApi` is called first at line 460 (before model discovery) and again at line 475 (after). The second call correctly sets models but redundantly re-creates the shutdown callback. More importantly, both calls set `onModelsRefreshed` to `null` (via the default value), since neither call passes `onModelsRefreshed`. This is currently harmless since nobody reads that callback, but the double-configure pattern is fragile.

**Fix:** Call once after model discovery, or have a separate `updateModels` method.

---

### M5. `readBody` has no size limit — potential DoS
**File:** `src/proxy/main.ts:82-91`, `src/proxy/internal-api.ts:75-83`  
**Category:** Robustness / Security

Both `readBody` implementations read the entire request body into memory with no size limit. A client could send a multi-gigabyte body and crash the proxy via OOM.

**Fix:** Add a maximum body size (e.g., 10 MB) and reject with 413 if exceeded.

---

### M6. `getTokenExpiry` base64 decode uses `atob` with incorrect URL-safe reversal
**File:** `src/auth.ts:89`  
**Category:** Correctness

```typescript
const decoded: unknown = JSON.parse(atob(parts[1].replaceAll('-', '+').replaceAll('_', '/')))
```

The `atob()` function expects standard base64 and the code reverses URL-safe characters. However, JWT payloads have no padding by spec, and `atob()` is lenient about missing padding on most runtimes. This works in practice but the correct approach is `Buffer.from(parts[1], 'base64url').toString()` in Node.js, which is more robust and avoids the replaceAll dance.

---

### M7. `WriteResultSchema` uses raw `byteLength` instead of the actual written size
**File:** `src/proxy/cursor-session.ts:208`  
**Category:** Correctness

```typescript
fileSize: bytes.byteLength,
```

This measures the size of the _tool result content_ string, not the actual file that was written. The Pi `write` tool returns a confirmation message, not the file contents. The `fileSize` field reported to Cursor will be incorrect.

---

### M8. H2 session not properly cleaned up on spawn failure
**File:** `src/proxy/cursor-session.ts:394-413`  
**Category:** Resource leak

If `h2Connect` succeeds but `session.request(headers)` throws (e.g., invalid headers), the H2 session is left open because the error path in `this.h2Stream.on('error')` calls `this.closeTransport()` which tries to close both, but `this.h2Stream` was never assigned. The definite assignment assertion (`!`) hides this — the field is `undefined` when `close()` is called on it, which would throw.

---

## Low

### L1. `flags` extracted via array indexing has inconsistent typing
**File:** `src/proxy/connect-protocol.ts:26`  
**Category:** Code quality

```typescript
const [flags] = pending
```

This is fine for Buffer (returns `number`), but the destructuring style is unusual for this pattern. The earlier version in the plan uses `pending[0]!`. Both work; this is just a style note. More importantly, `flags` is typed as `number | undefined` due to array destructuring, but is used without undefined check.

---

### L2. `formatClaudeName` produces odd spacing for some model IDs
**File:** `src/proxy/models.ts:120-125`  
**Category:** Code quality

```typescript
function formatClaudeName(parts: string[]): string {
  const [version, family, ...rest] = parts
  return ['Claude', family ? formatToken(family) : '', version || '', ...rest.map(formatToken)]
    .filter(Boolean).join(' ')
}
```

For `claude-4-sonnet`, parts = `['4', 'sonnet']`, producing `Claude Sonnet 4`. For `claude-4.5-sonnet-1m`, it produces `Claude Sonnet 4.5 1M`. The family comes before the version, which reads oddly compared to Anthropic's official naming (Claude Sonnet 4, not Claude Sonnet 4). Actually this is fine — but `claude-4.5-haiku` → `Claude Haiku 4.5` which is Anthropic's actual naming convention. Keeping for reference.

---

### L3. Dead `_flushedExecs` field partially redundant with `pendingExecs`
**File:** `src/proxy/cursor-session.ts:298, 370-371, 512, 537`  
**Category:** Code quality

`_flushedExecs` is used in the `afterParse` guard (`this._flushedExecs.length === 0`) to prevent double-flushing, but its contents are never read for any other purpose. It's set as a copy of `pendingExecs` in `flushBatch` and `sendToolResults`. A boolean flag like `_hasFlushedBatch` would be clearer.

---

### L4. `removeActiveSession` calls `session.close()` — double-close with `pumpAndFinalize`
**File:** `src/proxy/session-manager.ts:50-54`, `src/proxy/main.ts:405`

`removeActiveSession` calls `entry.session.close()`, and `pumpAndFinalize` also calls `session.close()` (line 405) after `removeActiveSession`. The `CursorSession.close()` method is idempotent (guarded by `if (this._alive)`), so this is harmless but indicates a confused ownership pattern.

---

### L5. `isMaxMode` / model ID stripping in `buildCursorRequest` duplicated with `models.ts` logic
**File:** `src/proxy/main.ts:221-224`  
**Category:** Code quality

```typescript
const isMaxMode = modelId.endsWith('-max')
const cursorModelId = isMaxMode ? modelId.slice(0, -4) : modelId
```

The `-max` suffix convention is also encoded in `models.ts:188-195` where max variants are registered. This business logic is split across two files with no shared constant or helper.

---

### L6. `collectNonStreamingResponse` returns a `Response` object (web API) from a Node.js HTTP server
**File:** `src/proxy/openai-stream.ts:278, main.ts:315-317`  
**Category:** Code quality

The function returns a `Response` (Fetch API), which is then manually decomposed in `main.ts`:
```typescript
res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
res.end(await response.text())
```

This works but adds unnecessary overhead (serialization to Response, then deserialization). A plain `{ status, headers, body }` object would be more direct.

---

### L7. `looksLikeRawModelName` has a fragile heuristic
**File:** `src/proxy/models.ts:107-113`

The regex `RAW_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/` classifies any lowercase-with-dots name as "raw" and triggers the pretty-name generator. A display name like `o4-mini` would be treated as raw and pretty-printed, which might not always be desirable.

---

## Test Coverage Gaps

### T1. No tests for `CursorSession` batch state machine
The most complex component — the three-state batch machine (`streaming → collecting → flushed`) with its flush guards, checkpoint tracking, and tool result routing — has zero unit tests. This is the highest-risk untested code.

### T2. No tests for `cursor-messages.ts` dispatch
The 600-line message processing module (`processServerMessage`, `handleExecMessage`, `nativeToMcpRedirect`, etc.) has no tests. This is critical correctness code that translates between two protocols.

### T3. No tests for `openai-stream.ts` SSE output format
The SSE stream writer's output format (chunk structure, `finish_reason`, keepalive, usage aggregation) is untested. OpenAI API conformance depends on this.

### T4. No tests for `session-manager.ts` key derivation or eviction
`deriveSessionKey` and `deriveConversationKey` collision behavior is untested. TTL eviction is untested.

### T5. No tests for `models.ts` model normalization
`normalizeAvailableModel`, `prettyCursorModelName`, and the dual-strategy fallback are untested despite containing significant logic.

### T6. No tests for `main.ts` request handling
The chat completion handler, `buildCursorRequest`, `pumpAndFinalize`, and the request routing logic are all untested.

### T7. No tests for `auth.ts` or `pkce.ts`
OAuth polling, token refresh, and PKCE generation are untested.

### T8. No tests for `proxy-lifecycle.ts`
Proxy spawning, port file management, and heartbeat lifecycle are untested.

---

## What's Good

- **Clean architecture**: Clear separation between protocol framing, message processing, session management, and HTTP routing.
- **Atomic disk writes**: `persistConversation` correctly uses temp-file + rename for crash safety.
- **Idempotent close**: `CursorSession.close()` and `SSECtx.close/sendDone` are all properly guarded against double-calls.
- **Overflow protection**: The event queue's `MAX_QUEUE_DEPTH` with `pushForce` for terminal events is well-designed.
- **Timer discipline**: All timers are consistently `unref()`'d to avoid keeping the process alive.
- **Connect protocol**: The frame parser correctly handles partial frames, multi-frame chunks, and the end-stream flag.
- **Thinking filter**: Correctly handles chunked tag boundaries with its buffering strategy.
- **Error boundaries**: The chat completion handler in `main.ts` properly catches parse errors and wraps the handler in `.catch()`.

---

## Recommendations (prioritized)

1. **Fix H1** (command injection in fetchArgs) — security fix, trivial
2. **Fix H2** (missing JSON.parse guards in internal API) — robustness, trivial
3. **Fix H3** (overflow → close doesn't push done event) — correctness, small
4. **Fix H4** (conversation state cache never evicted) — memory leak, small
5. **Fix M1** (retry outcome not handled) — correctness, medium effort
6. **Add tests for T1-T3** (batch state machine, cursor-messages, SSE output) — highest ROI testing
7. **Fix M5** (request body size limit) — security hardening, trivial
