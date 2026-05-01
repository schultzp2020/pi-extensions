# Devil's Advocate Review: pi-cursor

_Date: 2026-05-01_  
_Scope: Full source review of `src/` (excluding `src/proto/`), README, ADRs, and plan._  
_Methodology: Adversarial — every design decision challenged, every failure mode probed._

---

## 1. Why a Child Process Proxy at All?

**ADR-0001 claims** the proxy exists because Cursor's H2 stream must stay alive during tool execution, but Pi's `streamSimple` is call-return-call. The proxy "encapsulates all H2/protobuf/reject complexity."

### Challenges

**The complexity is just relocated, not eliminated.** Instead of managing an H2 connection across `streamSimple` calls, you now manage:
- A child process lifecycle (spawn, health check, port file, heartbeat, orphan cleanup)
- An HTTP-based internal API for token delivery, heartbeat, and model refresh
- A session manager mapping OpenAI requests back to live Cursor sessions
- Two separate ReadableStream piping layers (SSE → Node HTTP response)

The net result: **the proxy has more moving parts than an in-process approach would.** An in-process design could store the `CursorSession` in a module-scoped `Map<string, CursorSession>` keyed by conversation, which is exactly what `session-manager.ts` already does — just across a process boundary. The process boundary adds failure modes (orphaned processes, stale port files, heartbeat failures) without adding capability.

**Counter-argument to the ADR's reasoning:** Pi's `AbortSignal` and `streamSimple` concerns are valid, but the proxy approach introduces an entirely new class of bugs: process coordination, port conflicts, stdio race conditions, and cross-process token propagation. A more honest ADR would acknowledge this is a tradeoff, not a clear win.

**The "multi-session sharing" justification (ADR-0003) is weak in practice.** How often do users actually run multiple Pi sessions against the same Cursor subscription simultaneously? The shared-proxy architecture adds significant complexity to serve what is likely a rare use case. A simpler design would spawn one proxy per Pi session and accept the overhead.

---

## 2. The Heartbeat / Port File Mechanism

### What happens when it breaks?

**Port file race conditions (`proxy-lifecycle.ts:59-72`):**  
`readPortFile()` checks `existsSync → readFileSync → isProcessAlive`. Between `existsSync` returning true and `readFileSync` executing, the file could be deleted by another process cleaning up. The `try/catch` swallows this, returning `null`, but:

- Two sessions spawning simultaneously can both see `readPortFile() → null`, both call `spawnProxy()`, and you get **two proxy processes** running on different ports. Only the last one to write the port file wins. The loser's heartbeats go to a port nobody reads.
- There is **no file locking**. `writePortFile()` (`proxy-lifecycle.ts:74-77`) does a plain `writeFileSync` with no atomicity guarantee. On Windows, where file operations are not atomic, a reader can get a partial JSON blob.

**Stale port file on crash:**  
If the proxy process is killed (e.g., `kill -9`, Windows Task Manager), the port file persists. `isProcessAlive` checks `process.kill(pid, 0)`, which works on Unix but **on Windows, `process.kill(pid, 0)` can return true for terminated processes** in some edge cases due to process handle recycling. A stale port file pointing to a recycled PID could cause the extension to send heartbeats/tokens to an unrelated process on the same port.

**Heartbeat timeout math is fragile:**  
- Extension sends heartbeats every 10s (`HEARTBEAT_INTERVAL_MS = 10_000`)
- Proxy times out sessions after 30s (`HEARTBEAT_TIMEOUT_MS = 30_000`)
- Heartbeat monitor checks every 10s (`setInterval(..., 10_000)`)

If 3 consecutive heartbeats fail (network blip, high CPU load, GC pause), the proxy shuts down. With the proxy checking every 10s, the effective window before shutdown is between 30-40 seconds of missed heartbeats. On a loaded machine, this window is uncomfortably tight. **There is no reconnection logic** — if the proxy dies, the extension just has a dead `currentPort` until the next `ensureProxy()` call, which only happens in `modifyModels`.

