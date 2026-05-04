# Task: TP-002 - Gate tool calls against enabled set

**Created:** 2026-05-03
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** Adapts existing classify/reject patterns to enforce tool filtering across all proxy entry points. Touches tool access control but no auth/encryption.
**Score:** 3/8 — Blast radius: 1, Pattern novelty: 1, Security: 1, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-002-gate-tool-calls/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

The Cursor proxy has four unguarded surfaces where tool calls bypass the enabled
tool set that Pi explicitly provides in the `tools` array of each chat completion
request. When Pi sends a restricted tool set (e.g., only `read` and `edit`), the
model can still execute disabled tools through native exec redirects, MCP
passthrough without validation, auto-approved interaction queries, and silent
empty-result handling for unknown exec types.

Gate every tool call path so that only tools Pi explicitly enabled can execute.
The `tools` array Pi sends in the OpenAI request — already converted to
`mcpTools: McpToolDefinition[]` — becomes the single source of truth. No new
config surfaces or protocol changes needed.

## Dependencies

- **None**

## Context to Read First

**Tier 2 (area context):**

- `packages/pi-cursor/CONTEXT.md`

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/proxy/cursor-messages.ts`
- `packages/pi-cursor/src/proxy/cursor-session.ts`
- `packages/pi-cursor/src/proxy/native-tools.ts`
- `packages/pi-cursor/src/proxy/native-tools.test.ts`
- `packages/pi-cursor/src/proxy/tool-gating.test.ts`

## Steps

### Step 0: Preflight

- [ ] `packages/pi-cursor/src/proxy/cursor-messages.ts` exists and exports `MessageProcessorContext`, `handleExecMessage`, `processServerMessage`
- [ ] `packages/pi-cursor/src/proxy/cursor-session.ts` exists and constructs `MessageProcessorContext` with `mcpTools`
- [ ] `packages/pi-cursor/src/proxy/native-tools.ts` exists and exports `classifyExecMessage`, `stripMcpToolPrefix`
- [ ] Tests pass before changes: `cd packages/pi-cursor && npx vitest run`

### Step 1: Add enabled tool set to MessageProcessorContext

Add an `enabledToolNames: Set<string>` field to `MessageProcessorContext` in
`cursor-messages.ts`. Compute it once from the `mcpTools` array (stripping the
`mcp_pi_` prefix from each tool's `toolName` field).

In `cursor-session.ts`, populate `enabledToolNames` when constructing the
`MessageProcessorContext` inside `handleMessage()`. The set is derived from
`this.options.mcpTools`.

Add a helper function `buildEnabledToolSet(mcpTools: McpToolDefinition[]): Set<string>`
in `native-tools.ts` for reuse and testability.

- [ ] Add `buildEnabledToolSet()` to `native-tools.ts` — takes `McpToolDefinition[]`, returns `Set<string>` of stripped tool names
- [ ] Add `enabledToolNames: Set<string>` field to `MessageProcessorContext` interface in `cursor-messages.ts`
- [ ] Populate `enabledToolNames` in the `handleMessage()` method of `CursorSession` in `cursor-session.ts`
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/native-tools.ts` (modified)
- `packages/pi-cursor/src/proxy/cursor-messages.ts` (modified)
- `packages/pi-cursor/src/proxy/cursor-session.ts` (modified)

### Step 2: Gate all tool call paths

Gate four surfaces in `cursor-messages.ts` against `enabledToolNames`:

**Surface A — MCP passthrough (`mcpArgs` branch in `handleExecMessage`):**
After decoding `resolvedToolName`, check `enabledToolNames.has(resolvedToolName)`.
If not enabled, send an `McpResult` with `isError: true` and message
`"Tool '{name}' is not enabled in this session"`. Do NOT call `onMcpExec`.
Use the existing `McpResultSchema`/`McpSuccessSchema` with `isError: true` —
same pattern as error results elsewhere in the file.

**Surface B — Native exec redirects (`classification === 'redirect'` branch):**
After `nativeToMcpRedirect()` returns the redirect info, check
`enabledToolNames.has(nativeRedirect.toolName)`. If not enabled, reject the
exec. Use the `REJECT_REASON` pattern already used for `backgroundShellSpawnArgs`
— send an appropriate native error result. For `shellArgs`/`shellStreamArgs` use
`ShellRejectedSchema`. For `readArgs`, `writeArgs`, `deleteArgs`, `grepArgs`,
`lsArgs`, `fetchArgs` — send an MCP error result via the existing
`sendMcpResultFrame` pattern (the model recovers from MCP errors cleanly).

