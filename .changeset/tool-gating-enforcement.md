---
'@schultzp2020/pi-cursor': minor
---

Enforce tool gating across all Cursor proxy surfaces

- Gate MCP passthrough, native tool redirects, and interaction queries against Pi's enabled tool set so disabled tools fail closed instead of bypassing session tool registration.
- Reject Cursor-internal web search and exa queries unconditionally (no Pi tool equivalent).
- Add `buildEnabledToolSet` helper and `enabledToolNames` to `MessageProcessorContext`.
- Replace `any` casts with typed protobuf discriminated union narrowing in `nativeToMcpRedirect`, `handleInteractionUpdate`, and `handleInteractionQuery`.
- Extract `REDIRECTABLE_EXEC_CASES` shared constant to prevent classification/redirect list drift.
- Refactor `handleExecMessage` from positional params to `ExecContext` object.
