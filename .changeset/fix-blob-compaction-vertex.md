---
'@schultzp2020/pi-cursor': patch
---

fix: preserve blob store across compaction and skip pi_session_id for non-cursor providers

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