Note: `deleteArgs` and `fetchArgs` both redirect to `bash`. Disabling `bash`
also blocks delete and fetch via native tools. This is intentional — if Pi
didn't send `bash` in the tools array, shell execution should be blocked
regardless of the native entry point.

**Surface C — Unknown exec types (`sendUnknownExecResult`):**
Change the existing `sendUnknownExecResult` to log a clear rejection message
instead of silently sending an empty result. Keep the current empty-result
protobuf response (needed to prevent server hangs) but add a warning-level
log line: `"[cursor-messages] rejected unknown exec type"`.

**Surface D — Interaction queries (`handleInteractionQuery`):**
Change `webSearchRequestQuery`, `exaSearchRequestQuery`, and
`exaFetchRequestQuery` from auto-approved to rejected. For web search, import
and use `WebSearchRequestResponse_RejectedSchema` (or the appropriate rejected
variant). For exa search/fetch, use the rejected case. The model will see the
rejection and fall back to available tools.

Note: `handleInteractionQuery` does not currently receive `enabledToolNames`.
Since these interaction queries are not MCP tools (they're Cursor-internal
features the model invokes implicitly), rejecting them unconditionally is the
correct approach — they were never in Pi's tool set to begin with.

- [ ] Gate MCP passthrough: validate `resolvedToolName` against `enabledToolNames` before calling `onMcpExec`
- [ ] Gate native redirects: validate `nativeRedirect.toolName` against `enabledToolNames` before calling `onMcpExec`
- [ ] Harden unknown exec handling: add rejection log message to `sendUnknownExecResult`
- [ ] Reject interaction queries: change web search, exa search, exa fetch from approved to rejected
- [ ] Run targeted tests: `cd packages/pi-cursor && npx vitest run`

**Artifacts:**

- `packages/pi-cursor/src/proxy/cursor-messages.ts` (modified)

### Step 3: Testing & Verification

> ZERO test failures allowed. This step runs the FULL test suite as a quality gate.

- [ ] Create `packages/pi-cursor/src/proxy/tool-gating.test.ts` with tests for:
  - `buildEnabledToolSet()` — correct set from McpToolDefinition array, empty array, prefix stripping
  - MCP passthrough gating — enabled tool passes through, disabled tool is rejected
  - Native redirect gating — enabled redirect passes through, disabled redirect is rejected
  - Interaction query rejection — web search, exa search, exa fetch are rejected
- [ ] Add `buildEnabledToolSet` tests to `native-tools.test.ts`
- [ ] Run FULL test suite: `cd packages/pi-cursor && npx vitest run`
- [ ] Fix all failures
- [ ] Build passes: `cd packages/pi-cursor && npx rolldown --config rolldown.config.ts`

**Artifacts:**

- `packages/pi-cursor/src/proxy/tool-gating.test.ts` (new)
- `packages/pi-cursor/src/proxy/native-tools.test.ts` (modified)

### Step 4: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — Update the "Native Tool Redirection" definition to mention that redirects are gated against the enabled tool set. Add a new term "Tool Gating" describing the filtering behavior.

**Check If Affected:**

- `packages/pi-cursor/README.md` — Update if it documents tool behavior

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] Documentation updated
- [ ] MCP tool calls for unregistered tools return `isError: true`
- [ ] Native tool redirects for disabled tools are rejected
- [ ] Unknown exec types produce rejection log messages
- [ ] Web search / exa queries are rejected instead of auto-approved

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-002): complete Step N — description`
- **Bug fixes:** `fix(TP-002): description`
- **Tests:** `test(TP-002): description`
- **Hydration:** `hydrate: TP-002 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Modify framework/standards docs without explicit user approval
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message
- Add new configuration surfaces — the `tools` array is the sole source of truth
- Change the OpenAI API contract between Pi and the proxy
- Modify `buildRequestContext` — the tool filtering is enforcement-side, not registration-side
- Break the existing `backgroundShellSpawnArgs` / `writeShellStdinArgs` rejection behavior

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution.
     Format:
     ### Amendment N — YYYY-MM-DD HH:MM
     **Issue:** [what was wrong]
     **Resolution:** [what was changed] -->
