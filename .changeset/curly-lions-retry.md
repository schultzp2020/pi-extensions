---
'@schultzp2020/pi-cursor': patch
---

fix(pi-cursor): retry on Cursor `not_found` Connect errors instead of failing

A `not_found` Connect code from the Agent RPC means the server can no longer
find the referenced conversation/checkpoint state (the same class of failure as
`blob not found`). Previously this surfaced immediately as a hard
`[Error: Connect error not_found: ...]` with no retry, so a stale checkpoint
would break the turn. It is now classified as `blob_not_found` so the
conversation is reset and rebuilt without the stale checkpoint before retrying.
