---
'@schultzp2020/pi-cursor': patch
---

Retry transient Cursor connection failures instead of surfacing a hard error.

Abnormal terminal conditions — a dropped HTTP/2 connection (`bridge connection
lost`) and an abnormal session close before any terminal event (`session
closed`) — now carry a `transient` retry hint, so the request lifecycle rebuilds
a fresh session and retries (bounded by `maxRetries`) rather than emitting
`[Error: session closed]` / `[Error: bridge connection lost]` to the caller. A
Connect `not_found` code from the Agent RPC is also classified as
`blob_not_found` so the conversation is reset and rebuilt without the stale
checkpoint before retrying. Mid-tool-call closes are still treated as
non-retryable to avoid re-running tools, and genuine client disconnects
short-circuit because the SSE context is already closed.
