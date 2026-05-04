# PRD: Proxy Architecture Deepening

## Problem Statement

The pi-cursor Proxy has grown organically into an architecture where `main.ts` (955 lines) acts as a god module orchestrating 8+ internal modules, session tracking is split across two shallow modules that callers must manually coordinate, and the message processing layer carries a 12-field context bag because it conflates text streaming with tool dispatch. This makes the Proxy difficult to test (the core request handling path has zero test coverage), difficult to modify (changes to retry behavior require understanding conversation state, Bridge lifecycle, and streaming simultaneously), and difficult for new contributors to navigate (understanding one concept requires bouncing between many small modules with leaking seams).

## Solution

Deepen the Proxy's architecture by restructuring into three new modules — Session State, Request Lifecycle, and Tool Dispatch — that each concentrate a significant amount of behavior behind a small, testable interface. The refactoring preserves all existing behavior and external contracts (HTTP API, Stdout Protocol, Internal API, Port File) while dramatically improving locality (where bugs and changes concentrate), leverage (what callers get per unit of interface), and testability (what can be verified through the module's interface alone).

## User Stories

1. As a contributor fixing a retry bug, I want retry logic, Checkpoint recovery, and Bridge recreation to live in one module, so that I don't need to read 5 files to understand the retry path.
2. As a contributor adding a new Native Tools Mode, I want tool dispatch policy to live in one module separate from text streaming, so that I can modify tool routing without risking regressions in message processing.
3. As a contributor debugging a Checkpoint Lineage mismatch, I want Session State management (Bridge tracking, conversation state, lineage validation, disk persistence) behind one interface, so that I can trace the full lifecycle without coordinating two separate modules.
4. As a test author, I want to test the Request Lifecycle (request parsing → conversation resolution → protobuf construction → retry → response → Checkpoint commit) without starting an HTTP server, so that I can write fast, focused tests for the core request path.
5. As a test author, I want to test tool dispatch routing (given a Native Tools Mode and an exec message, verify the correct action) without assembling a 12-field context bag, so that tests are focused and readable.
6. As a test author, I want to test Session State operations (resolve, register, commit, cleanup, evict) as a unit, so that I can verify the asymmetric lifetime behavior (Bridge is ephemeral, conversation is persistent) in isolation.
7. As a contributor, I want `main.ts` to be a thin startup + routing module (~200 lines), so that I can understand the Proxy's entry point in one screen.
8. As a contributor adding a new Cursor server message type, I want the message processor to have a focused context (6 fields for streaming/KV/checkpoint), so that I don't need to understand tool dispatch to add a new streaming message handler.
9. As a contributor, I want Proxy Context (access token, model set, config) to be a named, typed structure injected into each request, so that shared state is explicit rather than captured via closure.
10. As a contributor, I want the request builder (protobuf assembly from OpenAI messages) to be testable in isolation, so that protocol translation changes can be verified without a running Proxy.
11. As a contributor modifying session cleanup behavior, I want one module that owns both Bridge cleanup and conversation state persistence, so that I can reason about what `cleanup(sessionId)` does without checking two modules.
12. As a contributor, I want conversation state key derivation to be internal to the Session State module, so that callers pass a raw Session ID and never see derived hash keys.
13. As a contributor, I want TTL eviction of sessions to be a single call that handles both Bridge and conversation state with correct asymmetric behavior, so that `main.ts` doesn't manually coordinate two eviction sweeps.
14. As a contributor reading the codebase for the first time, I want module names that match the domain glossary in CONTEXT.md (Session State, Request Lifecycle, Tool Dispatch, Proxy Context), so that navigation is self-documenting.

## Implementation Decisions

### Module structure

Three new modules replace the current arrangement:

**Session State module** — merges the current session-manager and conversation-state modules into a single deep module. Manages the active Bridge (ephemeral, per-turn) and Conversation State (Checkpoint, Blob Store, Checkpoint Lineage — persistent across turns and Proxy restarts) as a unit, keyed by a single key derived internally from the Session ID. Callers pass the raw Session ID and never see derived keys.

Interface:

- `resolveSession(sessionId, history)` → `{conversation, activeBridge?}` — loads from cache or disk, validates Checkpoint Lineage, resets on mismatch
- `registerBridge(sessionId, bridge)` — stores the active Bridge for a turn
- `commitTurn(sessionId, checkpoint, lineage)` — persists Checkpoint and Lineage after successful turn completion
- `cleanup(sessionId)` — closes Bridge without evicting conversation (for session switch/shutdown)
- `evict()` — TTL-based sweep that removes both Bridge and conversation state
- `invalidateSession(sessionId)` — removes from in-memory cache
- `closeAll()` — shutdown helper

