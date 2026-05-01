# Architecture Review: pi-cursor

**Reviewer:** Architecture review subagent  
**Date:** 2026-05-01  
**Scope:** Full architecture assessment of the pi-cursor extension  
**Codebase:** ~4,700 lines of application code (excluding 16K vendored proto)

---

## Scorecard

| Dimension | Score | Summary |
|---|:---:|---|
| Module boundaries | 4/5 | Clean separation, no circular deps, one oversized module |
| Coupling | 4/5 | Transport and auth are isolatable; main.ts is a thick orchestrator |
| Scalability | 3/5 | Port-file approach works for ~10 sessions; fragile beyond that |
| Extension API usage | 4/5 | Correct OAuth + provider registration; minor gaps |
| Proto vendoring | 2/5 | 16K generated file without .proto source is a maintenance liability |
| Error propagation | 4/5 | ADR 0002 split works well in practice; some silent swallows |
| State management | 3/5 | Module-level mutable state in 4 files; testability suffers |
| Process lifecycle | 3/5 | Solid happy path; zombie risk on Windows, no PID reuse guard |
| Testability | 3/5 | Pure utilities well-tested; integration & protocol layers untested |

**Overall: 3.3 / 5** — A well-structured first implementation with clear module boundaries and good separation of concerns at the macro level. The main risks are: vendored proto maintenance, module-level global state hindering testability, and some gaps in process lifecycle robustness.

---

## 1. Module Boundaries (4/5)

**What's good:**
- **Zero circular dependencies** confirmed via import graph analysis. The dependency DAG flows cleanly:
  ```
  index.ts → auth.ts, proxy-lifecycle.ts
  proxy/main.ts → cursor-session, internal-api, session-manager, models, ...
  proxy/cursor-session.ts → cursor-messages, event-queue, connect-protocol
  proxy/cursor-messages.ts → native-tools, request-context, connect-protocol
  ```
- **Clean layer separation**: Extension layer (`index.ts`, `proxy-lifecycle.ts`, `auth.ts`, `pkce.ts`) is fully independent from the proxy layer (`proxy/*`). They share only the `CursorModel` type from `proxy/models.ts`.
- **Pure utility modules** (`event-queue.ts`, `thinking-filter.ts`, `connect-protocol.ts`, `openai-messages.ts`) have no cross-dependencies and are independently testable.
- **CONTEXT.md** provides excellent domain language definitions that keep naming consistent.

**Concerns:**
- **`proxy/main.ts` (559 lines)** is a fat orchestrator. It imports 10 internal modules and contains both HTTP routing, request building (`buildCursorRequest` at ~80 lines), and the pump/finalize lifecycle. The request building logic (protobuf construction from OpenAI messages) should be extracted into its own module (e.g., `request-builder.ts`).
- **`proxy/cursor-messages.ts` (602 lines)** mixes three distinct responsibilities: (a) interaction update handling, (b) KV blob handling, (c) exec dispatch with native-to-MCP redirection. The `nativeToMcpRedirect()` function (~130 lines) duplicates classification logic that also exists in `native-tools.ts:classifyExecMessage()`. The native redirection logic in cursor-messages.ts could live in native-tools.ts instead.
- **`proxy/cursor-session.ts` (772 lines)** is the largest non-proto file. It mixes two concerns: (a) the `CursorSession` class with H2 + batch state machine, and (b) result-sending functions (`sendMcpResultFrame`, `sendNativeResultFrame`) that are protocol serialization. These result-sending functions (~150 lines) could move to a `result-framing.ts` module.

## 2. Coupling (4/5)

**What's good:**
- **Transport is abstractable.** The H2 connection is encapsulated in `CursorSession`. The rest of the proxy only sees `SessionEvent` (a simple discriminated union). Swapping H2 for WebSocket or a mock would only require changing `cursor-session.ts`.
- **Auth is isolated.** `auth.ts` + `pkce.ts` are pure functions with no proxy knowledge. The extension pushes tokens to the proxy via `/internal/token` HTTP endpoint — a clean boundary.
- **Connect protocol** is a standalone framing library with no business logic dependency.
- **The proxy talks to the extension only via stdout (startup) and HTTP (runtime)** — no shared memory, no direct function calls.

**Concerns:**
- **`proxy/models.ts` imports `callCursorUnaryRpc` from `cursor-session.ts`** (line 23). This creates a coupling between model discovery and the session module. `callCursorUnaryRpc` is a standalone H2 helper that doesn't use `CursorSession` at all — it should live in its own module (e.g., `cursor-rpc.ts`).
- **`proxy/main.ts` directly instantiates `CursorSession`** with raw protobuf bytes, blob stores, and MCP tools. There's no factory or abstraction — making it hard to test `handleChatCompletion` without a real H2 connection.

