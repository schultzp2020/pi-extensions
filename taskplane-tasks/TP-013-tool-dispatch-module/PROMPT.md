# Task: TP-013 - Tool Dispatch Module

**Created:** 2026-05-04
**Size:** M

## Review Level: 1 (Plan Only)

**Assessment:** Pure refactoring that extracts tool dispatch logic from cursor-messages into a focused module. Multiple files change but all behavior is preserved — no new capabilities, no security implications, easily reversible.
**Score:** 2/8 — Blast radius: 1, Pattern novelty: 1, Security: 0, Reversibility: 0

## Canonical Task Folder

```
taskplane-tasks/TP-013-tool-dispatch-module/
├── PROMPT.md   ← This file (immutable above --- divider)
├── STATUS.md   ← Execution state (worker updates this)
├── .reviews/   ← Reviewer output (created by the orchestrator runtime)
└── .DONE       ← Created when complete
```

## Mission

Extract tool-related message handling from `cursor-messages.ts` (773 lines) into a focused **Tool Dispatch** module. The current `processServerMessage` conflates text streaming, Blob Store KV handshakes, and Checkpoint updates with tool dispatch (exec messages, interaction queries, exec control). This forces a 12-field `MessageProcessorContext` on every caller, even when testing only one concern.

The new Tool Dispatch module owns three server message cases:

1. `execServerMessage` — classify → reject/redirect/execute via native-tools
2. `interactionQuery` — web search, exa, ask question (all rejected)
3. `execServerControlMessage` — abort handling

It wraps `native-tools.ts` for execution without modifying native-tools' interface.

After extraction, `cursor-messages.ts` shrinks to ~350 lines with a 6-field `MessageProcessorContext` focused on streaming/KV/checkpoint. Tool Dispatch has its own 8-field `ToolDispatchContext` focused on tool routing.

This is a pure refactoring — all tool dispatch behavior is preserved exactly.

## Dependencies

- **None**

## Context to Read First

**Tier 2 (area context):**

- `taskplane-tasks/CONTEXT.md`

**Tier 3 (load only if needed):**

- `packages/pi-cursor/CONTEXT.md` — domain glossary (Tool Dispatch, Native Tools Mode, Overlapping Tools, Remaining Tools, Tool Gating, Allowed Root definitions)
- `packages/pi-cursor/docs/adr/0005-native-tools-mode-policy.md` — three-mode tool policy to preserve
- `docs/prd-proxy-architecture-deepening.md` — full PRD with design rationale

## Environment

- **Workspace:** `packages/pi-cursor`
- **Services required:** None

## File Scope

- `packages/pi-cursor/src/proxy/tool-dispatch.ts` (new)
- `packages/pi-cursor/src/proxy/tool-dispatch.test.ts` (new)
- `packages/pi-cursor/src/proxy/cursor-messages.ts` (modified — extract tool dispatch, shrink context)

## Steps

### Step 0: Preflight

- [ ] Read `cursor-messages.ts` — identify all functions that handle exec messages, interaction queries, and exec control messages; map the `MessageProcessorContext` fields to which concern uses them
- [ ] Read `native-tools.ts` — understand the imports cursor-messages uses (`classifyExecMessage`, `executeNativeLocally`, `fixMcpArgNames`, `stripMcpToolPrefix`)
- [ ] Read `cursor-session.ts` — identify how it calls `processServerMessage` and assembles the `MessageProcessorContext`

### Step 1: Create tool-dispatch.ts

- [ ] Create `tool-dispatch.ts` with `ToolDispatchContext` type (8 fields: `sendFrame`, `mcpTools`, `enabledToolNames`, `cloudRule`, `nativeToolsMode`, `allowedRoot`, `onMcpExec`, `state`)
- [ ] Export `handleToolMessage(msg, ctx: ToolDispatchContext) → boolean` as the single entry point
- [ ] Move these functions from `cursor-messages.ts`: `handleExecMessage`, `handleInteractionQuery`, `sendExecResult`, `sendMcpResult`, `sendUnknownExecResult`, and all interaction query rejection logic (web search, exa search, exa fetch, ask question, switch mode, create plan responses)
- [ ] Import from `native-tools.ts` (`classifyExecMessage`, `executeNativeLocally`, `fixMcpArgNames`, `stripMcpToolPrefix`), `connect-protocol.ts` (`frameConnectMessage`), and `request-context.ts` (`buildRequestContext`)
- [ ] Run targeted tests: `npm test -- --grep "tool\|native\|gating"`

