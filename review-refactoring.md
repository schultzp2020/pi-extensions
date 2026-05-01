# Refactoring Review — pi-cursor

> Reviewed: 2026-05-01 | All 54 tests pass | Scope: `src/` excluding `src/proto/`

---

## 1. `proxy/main.ts` is a 559-line God Module

**What:** `proxy/main.ts` mixes HTTP routing, request validation, Cursor protobuf request building, chat completion orchestration, stream piping, conversation state management, and process lifecycle (stdin read, ready signal) — all in one file.

**Where:** `src/proxy/main.ts` (entire file; key functions: `buildCursorRequest` 91 lines at L152, `handleChatCompletion` 120 lines at L257, `main` 117 lines at L438)

**Why:** Each function has too many responsibilities. `handleChatCompletion` alone handles validation, session lookup, tool-result resume, fresh request construction, streaming/non-streaming branching, and conversation persistence. This makes the file hard to test (no unit tests exist for it) and any change risks cascading breakage.

**How:**
1. Extract `buildCursorRequest()` and `decodeCheckpointState()` into a new `src/proxy/cursor-request.ts` module — these are pure protobuf construction functions with no HTTP dependencies.
2. Extract `buildMcpToolDefinitions()` into `src/proxy/request-context.ts` (it already hosts `buildRequestContext`).
3. Split `handleChatCompletion` into two phases: (a) a request-parsing function that returns a validated `ChatCompletionParams` object, and (b) a session-dispatch function that handles streaming vs non-streaming.
4. Extract `pumpAndFinalize` and `pipeReaderToResponse` into `src/proxy/openai-stream.ts` — they're SSE plumbing.

**Risk:** Medium — requires careful import rewiring but all functions are already separable by signature.

---

## 2. Duplicated `sendExecStreamClose` in `cursor-session.ts` and `cursor-messages.ts`

**What:** Two independent implementations of `sendExecStreamClose` exist with subtly different signatures: `cursor-session.ts:268` takes `(write, execMsgId)` and `cursor-messages.ts:268` takes `(execId, sendFrame)`. Both construct identical `ExecClientControlMessageSchema` → `ExecClientStreamCloseSchema` → frame. Similarly, both files independently implement the `frameConnectMessage → toBinary → AgentClientMessageSchema` wrapping pattern in 12+ call sites.

**Where:**
- `src/proxy/cursor-session.ts:268` — `sendExecStreamClose(write, execMsgId)`
- `src/proxy/cursor-messages.ts:268` — `sendExecStreamClose(execId, sendFrame)`

**Why:** The duplication means bug fixes must be applied in two places. The different parameter orders (`write` first vs `sendFrame` last) are a trap for callers.

**How:**
1. Create a `src/proxy/cursor-framing.ts` module that exports a unified `sendExecStreamClose(sendFrame, execId)` and a helper `sendClientMessage(sendFrame, message)` that handles the `AgentClientMessageSchema → toBinary → frameConnectMessage` wrapping.
2. Both `cursor-session.ts` and `cursor-messages.ts` import from this shared module.
3. Standardize parameter order: `sendFrame` always first (callback-last is the Node convention, but here the callback IS the transport — putting it first is clearer and matches how `cursor-messages.ts` does it).

**Risk:** Low — mechanical extraction, easy to verify since existing tests cover the frame format.

---

## 3. Duplicated `sendNativeResultFrame` in `cursor-session.ts` also duplicates logic from `cursor-messages.ts`

**What:** `cursor-session.ts` contains `sendMcpResultFrame` (38 lines, L117–155) and `sendNativeResultFrame` (106 lines, L161–265) which construct protobuf result messages and send them as frames. Meanwhile `cursor-messages.ts` has its own `sendExecResult` (L250–265) and `nativeToMcpRedirect` (102 lines, L121–222) which do the reverse direction (incoming exec → MCP redirect). The result-sending logic in `cursor-session.ts` should live alongside the exec-handling logic in `cursor-messages.ts`.

**Where:** `src/proxy/cursor-session.ts:117–265` (result senders), `src/proxy/cursor-messages.ts:121–222` (redirectors)

**Why:** Native tool result construction is split across two files. A developer adding a new native tool type must update both `nativeToMcpRedirect` (for incoming) and `sendNativeResultFrame` (for outgoing). These should be co-located.

**How:**
1. Move `sendMcpResultFrame`, `sendNativeResultFrame`, and `sendExecStreamClose` from `cursor-session.ts` into a new `src/proxy/exec-results.ts` (or merge into `cursor-messages.ts`).
2. `CursorSession.sendToolResults()` calls the shared functions, passing `(data) => this.write(data)` as the transport.
3. This drops ~150 lines from `cursor-session.ts` (already 772 lines) and co-locates all native tool logic.