## 3. Scalability (3/5)

**What's good:**
- **Shared proxy via port file** is architecturally sound for the target use case (1 user, 1-10 Pi sessions). One proxy process, one H2 connection pool, shared model cache.
- **Session eviction** (30-min TTL) and heartbeat timeout (30s) prevent resource leaks.
- **Conversation persistence** to disk means proxy restarts don't lose state.

**Limits and risks:**
- **Port file is not atomic on Windows.** `writeFileSync` + `readFileSync` can race between extension instances. Two extensions launching simultaneously could both try to spawn a proxy (the second spawn would either fail or create a zombie).
- **No file locking.** The port file doesn't use `flock` or equivalent. Concurrent writes could produce partial reads.
- **Health check + spawn is not an atomic operation.** Between `checkProxyHealth()` returning false and `spawnProxy()` starting, another extension could have already spawned one.
- **Single proxy process = single point of failure.** If the proxy crashes mid-conversation, all sessions lose their active streams. The extension doesn't attempt to re-spawn after a crash.
- **Heartbeat map is O(n) per check** (every 10s, iterate all sessions). Fine for 10 sessions, unnecessary overhead for 100+.
- **Conversation state is never cleaned up from disk.** `evictStaleConversations()` is declared in the plan but never implemented or called. Over time, `pi-cursor-conversations/` will accumulate unbounded data.

## 4. Extension API Usage (4/5)

**What's good:**
- **`pi.registerProvider()`** is used correctly with `api: 'openai-completions'`, proper model configs, and `baseUrl` pointing at the local proxy.
- **OAuth integration** follows Pi's `OAuthLoginCallbacks` contract: `onAuth({url})` → browser open, then poll.
- **`modifyModels` callback** is cleverly used to push fresh tokens to the proxy on every model access — ensuring the proxy always has a valid token.
- **`pi.on('session_shutdown')` properly cleans up heartbeat timers.**

**Concerns:**
- **Provider re-registration after model refresh is missing.** When `connectToProxy` discovers models and calls `updateModels()`, it saves to cache but never calls `register()` again. The provider's model list is stale until the next extension load. The `modifyModels` hook could handle this, but currently it only calls `ensureProxy` and returns `registeredModels` unchanged.
- **No `pi.appendEntry()` usage** for user-visible status messages during proxy startup. The 2-5 second startup delay is silent — the user sees nothing until models appear.
- **`loadStoredToken()` reads `~/.pi/agent/auth.json` directly** rather than using Pi's credential API. This is a fragile coupling to Pi's internal storage format that could break if Pi changes its auth storage.

## 5. Proto Vendoring (2/5)

**The problem:** `src/proto/agent_pb.ts` is a 16,135-line generated TypeScript file vendored without its source `.proto` file. The `aiserver.proto` (49 lines) is properly sourced and can be regenerated.

**Why this is risky:**
- **No `.proto` source means no regeneration.** When Cursor updates their protobuf schema (new fields, renamed types, changed field numbers), someone must manually diff the generated TypeScript to understand what changed. This is error-prone and time-consuming.
- **No semantic understanding.** Generated code obscures the actual wire format. Debugging protocol issues requires reverse-engineering field numbers.
- **Version pinning is implicit.** There's no record of which Cursor client version this proto corresponds to. The `CURSOR_CLIENT_VERSION = 'cli-2026.01.09-231024f'` in cursor-session.ts is a hint, but it's not tied to the proto file.
- **16K lines of unauditable code.** Lint rules are globally disabled for `src/proto/**` (correct), but you can't meaningfully review or audit this file.

**Mitigations in place:**
- The code treats proto types defensively, using `as any` casts in cursor-messages.ts where the generated unions require it.
- The `sendUnknownExecResult()` function handles proto fields not in the current schema by inspecting `$unknown` wire data — a good forward-compatibility measure.

**Recommendation:** Reconstruct the `.proto` source from the generated TS (field numbers and types are all present in the generated schemas). This is a one-time effort that pays for itself immediately. Track the Cursor client version the proto was captured from.

## 6. Error Propagation (4/5)

**ADR 0002's three-layer split works well in practice:**