Lifetime asymmetry: evicting a conversation also closes its Bridge (a Bridge without conversation state is useless). Closing a Bridge does NOT evict its conversation (the conversation persists for future turns).

**Request Lifecycle module** — extracts the `handleChatCompletion` path from `main.ts`. Owns the full lifecycle of a single `/v1/chat/completions` request: parse request body → resolve model → parse messages → resolve Session State → validate Checkpoint Lineage → build protobuf `RunRequest` → create Bridge → retry on transient failures → stream or collect response → commit Checkpoint and Lineage.

The request builder (protobuf `RunRequest` assembly from OpenAI messages, including `foldTurnsIntoSystemPrompt`) is an internal seam — used by the lifecycle module but not exposed to callers.

Single entry point: `handleChatCompletion(req, res, ctx: ProxyContext)`.

Proxy Context is a typed structure carrying stable per-Proxy state: access token (or getter), normalized model set, conversation directory, global Cursor Config (Native Tools Mode, Max Mode, max retries), and Debug Logger functions.

**Tool Dispatch module** — extracts tool-related message handling from cursor-messages. Owns three message cases from the server: exec messages (classify → reject/redirect/execute via native-tools), interaction queries (web search, exa, ask question — all rejected), and exec control messages (abort).

Interface: `handleToolMessage(msg, ctx: ToolDispatchContext) → boolean` — returns true if the message was a tool-related type it handled.

`ToolDispatchContext` is focused: `sendFrame`, `mcpTools`, `enabledToolNames`, `cloudRule`, `nativeToolsMode`, `allowedRoot`, `onMcpExec`, `state`.

The message processor's `MessageProcessorContext` shrinks to 6 fields: `blobStore`, `sendFrame`, `state`, `onText`, `onCheckpoint`, `onNotify`. It delegates to Tool Dispatch for exec/query cases.

Tool Dispatch wraps native-tools (calls `classifyExecMessage`, `executeNativeLocally`, etc.) but does not absorb it. native-tools keeps its current interface and tests unchanged.

### What stays in main.ts

After extraction, main.ts (~200 lines) keeps only:

- Startup sequence: read config from stdin, discover models, start HTTP server, write ready signal to stdout
- HTTP routing: thin dispatcher delegating each route to its handler
- Model management: discovery, caching, normalized model set
- Internal API delegation (already factored into internal-api.ts)

### Modules that do NOT change

- `cursor-session.ts` — Bridge implementation, unchanged
- `native-tools.ts` — native tool execution and classification, unchanged (Tool Dispatch wraps it)
- `openai-stream.ts` — SSE stream writer, unchanged
- `openai-messages.ts` — OpenAI message parsing, unchanged
- `model-normalization.ts` — model collapsing and effort mapping, unchanged
- `config.ts` — Cursor Config loading, unchanged
- `connect-protocol.ts` — Connect framing, unchanged
- `event-queue.ts` — async event queue, unchanged
- `thinking-filter.ts` — thinking tag filter, unchanged
- `debug-logger.ts` — structured debug logging, unchanged
- `internal-api.ts` — Internal API handlers, updated only to import `cleanup` from Session State instead of session-manager
- `index.ts` — extension entry point, unchanged
- `proxy-lifecycle.ts` — proxy spawn/reconnect, unchanged

### Deleted modules

- `session-manager.ts` — absorbed entirely into Session State
- `conversation-state.ts` — absorbed entirely into Session State

### ADR compliance

- ADR-0001 (standalone proxy architecture): unchanged — the Proxy remains a standalone process
- ADR-0002 (proxy handles transient retries): the retry loop moves into Request Lifecycle, which is still inside the Proxy — the responsibility assignment is preserved
- ADR-0003 (shared proxy with HTTP internal API): unchanged — Internal API contract preserved
- ADR-0004 (session identity from Pi session ID): Session State continues to key everything from the Pi Session ID
- ADR-0005 (native tools mode policy): Tool Dispatch preserves the three-mode policy
- ADR-0006 (model normalization): unchanged
- ADR-0007 (global cursor config): Proxy Context carries config — same resolution order
- ADR-0008 (checkpoint lineage): Session State preserves lineage validation on every request

### Build order

The implementation has two independent tracks:

Track A (sequential):

1. Session State module — merge session-manager + conversation-state, update imports in main.ts and internal-api.ts
2. Request Lifecycle module — extract from main.ts, consume Session State, introduce Proxy Context type

Track B (independent of Track A): 3. Tool Dispatch module — extract from cursor-messages.ts, update imports in cursor-session.ts

Steps 1 and 3 are independent and can be done in parallel. Step 2 depends on Step 1.

## Testing Decisions

### What makes a good test

