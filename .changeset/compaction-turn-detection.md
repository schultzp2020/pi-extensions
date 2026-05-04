---
'@schultzp2020/pi-cursor': patch
---

Fix chat history contamination after compaction

After compaction or branch summary injection, the proxy's `foldTurnsIntoSystemPrompt` now
detects compaction/branch summary turns and wraps them in `<context>` XML tags instead of
labeling them as `User:` messages. This prevents the model from treating compaction summaries
as real user messages when reporting chat history.

- Added `isCompaction` field to `ParsedConversationTurn` with `startsWith` detection against
  pi-core's known `COMPACTION_SUMMARY_PREFIX` and `BRANCH_SUMMARY_PREFIX` markers
- Compaction turns are wrapped in `<context>...</context>` tags (assistant acknowledgments dropped)
- Regular turns keep the existing `User:` / `Assistant:` format
- Updated `buildCursorRequest` type signature to explicitly pass `isCompaction` through
- Truncation now prioritizes compaction turns — they are reserved first so pre-compaction
  context survives when the prompt exceeds the 100KB cap