| Layer | Handles | Evidence |
|---|---|---|
| Proxy (cursor-session) | H2 errors, stream death, blob-not-found, inactivity timeout | `classifyConnectError()` maps to `RetryHint`; `finish()` always emits a `done` event |
| Extension (index.ts) | Token refresh, proxy re-spawn | `onRefreshToken()` refreshes and pushes to proxy |
| Pi | User-visible errors | Only sees HTTP 4xx/5xx from proxy |

**What's good:**
- **`EventQueue.pushForce()`** ensures the terminal `done` event is never dropped, even if the queue is full.
- **`doneEventSent` flag** prevents duplicate done events.
- **`pumpSession` surfaces retryable errors** separately from terminal ones via `PumpResult.outcome === 'retry'`.
- **Connect end-stream errors** are parsed and classified with specific retry hints.

**Concerns:**
- **Silent `catch {}` blocks** appear in 12+ locations across `index.ts`, `proxy-lifecycle.ts`, and `internal-api.ts`. Examples:
  - `proxy-lifecycle.ts:sendHeartbeat()` — heartbeat failure is completely silent. If the proxy dies, the extension won't know until the next `ensureProxy` call.
  - `index.ts:pushToken()` — token push failure is silent. The proxy might be using an expired token.
  - `internal-api.ts:handleInternalRequest()` — `JSON.parse(await readBody(req))` has no try/catch at all (line 80, 90). Malformed JSON from a session will crash the handler.
- **`pumpAndFinalize` catches errors and logs to console** but doesn't surface them to the HTTP response if headers are already sent. The client sees a truncated SSE stream with no error event.
- **No structured error types.** All errors are plain `Error` with string messages. A `CursorError` hierarchy (e.g., `AuthError`, `ProtocolError`, `TransientError`) would make the retry/escalate decision more explicit.

## 7. State Management (3/5)

**Module-level mutable state exists in 4 files:**

| File | Mutable state | Scope |
|---|---|---|
| `proxy-lifecycle.ts` | `activeConnection` (1 var) | Extension process — single active proxy connection |
| `internal-api.ts` | `activeSessions`, `currentAccessToken`, `cachedModels`, `onModelsRefreshed`, `shutdownCallback` (5 vars) | Proxy process |
| `session-manager.ts` | `activeSessions` (1 map) | Proxy process |
| `conversation-state.ts` | `cache` (1 map) | Proxy process |

**Why this matters:**
- **Testing requires module-level reset.** `conversation-state.ts` exports `invalidateConversationState()` specifically for tests, but `internal-api.ts` and `session-manager.ts` have no reset mechanism. You can't test `handleInternalRequest` in isolation without the module-level state leaking between tests.
- **`configureInternalApi()` is called twice** during startup (lines in main.ts: first with empty models, then again after discovery). The second call silently overwrites the shutdown callback and models, but `activeSessions` from the first call persists — correct by accident, not by design.
- **No encapsulation.** `currentAccessToken` in `internal-api.ts` is a bare `let` that any code with access to `getAccessToken()` reads. If two concurrent requests trigger token refresh, there's a potential TOCTOU race (though unlikely in practice since Node is single-threaded for I/O callbacks).

**What's good:**
- Within `CursorSession`, state is properly instance-scoped. Each session owns its own H2 connection, event queue, blob store reference, and batch state machine. No shared mutable state between sessions.
- The extension side (`index.ts`) uses closure-scoped state (`currentPort`, `models`, `sessionId`) inside the exported function, avoiding true globals.

**Recommendation:** Wrap the proxy's global state in a `ProxyContext` class that's passed through the call chain. This makes testing trivial (create a fresh context per test) and makes the state dependencies explicit.

## 8. Process Lifecycle (3/5)

**Happy path is solid:**
1. Extension reads port file → health check → connect, OR spawn → read stdout ready signal → write port file.
2. Extension sends heartbeats every 10s.
3. Proxy monitors heartbeats — exits 30s after last heartbeat stops.
4. Extension cleans up on `session_shutdown`.

**Risks:**

- **Zombie processes on Windows.** `child.unref()` (proxy-lifecycle.ts:189) detaches the child. If the extension crashes without calling `session_shutdown`, the proxy keeps running. The heartbeat timeout (30s) is the safety net — but if the extension stored its heartbeat interval timer with `.unref()`, the extension process can exit while the heartbeat timer is still "running" (it's not — `.unref()` means it won't keep the process alive). This is actually correct behavior, but the zombie scenario is: extension crash → no more heartbeats → proxy exits after 30s. That 30s window is a zombie.