**`child.unref()` creates zombie risk (`proxy-lifecycle.ts:165`):**
The proxy is unref'd so it doesn't keep the parent alive. But if the parent dies ungracefully (crash, `kill -9`), the proxy's only shutdown signal is the heartbeat timeout. For 30 seconds, an orphan proxy runs with an active H2 connection to Cursor, consuming subscription resources.

### Evidence of fragility

`proxy-lifecycle.ts:139` — `connectToProxy` calls `pushToken`, then `startHeartbeat`, then `refreshModels` **sequentially**. If `refreshModels` takes >30s (model discovery timeout is 10s, but Cursor API can be slow), the heartbeat may have already been set up but the connection is not yet established in the extension's view. If the function throws after `startHeartbeat`, the heartbeat timer is running but `currentPort` is never set in `index.ts`.

---

## 3. Batch State Machine (streaming → collecting → flushed)

### State machine correctness

The state machine in `cursor-session.ts` has three states: `streaming`, `collecting`, `flushed`.

**Potential deadlock scenario:**

1. Session starts in `streaming`. MCP exec arrives → transition to `collecting`. Tool call event pushed to queue.
2. A second MCP exec arrives while still in `collecting`. Another tool call event pushed.
3. `afterParse()` is called. It checks `this.batchState === 'collecting' && this.pendingExecs.length > 0 && this._flushedExecs.length === 0 && (streamState.checkpointAfterExec || this._checkpointChunkSeq === this._chunkSeq)`.
4. **If no checkpoint arrives**, `checkpointAfterExec` stays `false` and `_checkpointChunkSeq` never matches. The session stays in `collecting` indefinitely. No `batchReady` event is ever emitted. **The SSE pump hangs forever** in `pumpSession`, waiting for the next event.

This isn't strictly a deadlock, but it's a **livelock where the session is stuck in `collecting` without ever flushing.** The inactivity timer won't fire because `resetInactivityTimer()` is called on every recognized message, and the execs themselves are recognized messages. The 30-second thinking timeout resets every time Cursor sends any message (heartbeat responses, etc.).

**Wait — actually, looking more carefully:** `handleEndStream` sets `checkpointAfterExec = true` when there are pending execs. So if Cursor closes the stream while execs are pending, the batch will flush. But what if Cursor is waiting for our tool results before closing? Then we have a mutual wait: Cursor waits for tool results, we wait for a checkpoint to flush tool calls. **This IS a potential deadlock** unless Cursor always sends a checkpoint before waiting for tool results.

**The `_flushedExecs.length === 0` guard prevents re-flushing**, but what if `sendToolResults` is called with partial results? `sendToolResults` (`cursor-session.ts:237-261`) re-pushes unmatched execs and sets `batchState = 'flushed'` with new `_flushedExecs`. But the original execs may have been consumed by `pumpSession` already. If Pi only sends results for _some_ of the tool calls (e.g., one failed), the remaining execs get re-flushed, but the SSE stream has already sent `finish_reason: 'tool_calls'` and `[DONE]` on the first batchReady. **The second batchReady creates a broken SSE stream** — it tries to write chunks after `[DONE]` was sent.

Looking at `pumpSession` in `openai-stream.ts:164-170`: when `batchReady` fires, it sends `finish_reason: 'tool_calls'` AND calls `ctx.sendDone()`. Then returns `{ outcome: 'batchReady' }`. On the next call, `pumpAndFinalize` sets the session as active. But `sendToolResults` with unmatched execs pushes a NEW `batchReady`... which nobody is listening to, because `pumpSession` already returned. The `batchReady` event sits in the queue until the next `handleChatCompletion` call, which starts a new `pumpSession` — but by then, the SSE stream is already closed.

**Verdict: The batch state machine is fragile when partial tool results arrive.**

### The `_chunkSeq` trick

`_checkpointChunkSeq === this._chunkSeq` is used to detect when a checkpoint arrives in the same H2 data event as an exec. This assumes Cursor always sends checkpoint+exec in the same TCP segment. If Cursor changes its batching behavior (e.g., sends them in separate H2 DATA frames), this optimization breaks silently and the batch never flushes until a cross-chunk checkpoint arrives.

