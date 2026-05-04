# Issues: Proxy Architecture Deepening

## Issue 1: Session State module — merge session-manager + conversation-state into a unified deep module

### Parent

PRD: Proxy Architecture Deepening (`docs/prd-proxy-architecture-deepening.md`)

### What to build

Merge `session-manager.ts` (75 lines, shallow — fails the deletion test) and `conversation-state.ts` (251 lines) into a single **Session State** module that manages the active Bridge and Conversation State (Checkpoint, Blob Store, Checkpoint Lineage) as a unit, keyed by Session ID.

Callers pass the raw Session ID. Key derivation is internal — the two separate derived keys (`deriveSessionKey`, `deriveConversationKey`) collapse into a single internal key. The module owns the asymmetric lifetime behavior: evicting a conversation also closes its Bridge; closing a Bridge (cleanup) does NOT evict its conversation.

Interface:

- `resolveSession(sessionId, history)` → `{conversation, activeBridge?}` — load from cache/disk, validate Checkpoint Lineage, reset on mismatch
- `registerBridge(sessionId, bridge)` — store the active Bridge for a turn
- `commitTurn(sessionId, checkpoint, lineage)` — persist Checkpoint and Lineage after successful turn
- `cleanup(sessionId)` — close Bridge without evicting conversation (for session switch/shutdown)
- `evict()` — TTL-based sweep removing both Bridge and conversation
- `invalidateSession(sessionId)` — remove from in-memory cache
- `closeAll()` — shutdown helper

Update `main.ts` to replace all imports from both old modules with imports from `session-state.ts` and simplify the manual coordination logic in `handleChatCompletion`. Update `internal-api.ts` to import `cleanup` from Session State instead of `cleanupSessionById` from session-manager. Merge `session-manager.test.ts` and `conversation-state.test.ts` into `session-state.test.ts`, expanding coverage for the unified interface. Delete both old source files.

### Acceptance criteria

- [ ] `session-state.ts` exists and exports `resolveSession`, `registerBridge`, `commitTurn`, `cleanup`, `evict`, `invalidateSession`, `closeAll`
- [ ] `session-manager.ts` is deleted
- [ ] `conversation-state.ts` is deleted
- [ ] Callers pass raw Session ID — no `deriveSessionKey` or `deriveConversationKey` in any import outside `session-state.ts`
- [ ] `main.ts` imports only from `session-state.ts` for session and conversation operations
- [ ] `internal-api.ts` imports `cleanup` from `session-state.ts`
- [ ] `session-state.test.ts` covers: fresh resolve, disk reload, lineage validation + reset, Bridge registration + retrieval, `commitTurn` persistence (verify via re-resolve after cache eviction), `cleanup` closes Bridge but conversation survives, `evict` removes stale entries and closing conversation also closes Bridge
- [ ] All existing tests pass (`npm test` green)
- [ ] No behavior changes — all external contracts (HTTP API, Internal API) are preserved

### Blocked by

None — can start immediately.

---

## Issue 2: Tool Dispatch module — extract tool routing from cursor-messages into a focused module

### Parent

PRD: Proxy Architecture Deepening (`docs/prd-proxy-architecture-deepening.md`)

### What to build

Extract tool-related message handling from `cursor-messages.ts` (773 lines) into a **Tool Dispatch** module. The new module owns three server message cases: `execServerMessage` (classify → reject/redirect/execute via native-tools), `interactionQuery` (web search, exa, ask question — all rejected), and `execServerControlMessage` (abort). It wraps `native-tools.ts` for execution without modifying native-tools' interface.

Tool Dispatch exports a single entry point: `handleToolMessage(msg, ctx: ToolDispatchContext) → boolean` — returns true if the message was a tool-related type it handled.

`ToolDispatchContext` is focused (8 fields): `sendFrame`, `mcpTools`, `enabledToolNames`, `cloudRule`, `nativeToolsMode`, `allowedRoot`, `onMcpExec`, `state`.

`cursor-messages.ts` shrinks to ~350 lines, keeping: `processServerMessage` (now delegates to Tool Dispatch for exec/query/control cases), `handleInteractionUpdate`, `handleKvMessage`, `createStreamState`, and `StreamState` type. Its `MessageProcessorContext` shrinks to 6 fields: `blobStore`, `sendFrame`, `state`, `onText`, `onCheckpoint`, `onNotify`. The message processor calls `handleToolMessage` first; if not handled, it processes the remaining cases itself.

Functions that move to Tool Dispatch: `handleExecMessage`, `handleInteractionQuery`, `sendExecResult`, `sendMcpResult`, `sendUnknownExecResult`, and all interaction query rejection logic (web search, exa search, exa fetch, ask question, switch mode, create plan).

