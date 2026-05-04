---
'@schultzp2020/pi-cursor': patch
---

fix: resolve "Blob not found" errors after compaction by resetting conversation

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