---

## 4. Conversation Persistence

### Is it actually needed?

The `conversation-state.ts` module persists conversations to `tmpdir()`. But `tmpdir()` is wiped on reboot, so **persistence only survives within a single uptime window**. This is useful for crash recovery within a session, but:

- **There is no TTL eviction implemented.** The plan mentions `evictStaleConversations()`, but it doesn't exist in the codebase. The `checkpointHistory` and `checkpointArchive` Maps grow unbounded. Over a long-running session with many checkpoints, these can consume significant memory and disk.
- **The `lastAccessMs` field is maintained but never read for eviction** — there's no cleanup timer.

### Concurrent access

**The in-memory cache (`const cache = new Map<>()`) is process-global with no synchronization.**

Since the proxy is single-threaded Node.js, concurrent access within the process is safe. But:

- `persistConversation` writes to disk while `resolveConversationState` might read from disk. If one request is persisting while another is loading (cache miss), the second request could load a stale version from disk if the rename hasn't completed.
- On Windows, `renameSync` from a temp file can fail if antivirus or Windows Defender is scanning the temp file. The function has **no error handling** — it will throw and crash the request handler, but the catch in `handleChatCompletion` should recover.

**Cross-process corruption:** If two proxy instances somehow run simultaneously (see port file race above), they share the same `conversationDiskDir`. Both read/write the same files without locking. Corruption is likely.

### The blob store grows forever

`blobStore` maps blob IDs to `Uint8Array` values. Every `setBlobArgs` call adds to it, nothing ever removes. For long conversations with many tool calls, this accumulates significant data in memory and on disk.

---

## 5. Token Handling and OAuth Security

### Token transport

**Tokens are sent over plaintext HTTP (`index.ts:91-99`, `proxy-lifecycle.ts:97-107`):**
```typescript
await fetch(`http://localhost:${port}/internal/token`, {
  method: 'POST',
  body: JSON.stringify({ access: accessToken }),
})
```

This is `http://localhost`, not HTTPS. While localhost traffic doesn't leave the machine, any local process can listen on the wire (Wireshark, packet capture, etc.). On multi-user systems, other users' processes might sniff the traffic.

**Tokens pass through stdin in plaintext (`proxy-lifecycle.ts:144`):**
```typescript
stdin.write(`${JSON.stringify({ accessToken })}\n`)
```

The access token is written to the child process's stdin as plain JSON. If process monitoring tools log stdin (e.g., audit frameworks, EDR agents), the token is captured.

### Token storage

**Tokens are stored in `~/.pi/agent/auth.json` by Pi's credential store**, not by this extension. The extension reads this file at startup (`index.ts:59-72`) with no particular security — just a `readFileSync`. The file permissions are whatever the OS default is (likely `0644` on Unix = world-readable).

### Token refresh race

`onRefreshToken` in `index.ts:82-88` refreshes the token and pushes it to the proxy. But `pushToken` is fire-and-forget (`catch {}` swallows errors). If the push fails, the proxy continues using the old (potentially expired) token. The next request to Cursor will fail with a 401, but there's **no retry path** — the error surfaces as a generic proxy error to the user.

### JWT parsing

`getTokenExpiry` in `auth.ts:79-92` uses `atob(parts[1].replaceAll('-', '+').replaceAll('_', '/'))` for base64url decoding. This is correct but fragile:
- If the JWT has a non-standard format (e.g., Cursor changes to an opaque token), the fallback is `Date.now() + 3600 * 1000` (1 hour). This means **a permanently valid opaque token gets treated as expiring in 1 hour**, causing unnecessary refresh attempts.
- The `catch {}` swallows all parsing errors silently.

### PKCE security

The PKCE implementation in `pkce.ts` looks correct (32 bytes of randomness, SHA-256 challenge). However:

- **The verifier is held in memory** throughout the polling loop (up to 150 attempts × variable delay = potentially minutes). If the process is debugged or memory-dumped during this window, the verifier is exposed.
- **The `redirectTarget: 'cli'` parameter** in the auth URL might allow Cursor to redirect to a local handler — but there is no local server. The extension polls instead. This is fine, but it means the user must complete auth in the browser within the polling window (~150 attempts × up to 10s delay = ~25 minutes max). Not a security issue, but a UX one.