`native-tools.ts` is unchanged — Tool Dispatch imports from it (`classifyExecMessage`, `executeNativeLocally`, `fixMcpArgNames`, `stripMcpToolPrefix`).

### Acceptance criteria

- [ ] `tool-dispatch.ts` exists and exports `handleToolMessage` and `ToolDispatchContext` type
- [ ] `cursor-messages.ts` no longer contains `handleExecMessage`, `handleInteractionQuery`, `sendExecResult`, `sendMcpResult`, `sendUnknownExecResult`, or interaction query rejection logic
- [ ] `cursor-messages.ts` `MessageProcessorContext` has 6 fields (down from 12), plus a `toolDispatch` delegate or equivalent integration
- [ ] `processServerMessage` delegates exec/query/control cases to `handleToolMessage`
- [ ] `native-tools.ts` is unchanged (no added/removed exports, no interface changes)
- [ ] `tool-dispatch.test.ts` covers: exec routing by mode (`reject` → rejection, `redirect` → MCP redirect emitted, `native` → native execution delegated), interaction query rejection for all query types, unknown exec type handling, exec control abort, unenabled tool rejection via Tool Gating
- [ ] All existing tests pass — specifically `tool-gating.test.ts`, `native-tools.test.ts`, `connect-protocol.test.ts` are unmodified and green
- [ ] No behavior changes — all tool dispatch behavior is preserved exactly

### Blocked by

None — can start immediately (independent of Issue 1).

---

## Issue 3: Request Lifecycle module — extract request handling from main.ts, introduce Proxy Context

### Parent

PRD: Proxy Architecture Deepening (`docs/prd-proxy-architecture-deepening.md`)

### What to build

Extract the `handleChatCompletion` path from `main.ts` (955 lines) into a **Request Lifecycle** module. The new module owns the full lifecycle of a single `/v1/chat/completions` request: parse request body → resolve model → parse messages → resolve Session State → validate Checkpoint Lineage → build protobuf `RunRequest` → create Bridge → retry on transient failures → stream or collect response → commit Checkpoint and Lineage.

Single deep entry point: `handleChatCompletion(req, res, ctx: ProxyContext)`.

**Proxy Context** is a new typed structure carrying stable per-Proxy state injected into each request:

- Access token (or getter)
- Normalized model set (getter: `getNormalizedSet()`)
- Conversation directory
- Global Cursor Config (Native Tools Mode, Max Mode, max retries)
- Debug Logger functions

The request builder (`buildRunRequest` and `foldTurnsIntoSystemPrompt`) moves into the Request Lifecycle module as an **internal seam** — used internally, not part of the module's external interface. Exported only for testing (e.g., `export { buildRunRequest, foldTurnsIntoSystemPrompt }`).

The Request Lifecycle module consumes the Session State module (Issue 1) directly:

- `resolveSession(sessionId, history)` to load conversation + active Bridge
- `registerBridge(sessionId, bridge)` after creating a new Bridge
- `commitTurn(sessionId, checkpoint, lineage)` after successful turn completion

After extraction, `main.ts` shrinks to ~200 lines keeping only: startup sequence (stdin config, model discovery, HTTP server creation, ready signal), HTTP routing (thin delegation), model management (discovery, caching, `getNormalizedSet()`), and Internal API delegation.

`request-builder.test.ts` retargets its imports to the Request Lifecycle module.

### Acceptance criteria

- [ ] `request-lifecycle.ts` exists and exports `handleChatCompletion` and `ProxyContext` type
- [ ] `main.ts` is ~200 lines — contains only startup, HTTP routing, model management, and Internal API delegation
- [ ] `main.ts` constructs a `ProxyContext` and delegates `/v1/chat/completions` to `handleChatCompletion`
- [ ] `handleChatCompletion` no longer lives in `main.ts`
- [ ] `buildRunRequest` and `foldTurnsIntoSystemPrompt` live in `request-lifecycle.ts` (internal, exported for testing)
- [ ] Request Lifecycle consumes Session State (`resolveSession`, `registerBridge`, `commitTurn`) — no direct imports from deleted session-manager or conversation-state
- [ ] `request-lifecycle.test.ts` covers: retry behavior (mock Bridge returns `blob_not_found` first, succeeds second — verify retry with backoff), lineage invalidation (stale lineage → Checkpoint discarded, conversation reset), Checkpoint commit (successful turn → persisted via Session State), streaming vs non-streaming response format
- [ ] `request-builder.test.ts` imports retargeted to `request-lifecycle.ts` and passes
- [ ] All existing tests pass (`npm test` green)
- [ ] No behavior changes — HTTP API contract, retry behavior, Checkpoint commit timing, streaming format all preserved exactly

### Blocked by

- Issue 1: Session State module (Request Lifecycle consumes the Session State interface)
