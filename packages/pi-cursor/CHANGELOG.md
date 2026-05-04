# @schultzp2020/pi-cursor

## 0.3.2

### Patch Changes

- [#19](https://github.com/schultzp2020/pi-extensions/pull/19) [`a043246`](https://github.com/schultzp2020/pi-extensions/commit/a043246ebd851bb5618f118a50681369d5a454b8) Thanks [@schultzp2020](https://github.com/schultzp2020)! - fix: resolve "Blob not found" errors after compaction by resetting conversation

  After Pi compaction, lineage validation detects a mismatch and must rebuild
  the conversation state. Cursor's server treats the `turns` field in
  `ConversationStateStructure` as blob references — not inline data. The old
  code rebuilt turns from scratch with inline protobuf bytes, which Cursor
  tried to look up as blob IDs, causing "Blob not found" errors.

  Changes:
  - `resetConversation()` (renamed from `discardCheckpoint`) now assigns a new
    conversation ID and clears the blob store, ensuring Cursor treats the next
    request as a brand-new conversation with empty turns.
  - `buildCursorRequest()` folds prior turns into the system prompt via
    `foldTurnsIntoSystemPrompt()` instead of building inline turn protos.
    A 100KB size cap truncates oldest turns when the combined prompt is too large.
  - Non-streaming retry path now surfaces `retryHint` from
    `collectNonStreamingResponse` and handles `blob_not_found` with conversation
    reset + request rebuild (mirrors the streaming retry path).
  - Streaming retry path relaxes the `stored?.checkpoint` guard so
    `resetConversation` is called unconditionally on `blob_not_found`.
  - Removed 4 dead proto imports no longer needed after the turn-building removal.
  - Added 9 new tests covering turn folding (truncation, edge cases) and
    conversation reset behavior.

## 0.3.1

### Patch Changes

- [#17](https://github.com/schultzp2020/pi-extensions/pull/17) [`60c9956`](https://github.com/schultzp2020/pi-extensions/commit/60c9956f8d480898cd6365b4c4791a33ea80b4a3) Thanks [@schultzp2020](https://github.com/schultzp2020)! - fix: preserve blob store across compaction and skip pi_session_id for non-cursor providers

  **Blob/compaction fix:**
  - Stop clearing `blobStore` on lineage invalidation (compaction, fork, branch switch). Cursor's server may still reference blobs by conversationId after a fresh rebuild, so clearing caused "Blob not found" errors after compaction.
  - Extract `discardCheckpoint()` helper in `conversation-state.ts` for the checkpoint-only invalidation pattern.
  - Add `pruneBlobs()` with LRU eviction at 128-blob cap to prevent unbounded growth across compaction cycles.
  - Fix `blob_not_found` retry to rebuild `requestBytes` without the stale checkpoint via a `rebuildWithoutCheckpoint` callback on `RetryContext`, so the retry actually recovers instead of resending the same broken request.
  - Remove no-op blob sync loop in `onCheckpoint` (shared Map reference made it a no-op).

  **Vertex provider fix:**
  - Only inject `pi_session_id` and `pi_cwd` into request body when `provider === 'cursor'`. Other providers (anthropic-vertex, openai, etc.) send requests directly to their API and reject unknown fields with `400 pi_session_id: Extra inputs are not permitted`.
  - Guard is fail-closed: if `ctx.model` is undefined, injection is skipped.

  **Diagnostics:**
  - Add `logLineageInvalidation()` debug event with turn counts and blob count.
  - Add `console.warn` on `GetBlob` cache miss with key prefix and store size.

## 0.3.0

### Minor Changes

- [#15](https://github.com/schultzp2020/pi-extensions/pull/15) [`2e6763b`](https://github.com/schultzp2020/pi-extensions/commit/2e6763bbb87d0e08bef217386de24850150058cb) Thanks [@schultzp2020](https://github.com/schultzp2020)! - ### New Features
  - **Global config system** (TP-003): File-based config at `~/.pi/agent/cursor-config.json` with per-field validation, env var overrides (`PI_CURSOR_*`), and `/cursor` settings command
  - **Session identity** (TP-004): Inject `pi_session_id` via `before_provider_request` for stable session tracking across compaction
  - **Image bridging** (TP-005): Preserve image content parts in OpenAI message parsing
  - **Model normalization** (TP-006): Collapse Cursor's effort/variant/maxMode model suffixes into deduplicated families with reasoning effort mapping
  - **Checkpoint lineage** (TP-007): SHA-256 fingerprint validation to detect conversation forks and discard stale checkpoints
  - **Retry execution** (TP-008): Configurable retry loop for `blob_not_found`, `resource_exhausted`, and `timeout` errors with jitter
  - **Native tools mode** (TP-009): Three-mode tool dispatch (`reject`, `redirect`, `native`) with proxy-local shell/read/write/delete/grep/fetch execution
  - **Cursor settings command** (TP-010): Interactive `/cursor` command to configure native tools mode, max mode, model mappings, and max retries
  - **Debug logging** (TP-011): Structured JSONL debug logger gated behind `PI_CURSOR_PROVIDER_DEBUG=1` with 50MB log rotation

  ### Security Hardening
  - Bind proxy to `127.0.0.1` only (was `0.0.0.0`)
  - Shell: 60s timeout, 2MB output cap, kill on cap, sanitized environment variables
  - Grep: 60s timeout, 2MB output cap, sanitized env
  - Fetch: SSRF protection (block private/IPv6-mapped IPs, disable redirects), 30s timeout, 10MB response cap
  - Proper `DeleteErrorSchema` on path traversal violations
  - Cap `maxRetries` at 10
  - Restrictive file permissions (`0o700` dirs, `0o600` files) on conversation state and debug logs
  - Cleanup fetch uses `AbortSignal.timeout(2000)` to prevent blocking lifecycle hooks

  ### Reliability
  - Fix event listener accumulation on retries
  - Add retry jitter (0–50%) to prevent thundering herd
  - Wire `invalidateNormalizedModels` into model refresh callback
  - Call `logRetry()` in both streaming and non-streaming retry paths

  ### Breaking Changes
  - `deriveSessionKey` / `deriveConversationKey` no longer accept a `messages` parameter
  - `MODEL_LIMITS` hardcoded table removed (API provides real values)
  - Fallback models updated to latest generation only (11 models)
  - `activeSessions` renamed to `heartbeatClients` in internal-api
  - Several debug logger functions removed (`logCheckpointDiscard`, `logToolCall`, `logBridgeOpen`, `logBridgeClose`, `isDebugEnabled`)
  - `shouldDiscardCheckpoint` removed from conversation-state exports
  - `DebugLogEntry`, `DebugEventType` types no longer exported

## 0.2.0

### Minor Changes

- [#10](https://github.com/schultzp2020/pi-extensions/pull/10) [`f33a422`](https://github.com/schultzp2020/pi-extensions/commit/f33a422fde84d292c8010547b19c83f313c49984) Thanks [@schultzp2020](https://github.com/schultzp2020)! - Enforce tool gating across all Cursor proxy surfaces
  - Gate MCP passthrough, native tool redirects, and interaction queries against Pi's enabled tool set so disabled tools fail closed instead of bypassing session tool registration.
  - Reject Cursor-internal web search and exa queries unconditionally (no Pi tool equivalent).
  - Add `buildEnabledToolSet` helper and `enabledToolNames` to `MessageProcessorContext`.
  - Replace `any` casts with typed protobuf discriminated union narrowing in `nativeToMcpRedirect`, `handleInteractionUpdate`, and `handleInteractionQuery`.
  - Extract `REDIRECTABLE_EXEC_CASES` shared constant to prevent classification/redirect list drift.
  - Refactor `handleExecMessage` from positional params to `ExecContext` object.

## 0.1.4

### Patch Changes

- [#8](https://github.com/schultzp2020/pi-extensions/pull/8) [`5694cc1`](https://github.com/schultzp2020/pi-extensions/commit/5694cc1dbb60f706d0777581157fa232929b7f53) Thanks [@schultzp2020](https://github.com/schultzp2020)! - Fix native tool argument mapping for Pi MCP tools

  Several native Cursor tool redirects sent incorrect arguments to Pi's MCP tools, causing validation failures:
  - **`readArgs`/`writeArgs`**: Sent `filePath` instead of `path`, causing `Validation failed for tool "read": path: must have required properties path`
  - **`lsArgs`**: Redirected to nonexistent `glob` tool instead of Pi's `ls` tool
  - **`deleteArgs`/`fetchArgs`**: Sent extra `description` parameter not in `bash` tool schema
  - **`fixMcpArgNames`**: Converted `path` → `filePath` (backwards) — now correctly converts `filePath` → `path` and covers all Pi tools with a `path` parameter (`read`, `write`, `edit`, `grep`, `find`, `ls`)

## 0.1.3

### Patch Changes

- [#6](https://github.com/schultzp2020/pi-extensions/pull/6) [`2a1414a`](https://github.com/schultzp2020/pi-extensions/commit/2a1414aa4e5197cf540ec97ffce36f547a39fcc6) Thanks [@schultzp2020](https://github.com/schultzp2020)! - Fix duplicate model discovery on proxy startup

  When connecting to an existing proxy, `connectToProxy` called `/internal/refresh-models` which triggered a full `discoverCursorModels()` round-trip to Cursor's API — even though the proxy already had fresh models cached from startup. This caused the `Discovered N models via AvailableModels` log to appear twice.

  Added a `GET /internal/models` endpoint that returns cached models without re-discovering, and switched `connectToProxy` to use it. The `/internal/refresh-models` POST endpoint is preserved for explicit refresh scenarios.

## 0.1.2

### Patch Changes

- [#4](https://github.com/schultzp2020/pi-extensions/pull/4) [`8e4b481`](https://github.com/schultzp2020/pi-extensions/commit/8e4b4811a2f2ac65dd4f44dc491730fb6b7b7b38) Thanks [@schultzp2020](https://github.com/schultzp2020)! - Updated README login instructions: clarified provider dropdown selection, simplified install command, and added Windows note about console window during OAuth.

## 0.1.1

### Patch Changes

- [#2](https://github.com/schultzp2020/pi-extensions/pull/2) [`93092ee`](https://github.com/schultzp2020/pi-extensions/commit/93092eed7d8f4f56b0d169c5a2cec47ecda6ba06) Thanks [@schultzp2020](https://github.com/schultzp2020)! - Fix npm install command in README to use scoped package name.