- **PID reuse.** `isProcessAlive()` uses `process.kill(pid, 0)` to check if the proxy is alive. On Windows and Linux, PIDs can be reused. If the proxy dies and another process gets the same PID, the extension will think the proxy is alive and try to connect to a random port. The health check (`checkProxyHealth`) mitigates this, but there's a brief window where `readPortFile()` returns a stale entry with a valid-but-wrong PID.

- **Port file not cleaned up on proxy exit.** The proxy writes `process.exit(0)` in the shutdown callback but doesn't delete the port file. The extension's `readPortFile()` handles this by checking PID liveness, but it's a messy pattern.

- **`stdin.end()` after config write** (proxy-lifecycle.ts:155) means the proxy can't receive any more stdin input. This is fine given the HTTP-based internal API design, but the closed stdin means Node.js will eventually trigger an `end` event on stdin. The proxy doesn't appear to handle stdin close as a shutdown signal (it relies entirely on heartbeat timeout), which matches ADR 0003 — but it's worth documenting.

- **Startup timeout is 15s.** Model discovery over gRPC to `api2.cursor.sh` is included in the startup path. On slow networks, 15s may not be enough. The proxy should start the HTTP server first, write the ready signal, and discover models asynchronously.

## 9. Testability (3/5)

**Well-tested (with evidence):**
- 7 test files, 54 tests, all passing.
- Pure utility modules are thoroughly tested: `connect-protocol` (10 tests), `event-queue` (5 tests), `thinking-filter` (5 tests), `openai-messages` (8 tests), `native-tools` (7 tests), `conversation-state` (3 tests), proto smoke test (2 tests).

**Untested and hard to test:**
- **`cursor-session.ts`** — 772 lines, zero tests. The H2 connection and batch state machine are the most complex parts of the system. Testing requires either mocking `node:http2` or running a fake gRPC server. The tight coupling to H2 makes unit testing impractical without extracting the batch state machine into a pure function.
- **`cursor-messages.ts`** — 602 lines, zero tests. The `processServerMessage` function takes 10 parameters (callbacks + state). It could be tested with mock protobuf messages, but the `any` casts and protobuf gymnastics make test setup verbose.
- **`main.ts`** — 559 lines, zero tests. The HTTP handler, request builder, and pump lifecycle are all untested. `handleChatCompletion` is a 100-line function with 5 branches.
- **`openai-stream.ts`** — 381 lines, zero tests. `pumpSession` and `createSSECtx` are testable (they consume `SessionEvent` and produce SSE text) but have no tests.
- **`proxy-lifecycle.ts`** — 228 lines, zero tests. Process management is inherently hard to test, but the port file read/write and health check logic could be tested.

**Integration testing story:**
- No integration tests exist.
- The plan (Task 19) mentions integration testing but provides no detail.
- A useful integration test would: (a) start the proxy with a mock Cursor gRPC server, (b) send an OpenAI chat completion request, (c) verify SSE output. This requires a mock H2 server implementing the Connect protocol.
- The batch state machine could be tested in isolation if extracted from `CursorSession` — it's pure state transition logic that currently lives inside a class with an H2 dependency.

---

## Summary of Recommendations

### High Priority
1. **Reconstruct `agent.proto`** from the generated TS. Track the Cursor client version it corresponds to.
2. **Extract `ProxyContext`** to encapsulate module-level mutable state in `internal-api.ts`, `session-manager.ts`, and `conversation-state.ts`.
3. **Add tests for `cursor-session.ts` batch state machine** by extracting it as a pure state transition function.
4. **Fix JSON.parse without try/catch** in `internal-api.ts:handleInternalRequest()` (lines ~80, ~90).

### Medium Priority
5. **Extract `callCursorUnaryRpc`** from `cursor-session.ts` into a standalone `cursor-rpc.ts` module.
6. **Extract `buildCursorRequest`** from `main.ts` into `request-builder.ts`.
7. **Add structured error types** (`CursorAuthError`, `CursorProtocolError`, `CursorTransientError`).
8. **Implement conversation state disk cleanup** (the `evictStaleConversations` function from the plan).
9. **Clean up port file on proxy exit** rather than relying on PID liveness checks.
10. **Start HTTP server before model discovery** in `main.ts` to reduce startup latency.

### Low Priority
11. **Add `pi.appendEntry()` calls** during proxy startup for user-visible progress.
12. **Add file locking** to port file read/write for robustness with concurrent launches.
13. **Replace `loadStoredToken()` direct file access** with Pi's credential API if one exists.
14. **Add integration test infrastructure** with a mock Connect/gRPC server.