**Risk:** Low — pure function extraction, no behavior change.

---

## 4. `processServerMessage` takes 11 positional parameters

**What:** The function signature is: `processServerMessage(msg, blobStore, mcpTools, cloudRule, sendFrame, state, onText, onMcpExec, onCheckpoint?, onNotify?)` — 11 args, 4 of which are callbacks. This is unreadable at the call site and fragile to extend.

**Where:** `src/proxy/cursor-messages.ts:547–557`

**Why:** Adding a new callback (e.g., `onUsage`) requires changing the signature AND the single call site in `cursor-session.ts:466`. Positional args this long are a refactoring bottleneck.

**How:**
1. Define a `MessageProcessorContext` interface:
   ```ts
   interface MessageProcessorContext {
     blobStore: Map<string, Uint8Array>
     mcpTools: McpToolDefinition[]
     cloudRule?: string
     sendFrame: (data: Buffer) => void
     state: StreamState
     onText: (text: string, isThinking: boolean) => void
     onMcpExec: (exec: PendingExec) => void
     onCheckpoint?: (bytes: Uint8Array) => void
     onNotify?: (text: string) => void
   }
   ```
2. Change signature to `processServerMessage(msg, ctx)`.
3. Update the single call site in `cursor-session.ts:466`.

**Risk:** Low — purely structural, one call site.

---

## 5. Duplicated `readBody` / `jsonResponse` / `errorResponse` helpers

**What:** `readBody()` and `jsonResponse()` are independently defined in both `src/proxy/main.ts` (L87, L100) and `src/proxy/internal-api.ts` (L72, L65). They're identical in purpose and nearly identical in implementation.

**Where:**
- `src/proxy/main.ts:87–98` — `readBody`
- `src/proxy/main.ts:100–103` — `jsonResponse`
- `src/proxy/internal-api.ts:65–69` — `jsonResponse`
- `src/proxy/internal-api.ts:72–82` — `readBody`

**Why:** Code duplication — any change to body reading (e.g., adding a size limit) must be applied in two places.

**How:**
1. Create `src/proxy/http-helpers.ts` exporting `readBody`, `jsonResponse`, `errorResponse`.
2. Both `main.ts` and `internal-api.ts` import from it.

**Risk:** Low — trivial extraction.

---

## 6. Repeated `unref` timer guard pattern (7 occurrences)

**What:** The pattern `if (typeof timer === 'object' && 'unref' in timer) { timer.unref() }` appears 7 times across 5 files. `openai-stream.ts` already has a `unrefTimer()` helper (L20), but the other files don't use it.

**Where:**
- `src/proxy/cursor-session.ts:451,659,700`
- `src/proxy/internal-api.ts:58`
- `src/proxy/main.ts:526`
- `src/proxy-lifecycle.ts:213`
- `src/proxy/openai-stream.ts:20` (the existing helper)

**Why:** Boilerplate noise. In Node.js, `setInterval`/`setTimeout` always return objects with `.unref()` — the guard is defensive but redundant in practice. Either way, it should be in one place.

**How:**
1. Move `unrefTimer` from `openai-stream.ts` to a shared utility (e.g., `src/proxy/util.ts` or the proposed `http-helpers.ts`).
2. Replace all 7 inline guard patterns with the shared helper.

**Risk:** Low — mechanical replacement.

---

## 7. Duplicated `pushToken` function in `index.ts` and `proxy-lifecycle.ts`

**What:** Both `src/index.ts:90–100` and `src/proxy-lifecycle.ts:105–114` define their own `pushToken(port, accessToken)` function that POSTs to `/internal/token`. They're nearly identical.

**Where:**
- `src/index.ts:90`
- `src/proxy-lifecycle.ts:105`

**Why:** If the token push protocol changes (e.g., adding a session header), both must be updated. `index.ts` should delegate to `proxy-lifecycle.ts` for all proxy communication.

**How:**
1. Export `pushToken` from `proxy-lifecycle.ts`.
2. Remove the local `pushToken` from `index.ts` and import it.
3. Alternatively, add a `pushTokenToProxy(accessToken)` that uses the active connection's port internally.

**Risk:** Low — simple delegation.

---

## 8. `nativeToMcpRedirect` is 102 lines of repetitive if-chains

**What:** `nativeToMcpRedirect()` in `cursor-messages.ts:121–222` is a sequence of 8 `if (execCase === '...')` blocks that all follow the same pattern: extract args, build `NativeRedirectInfo` with `toolCallId`, `toolName`, `decodedArgs`, `nativeResultType`, `nativeArgs`.

**Where:** `src/proxy/cursor-messages.ts:121–222`

**Why:** Adding a new native tool redirect requires copy-pasting a block and modifying 5 fields. The pattern is regular enough to be data-driven.

