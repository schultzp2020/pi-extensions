# TP-002: Gate tool calls against enabled set — Status

**Current Step:** Not Started
**Status:** 🔵 Ready for Execution
**Last Updated:** 2026-05-03
**Review Level:** 1
**Review Counter:** 0
**Iteration:** 0
**Size:** M

> **Hydration:** Checkboxes represent meaningful outcomes, not individual code
> changes. Workers expand steps when runtime discoveries warrant it — aim for
> 2-5 outcome-level items per step, not exhaustive implementation scripts.

---

### Step 0: Preflight

**Status:** ⬜ Not Started

- [ ] `cursor-messages.ts` exports `MessageProcessorContext`, `handleExecMessage`, `processServerMessage`
- [ ] `cursor-session.ts` constructs `MessageProcessorContext` with `mcpTools`
- [ ] `native-tools.ts` exports `classifyExecMessage`, `stripMcpToolPrefix`
- [ ] Tests pass before changes

---

### Step 1: Add enabled tool set to MessageProcessorContext

**Status:** ⬜ Not Started

- [ ] Add `buildEnabledToolSet()` to `native-tools.ts`
- [ ] Add `enabledToolNames` field to `MessageProcessorContext`
- [ ] Populate `enabledToolNames` in `CursorSession.handleMessage()`

---

### Step 2: Gate all tool call paths

**Status:** ⬜ Not Started

- [ ] Gate MCP passthrough against enabled set
- [ ] Gate native exec redirects against enabled set
- [ ] Harden unknown exec type handling with rejection log
- [ ] Reject web search and exa interaction queries

---

### Step 3: Testing & Verification

**Status:** ⬜ Not Started

- [ ] Create `tool-gating.test.ts` with gating tests
- [ ] Add `buildEnabledToolSet` tests to `native-tools.test.ts`
- [ ] FULL test suite passing
- [ ] All failures fixed
- [ ] Build passes

---

### Step 4: Documentation & Delivery

**Status:** ⬜ Not Started

- [ ] "Must Update" docs modified
- [ ] "Check If Affected" docs reviewed
- [ ] Discoveries logged

---

## Reviews

| #   | Type | Step | Verdict | File |
| --- | ---- | ---- | ------- | ---- |

---

## Discoveries

| Discovery | Disposition | Location |
| --------- | ----------- | -------- |

---

## Execution Log

| Timestamp  | Action      | Outcome                         |
| ---------- | ----------- | ------------------------------- |
| 2026-05-03 | Task staged | PROMPT.md and STATUS.md created |

---

## Blockers

_None_

---

## Notes

_Reserved for execution notes_
