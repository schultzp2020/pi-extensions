---
'@schultzp2020/pi-cursor': patch
---

fix: retain checkpoint-referenced blobs and recover from locally observed blob misses

Blob Stores now retain all entries for the conversation lifetime because the
Cursor protocol exposes no reachability map for safe checkpoint-aware eviction.
This prevents the former 128-entry cap from poisoning persisted checkpoints,
at the tradeoff of disk usage growing with long conversations until an explicit
conversation reset.

When a Bridge observes a `GetBlob` miss and then receives an otherwise generic
terminal error, it now uses the existing `blob_not_found` reset-and-retry path.
The miss signal is scoped to that Bridge so unrelated later failures are not
misclassified.