**Artifacts:**

- `packages/pi-cursor/src/proxy/tool-dispatch.ts` (new)

### Step 2: Update cursor-messages.ts and create tests

- [ ] Remove all moved functions from `cursor-messages.ts`
- [ ] Shrink `MessageProcessorContext` to 6 fields: `blobStore`, `sendFrame`, `state`, `onText`, `onCheckpoint`, `onNotify` — plus a `toolDispatch` context or integration point for delegating to `handleToolMessage`
- [ ] Update `processServerMessage` to call `handleToolMessage` for exec/query/control cases; if not handled, process remaining cases (interactionUpdate, kvServerMessage, conversationCheckpointUpdate) with the narrow context
- [ ] Update `cursor-session.ts` — adjust how it assembles the context to provide both the narrow message context and the tool dispatch context
- [ ] Create `tool-dispatch.test.ts` with tests for: exec routing by mode (`reject` → rejection response, `redirect` → MCP redirect emitted, `native` → native execution delegated), interaction query rejection for all query types, unknown exec type handling with field number mirroring, exec control abort, unenabled tool rejection via Tool Gating
- [ ] Run targeted tests: `npm test -- --grep "tool-dispatch\|cursor-messages"`

**Artifacts:**

- `packages/pi-cursor/src/proxy/cursor-messages.ts` (modified)
- `packages/pi-cursor/src/proxy/tool-dispatch.test.ts` (new)

### Step 3: Testing & Verification

- [ ] Run FULL test suite: `npm test`
- [ ] Fix all failures
- [ ] Build passes: `npm run build`
- [ ] Verify `native-tools.ts` is unchanged (no added/removed exports)
- [ ] Verify `tool-gating.test.ts` and `native-tools.test.ts` pass unmodified
- [ ] Verify `cursor-messages.ts` no longer contains `handleExecMessage`, `handleInteractionQuery`, `sendExecResult`, `sendMcpResult`, or `sendUnknownExecResult`

### Step 4: Documentation & Delivery

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged in STATUS.md

## Documentation Requirements

**Must Update:**

- `packages/pi-cursor/CONTEXT.md` — verify Tool Dispatch definition matches the implementation

**Check If Affected:**

- `packages/pi-cursor/docs/adr/0005-native-tools-mode-policy.md` — confirm three-mode policy preserved

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing
- [ ] `cursor-messages.ts` no longer contains tool dispatch functions
- [ ] `tool-dispatch.ts` exports `handleToolMessage` and `ToolDispatchContext`
- [ ] `native-tools.ts` is unchanged
- [ ] Documentation updated

## Git Commit Convention

Commits happen at **step boundaries** (not after every checkbox). All commits
for this task MUST include the task ID for traceability:

- **Step completion:** `feat(TP-013): complete Step N — description`
- **Bug fixes:** `fix(TP-013): description`
- **Tests:** `test(TP-013): description`
- **Hydration:** `hydrate: TP-013 expand Step N checkboxes`

## Do NOT

- Expand task scope — add tech debt to CONTEXT.md instead
- Skip tests
- Modify `native-tools.ts` — Tool Dispatch wraps it, does not change it
- Modify `tool-gating.test.ts` or `native-tools.test.ts` — they must pass unmodified
- Change any tool dispatch behavior — only restructure where the code lives
- Change external HTTP API contracts
- Load docs not listed in "Context to Read First"
- Commit without the task ID prefix in the commit message

---

## Amendments (Added During Execution)

<!-- Workers add amendments here if issues discovered during execution.
     Format:
     ### Amendment N — YYYY-MM-DD HH:MM
     **Issue:** [what was wrong]
     **Resolution:** [what was changed] -->
