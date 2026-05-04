# Checkpoint lineage metadata for fork and compaction safety

The proxy stores lightweight lineage metadata alongside the latest committed checkpoint: completed turn count and a SHA256 fingerprint of the completed structured history. On every request, the proxy validates this lineage against the incoming message history and discards the checkpoint on mismatch.

## Problem

Checkpoints become stale when:

- The user navigates back in Pi's session tree and forks from an earlier point
- Pi compacts the conversation (replaces history with a summary)
- The user uses `/tree` to switch branches
- The proxy restarts and receives history that has diverged from the stored checkpoint

Without lineage validation, the proxy reuses a stale checkpoint, causing Cursor to see inconsistent conversation state — producing garbled responses or errors.

## Design

- **Completed turn count** — number of fully completed conversation turns at checkpoint commit time.
- **Completed history fingerprint** — SHA256 of the serialized completed turns at checkpoint commit time.

Mismatch detection:

1. If incoming turn count ≠ stored turn count → discard checkpoint
2. If incoming turn count matches but fingerprint differs (same-depth fork) → discard checkpoint
3. On discard → reconstruct structured protobuf turns from the message history Pi sends

## Checkpoint commit rules

- Checkpoints are only committed after a turn completes successfully.
- On client disconnect or interruption, the pending checkpoint is discarded and the previous committed checkpoint is preserved.
- An explicit `CancelAction` protobuf is sent to Cursor on disconnect.

## Consequences

- Session compaction works correctly: stable session ID finds the state, lineage detects the history change, checkpoint is discarded, turns are reconstructed from compacted history.
- Fork navigation works correctly: same mechanism detects branch divergence.
- Slight overhead for fingerprint computation per request — negligible vs. network latency.