---

## 6. Model Discovery Fragility

### Cursor API dependency

**The entire model discovery is reverse-engineered from Cursor's internal API.** There is no public documentation or stability guarantee for these RPCs:

- `/aiserver.v1.AiService/AvailableModels` — primary
- `/agent.v1.AgentService/GetUsableModels` — fallback

**When Cursor changes their API (not if, when), everything breaks:**

- Proto schemas become incompatible (field renaming, removal, new required fields)
- The RPC path could change
- The authentication scheme could change (bearer → cookie, API key, etc.)
- The response format could add new required fields that the old schema doesn't parse

**The hardcoded `MODEL_LIMITS` table (`models.ts:30-58`) is already showing this fragility.** It lists specific models like `'gpt-5.4'`, `'claude-4.6-sonnet'`, `'gemini-3.1-pro'` — model names that Cursor invented. When new models appear (or these get renamed), the hardcoded fallbacks break.

### Model cache staleness

Models are cached in `~/.pi/agent/cursor-model-cache.json`. If Cursor adds or removes models, the cache serves stale data until:
1. The user restarts Pi, or
2. `refreshModels` is called via the internal API

There is **no periodic refresh**. A user could run for days on a stale model list. If a model is removed from their subscription, they'll get cryptic protobuf errors when trying to use it.

### Error handling in discovery

`discoverCursorModels` silently returns `[]` if both RPCs fail (`models.ts:262`). This means the extension registers with **zero models** — Pi shows a Cursor provider with nothing in it. There's no user-facing error explaining why. The user just sees an empty model picker.

---

## 7. The `-max` Suffix Approach

### How it works

`main.ts:148-149`:
```typescript
const isMaxMode = modelId.endsWith('-max')
const cursorModelId = isMaxMode ? modelId.slice(0, -4) : modelId
```

Models like `claude-4-sonnet-max` get the `-max` stripped, and `maxMode: true` is set in `ModelDetails`.

### Fragility

**What if a real model name ends in `-max`?** Looking at `models.ts:206`, the code explicitly checks:
```typescript
if (id.endsWith('-max')) {
  return [{ ...base, supportsMaxMode: true }]
}
```

So if Cursor has a model literally named `foo-max`, it's registered as a max variant of `foo`. But when a request comes in for `foo-max`, the code strips `-max` and sends `foo` with `maxMode: true`. If `foo` doesn't exist, Cursor returns an error.

**What if the model discovery reports `supportsMaxMode` but the `-max` variant doesn't actually work?** The extension creates the variant optimistically. If Cursor's backend doesn't support max mode for that model, the user gets a Cursor-side error.

**The dual registration (`models.ts:210-218`) creates naming confusion:**
```typescript
if (m.supportsMaxMode) {
  return [base, { ...base, id: `${id}-max`, name: `${name} (Max)` }]
}
```

This doubles the model list. If Cursor reports 30 models, 15 of which support max mode, the user sees 45 entries. The names are synthetic (`Claude Sonnet 4 (Max)`) and may not match what the user expects from Cursor's UI.

---

## 8. Unhandleable Proxy Requests

### What happens when Pi sends something unexpected?

**Non-streaming requests with tool calls (`openai-stream.ts:277-282`):**
```typescript
} else if (event.type === 'toolCall' || event.type === 'batchReady') {
  finalizeSession()
  return nonStreamingErrorResponse('Unexpected tool activity...')
}
```

If Pi sends `stream: false` and Cursor decides to use tools, the response is a 502 error. The user sees "Unexpected tool activity" with no recourse. This is a **hard failure for any non-streaming request to a model that might call tools** — which is essentially all Cursor models when given MCP tools.

