---
'@schultzp2020/pi-cursor': minor
---

Decompose monolithic proxy into focused modules for better maintainability and testability.

### New modules

- **session-state.ts** — Bridge and conversation lifecycle, checkpoint persistence, lineage validation, TTL-based eviction. Replaces `session-manager.ts` and `conversation-state.ts`.
- **tool-dispatch.ts** — Cursor exec message routing (reject/redirect/native), interaction query rejection, MCP tool gating. Extracted from `cursor-messages.ts`.
- **request-lifecycle.ts** — Full `/v1/chat/completions` request orchestration: parse → model resolve → session resolve → build protobuf → stream/collect → retry → commit. Extracted from `main.ts`.

### Changes

- `main.ts` slimmed from ~950 lines to ~200 lines (startup, HTTP routing, model cache)
- `cursor-messages.ts` reduced to text streaming, KV blobs, and checkpoint handling
- Dependency graph is strictly acyclic with clean module boundaries
- Shared `errorResponse` helper extracted to `http-helpers.ts`
- Backward-compatible conversation disk key derivation (`conv:` prefix preserved)
- 268 tests (up from ~180), all passing