Tests should verify behavior through the module's external interface, not its internal implementation. A test that breaks when you rename a private function or restructure internals is testing the wrong thing. Tests should express domain-level expectations: "given a stale Checkpoint Lineage, the session is reset" — not "the SHA256 hash of the first message equals X."

### Modules to test

**Session State** (`session-state.test.ts`):

- Resolve returns fresh conversation when no state exists
- Resolve loads from disk when not in cache
- Resolve validates Checkpoint Lineage and resets on mismatch
- `registerBridge` stores and `resolveSession` returns the active Bridge
- `commitTurn` persists Checkpoint and Lineage to disk (verify via re-resolve after cache eviction)
- `cleanup` closes Bridge but conversation survives re-resolve
- `evict` removes stale entries by TTL; evicting conversation also closes Bridge
- Single key derivation — callers pass Session ID, never see internal keys

Prior art: `conversation-state.test.ts` (283 lines) and `session-manager.test.ts` (43 lines) — these merge into the new test file and expand.

**Request Lifecycle** (`request-lifecycle.test.ts`):

- Retry behavior: mock Bridge returns `blob_not_found` on first attempt, succeeds on second — verify retry with backoff
- Lineage invalidation: stale lineage → Checkpoint discarded, conversation reset, fresh Bridge created
- Checkpoint commit: successful turn → Checkpoint and Lineage persisted via Session State
- Streaming vs non-streaming: `stream: true` produces SSE chunks; `stream: false` produces JSON response
- Request building: known OpenAI messages produce expected protobuf structure (test via internal export or integration)
- System prompt folding: `foldTurnsIntoSystemPrompt` truncation behavior (already covered in `request-builder.test.ts`, migrates here)

Prior art: `request-builder.test.ts` (133 lines) — migrates into the new test file.

**Tool Dispatch** (`tool-dispatch.test.ts`):

- Exec routing by mode: `reject` → rejection response, `redirect` → MCP redirect emitted, `native` → native execution delegated
- Interaction query rejection: web search, exa search, exa fetch, ask question — all produce rejection responses
- Unknown exec type: best-effort empty result with field number mirroring
- Exec control abort: handled without error
- Tool Gating integration: unenabled tools rejected regardless of mode
- Context is focused: only 8 fields needed, not 12

Prior art: `tool-gating.test.ts` (611 lines) and `native-tools.test.ts` (309 lines) — these remain unchanged, testing native-tools directly. The new test file covers the dispatch routing layer above them.

### Tests that must NOT break

All existing test files for unchanged modules must continue to pass:

- `model-normalization.test.ts` (499 lines)
- `openai-messages.test.ts` (378 lines)
- `native-tools.test.ts` (309 lines)
- `tool-gating.test.ts` (611 lines)
- `config.test.ts` (296 lines)
- `connect-protocol.test.ts` (108 lines)
- `event-queue.test.ts` (53 lines)
- `thinking-filter.test.ts` (48 lines)
- `proto-smoke.test.ts` (14 lines)

## Out of Scope

- **Changing the Proxy's external HTTP API** — all routes (`/v1/models`, `/v1/chat/completions`, `/internal/*`) remain identical. No client-visible changes.
- **Changing the Stdout Protocol** — startup handshake between extension and Proxy is unchanged.
- **Changing the Port File format** — discovery mechanism is unchanged.
- **Changing `cursor-session.ts` (Bridge implementation)** — the H2 connection management, protobuf framing, heartbeat, and batch state machine are not touched.
- **Changing `native-tools.ts`** — native tool execution and classification are unchanged. Tool Dispatch wraps it without modifying its interface.
- **Changing the extension side (`index.ts`, `proxy-lifecycle.ts`, `auth.ts`)** — all extension-side code is unchanged.
- **New features** — this is a pure refactoring. No new capabilities, no new settings, no new message types.
- **Tool result formatting consolidation** — initially considered (candidate 4), but dropped because the three sites constructing protobuf results have fundamentally different input shapes, making a shared formatter shallow.
- **Performance optimization** — the refactoring should be performance-neutral. No hot paths are changed in substance.

## Further Notes

- The CONTEXT.md domain glossary has been updated with four new terms: **Session State**, **Tool Dispatch**, **Request Lifecycle**, and **Proxy Context**. These should be used consistently in code comments, commit messages, and documentation.
- The implementation is a pure refactoring — every commit should pass the full test suite. If a step introduces a failing test, it's a bug in the refactoring, not an expected intermediate state.
- The two tracks (A and B) are independent, so they can be implemented by different contributors or in parallel worktrees without merge conflicts, as long as Track A step 1 (Session State) lands before step 2 (Request Lifecycle).
- After this refactoring, `main.ts` drops from 955 to ~200 lines. The total line count stays roughly constant — depth increases, not code volume.