**Large message arrays:** `parseMessages` (`openai-messages.ts`) processes the entire message array linearly. For long conversations (hundreds of messages), this creates large `turns` arrays. `buildCursorRequest` (`main.ts`) serializes all turns into protobuf. But if a checkpoint exists, the turns are ignored and the checkpoint is used instead. **However**, if the checkpoint is corrupt or from an incompatible session, it's silently discarded (`main.ts:105 - decodeCheckpointState returns null`), and the code falls back to building turns from scratch. This means **one corrupted checkpoint causes the entire conversation history to be re-serialized from Pi's message array**, which may not match the conversation state Cursor expects.

**Concurrent requests to the same session key:** Two requests can arrive for the same conversation simultaneously. Both call `resolveConversationState` for the same key, get the same reference, and start separate `CursorSession` instances. The second request's session will have the same `conversationId` but different H2 connections. Cursor may reject the second request or produce inconsistent results.

### Pi-side tool name mismatches

`fixMcpArgNames` (`native-tools.ts:8-12`) only handles `path → filePath` for `read`, `write`, and `edit`. If Pi renames or restructures its tool arguments, every affected tool silently breaks. There's no validation that the tool arguments actually match what Pi expects.

---

## 9. Real-World Failure Modes Users Will Hit

### 1. "Cursor provider shows no models"
**Cause:** Both model discovery RPCs fail (network issue, token expired, Cursor API change).  
**Symptom:** `/model` shows "cursor" with an empty list.  
**Recovery:** None visible to the user. Must `/login cursor` again and restart Pi.

### 2. "Proxy died mid-conversation"
**Cause:** H2 connection dropped, 30s inactivity timeout, or heartbeat failure.  
**Symptom:** Response stops mid-stream. User sees `[Error: inactivity timeout]` or `[Error: bridge connection lost]` inline.  
**Recovery:** Retry the message. But the conversation state may be corrupted — the checkpoint might reflect a state the server no longer has.

### 3. "Tool calls work for a while, then stop"
**Cause:** Cursor's 25-call limit per turn (tracked by `totalExecCount` in `StreamState`). But `totalExecCount` is **tracked but never enforced** — there's no code that checks it or warns the user.  
**Symptom:** After ~25 tool calls, Cursor silently stops sending new exec messages. The session hangs in `collecting` state until inactivity timeout.

### 4. "First message works, subsequent messages fail"
**Cause:** Session key derivation (`session-manager.ts:17-19`) uses `createHash('sha256').update('session:${sessionId}:${firstUserText.slice(0, 200)}')`. If the first user message is identical across conversations (e.g., "hi" or "help"), different conversations collide on the same session key.  
**Symptom:** The second conversation tries to send tool results to a dead session from the first conversation.

### 5. "Blob not found" errors after long sessions
**Cause:** The blob store grows with `setBlobArgs` but blobs are keyed by hex-encoded IDs. If a checkpoint references a blob that was set in a different session or before a process restart, and the in-memory blob store was lost, the `getBlobArgs` handler returns an empty `GetBlobResult`. Cursor sees this as "blob not found" and the session fails.  
**Recovery:** The code has `retryHint: 'blob_not_found'` for classification, and the session has auto-resume from checkpoint mentioned in the plan, but **auto-resume is not implemented** — `cursor-session.ts` has no retry logic. The session just dies.