**How:**
1. Define a redirect mapping table:
   ```ts
   const NATIVE_REDIRECTS: Record<string, (args: any) => Omit<NativeRedirectInfo, 'toolCallId'>> = {
     readArgs: (args) => ({
       toolName: 'read',
       decodedArgs: JSON.stringify({ filePath: args.path, ...}),
       nativeResultType: 'readResult',
       nativeArgs: { path: String(args.path ?? '') },
     }),
     // ...
   }
   ```
2. Replace the if-chain with `const handler = NATIVE_REDIRECTS[execCase]; if (handler) return { toolCallId, ...handler(args) }`.
3. Keep `deleteArgs` and `fetchArgs` (which have non-trivial shell command construction) as separate entries — they're still regular enough for the table.

**Risk:** Medium — the `any`-typed protobuf args make this somewhat fragile; each entry still needs individual verification.

---

## 9. `configureInternalApi` is called twice with mostly identical config in `main.ts`

**What:** `configureInternalApi()` is called at L464 with empty models and again at L484 with discovered models. The second call repeats the `initialToken`, `onShutdown` callback. This is not just duplication — it's a smell that the API doesn't support partial updates.

**Where:** `src/proxy/main.ts:464–491`

**Why:** If the shutdown callback changes, it must be updated in two places. The double-call pattern is confusing (why configure twice?).

**How:**
1. Add an `updateModels(models)` function to `internal-api.ts` that updates just the cached models.
2. Call `configureInternalApi` once (L464) with the initial token and shutdown callback.
3. After model discovery, call `updateModels(models)` instead of reconfiguring everything.
4. Alternatively, make `configureInternalApi` accept a partial options object and merge with existing config.

**Risk:** Low — `internal-api.ts` already has `cachedModels` as module-level state.

---

## 10. `handleInteractionQuery` uses string-typed response dispatch with no type safety

**What:** `handleInteractionQuery()` in `cursor-messages.ts:475–544` builds a `responseResult` as `{ case: string; value: unknown }` and then casts the whole thing with `as any` when constructing the `InteractionResponseSchema`. The 6 query type branches (webSearch, exaSearch, exaFetch, askQuestion, switchMode, createPlan) are all string-matched with no exhaustiveness checking.

**Where:** `src/proxy/cursor-messages.ts:475–544`

**Why:** A new query type won't cause a compile error — it silently falls through to the empty-response default. The `as any` casts defeat the type system entirely.

**How:**
1. Define a `QueryResponseBuilder` type map:
   ```ts
   const QUERY_HANDLERS: Record<string, (query: any, onNotify?: (t: string) => void) => { case: string; value: unknown }> = {
     webSearchRequestQuery: (query, onNotify) => { ... },
     // ...
   }
   ```
2. Use `QUERY_HANDLERS[queryCase]?.(query, onNotify)` to get the response.
3. This won't fully eliminate `as any` (protobuf discriminated unions force it), but it consolidates the pattern and makes adding new query types less error-prone.
4. Add a comment near the file-level `oxlint-disable` explaining why `any` is necessary for protobuf dispatch specifically, and that the disable scope should not be broadened.

**Risk:** Low — the `as any` is inherent to protobuf's generated types; the refactoring improves structure without changing behavior.

---

## Summary

| # | Refactoring | Files | Impact | Risk |
|---|---|---|---|---|
| 1 | Split `proxy/main.ts` God Module | main.ts → +cursor-request.ts, request-context.ts, openai-stream.ts | High | Medium |
| 2 | Deduplicate `sendExecStreamClose` | cursor-session.ts, cursor-messages.ts → +cursor-framing.ts | Medium | Low |
| 3 | Co-locate native tool result logic | cursor-session.ts → +exec-results.ts or cursor-messages.ts | Medium | Low |
| 4 | Context object for `processServerMessage` | cursor-messages.ts, cursor-session.ts | Medium | Low |
| 5 | Extract shared HTTP helpers | main.ts, internal-api.ts → +http-helpers.ts | Low-Med | Low |
| 6 | Unify `unrefTimer` pattern | 5 files → shared util | Low | Low |
| 7 | Deduplicate `pushToken` | index.ts, proxy-lifecycle.ts | Low | Low |
| 8 | Data-driven `nativeToMcpRedirect` | cursor-messages.ts | Medium | Medium |
| 9 | Fix double `configureInternalApi` | main.ts, internal-api.ts | Low | Low |
| 10 | Structured query response dispatch | cursor-messages.ts | Low-Med | Low |

### Recommended execution order
1. **#5 + #6 + #7** — Low-risk deduplication, warmup
2. **#2 + #3** — Frame/result logic consolidation
3. **#4** — Signature cleanup (prepares for #1)
4. **#1** — Main decomposition (biggest impact)
5. **#8 + #9 + #10** — Final cleanup passes
