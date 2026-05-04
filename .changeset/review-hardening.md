---
'@schultzp2020/pi-cursor': minor
---

### New Features

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