### 6. "Works on macOS, fails on Windows"
**Cause:** Multiple Windows-specific issues:
- `process.kill(pid, 0)` behavior differences for zombie detection
- Port file atomicity (no `renameSync` guarantee on Windows with open file handles)
- `child.unref()` + `detached: false` behavior on Windows (parent exit may kill child)
- `tmpdir()` cleanup behavior differs (Windows doesn't auto-clean temp)

### 7. "Token expired mid-stream"
**Cause:** Access token expires during a long streaming response (>1 hour).  
**Symptom:** The H2 stream to Cursor returns 401 mid-stream. The session dies.  
**Recovery:** Pi refreshes the token on the _next_ request via `onRefreshToken`, but the current response is lost. No in-flight token refresh is possible because the H2 stream was opened with the old token in the `authorization` header.

### 8. "Memory grows over time"
**Cause:** Multiple unbounded Maps:
- `cache` in `conversation-state.ts` — never evicted
- `blobStore` per session — never pruned
- `activeSessions` in `internal-api.ts` — evicted on heartbeat timeout, but entries accumulate between checks
- `activeSessions` in `session-manager.ts` — 30-minute TTL, eviction timer every 60s, but sessions hold H2 connections

### 9. "Extension works once, then cursor provider disappears"
**Cause:** `index.ts` calls `register()` once at startup. If the proxy dies and restarts on a different port, `currentPort` is updated via `ensureProxy` in `modifyModels`, but `baseUrl` in the provider registration **is never re-registered**. Pi continues sending requests to the old port.

**Evidence:** `index.ts:118` — `register()` is called once. The `modifyModels` callback calls `ensureProxy` which updates `currentPort`, but the `baseUrl` in the provider config was already set to the old port. There's no `pi.registerProvider` call to update it.

### 10. `deleteArgs` path injection vulnerability
**Cause:** `cursor-messages.ts:150`:
```typescript
const safePath = rawPath.replaceAll('\0', '').replaceAll("'", "'\\''")
return { command: `rm -f '${safePath}'` }
```
This shell-quotes the path, but on Windows, `rm -f` doesn't exist (it's `del` or `Remove-Item`). The command will fail on Windows. Also, the shell escaping only handles single quotes — paths with backticks, dollar signs, or other shell metacharacters could still be problematic depending on the shell.

---

## 10. Structural and Code Quality Issues

### Duplicated code

- `readBody` and `jsonResponse` are duplicated between `main.ts:68-80` and `internal-api.ts:61-75`. Same functions, same signatures.
- `pushToken` is defined in both `index.ts:91-99` and `proxy-lifecycle.ts:97-107`.
- `sendExecStreamClose` is defined in both `cursor-session.ts:137-150` and `cursor-messages.ts:193-203`.

### Module dependency coupling

`cursor-session.ts` imports from `cursor-messages.ts` and vice versa (through `StreamState`, `PendingExec` types). While this doesn't create a circular import (the types flow one-way), the boundary between these modules is unclear. `cursor-session.ts` handles both transport AND result formatting (150+ lines of `sendNativeResultFrame` / `sendMcpResultFrame`), while `cursor-messages.ts` handles message parsing AND some result sending (`sendExecResult`). The responsibilities overlap.

### Missing error types

The entire codebase uses bare `Error` objects and string messages. There are no typed error classes, no error codes, and no structured error propagation. Every `catch {}` swallows errors silently. This makes debugging production issues extremely difficult.

### No request timeout on chat completions

`handleChatCompletion` in `main.ts` has no overall timeout. If the Cursor API hangs indefinitely (Cursor sends keepalive heartbeats but no content), the request stays open forever. The inactivity timeout in `CursorSession` helps, but it resets on any message — including heartbeats.

---

## Summary Verdict

| Area | Risk Level | Core Issue |
|---|---|---|
| Child process proxy | Medium | Complexity relocation, not elimination. Process coordination adds new failure modes. |
| Heartbeat/port file | **High** | Race conditions, Windows compatibility, no reconnection logic, stale file risk. |
| Batch state machine | **High** | Potential mutual-wait deadlock; broken SSE stream on partial tool results. |
| Conversation persistence | Medium | No eviction, no concurrent access protection, unbounded blob growth. |
| Token handling | Medium | Plaintext localhost HTTP, no in-flight token refresh, fire-and-forget push. |
| Model discovery | **High** | Entirely reverse-engineered, hardcoded fallbacks, silent empty-list failure. |
| `-max` suffix | Low-Medium | Name collision possible but unlikely; doubles model list. |
| Unhandleable requests | Medium | Non-streaming + tools = hard failure; session key collisions. |
| User-facing failures | **High** | Stale baseUrl after proxy restart, no auto-resume, memory leaks over time. |

The extension works for the happy path. The adversarial question is: **how long does it keep working?** The answer, given the unbounded state growth, missing reconnection logic, and fragile process coordination, is: **until something goes wrong, and then recovery is manual.**
