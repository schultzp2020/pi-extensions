# TP-013: Tool Dispatch Module — Status

**Current Step:** Not Started
**Status:** 🔵 Ready for Execution
**Last Updated:** 2026-05-04
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

- [ ] Read `cursor-messages.ts` — map functions and context fields to concerns
- [ ] Read `native-tools.ts` — understand imported functions
- [ ] Read `cursor-session.ts` — identify `processServerMessage` call site and context assembly

---

### Step 1: Create tool-dispatch.ts

**Status:** ⬜ Not Started

- [ ] Create `tool-dispatch.ts` with `ToolDispatchContext` and `handleToolMessage`
- [ ] Move exec, interaction query, and exec control handling from `cursor-messages.ts`
- [ ] Wire imports from `native-tools.ts`, `connect-protocol.ts`, `request-context.ts`
- [ ] Run targeted tests

---

### Step 2: Update cursor-messages.ts and create tests

**Status:** ⬜ Not Started

- [ ] Remove moved functions from `cursor-messages.ts` and shrink `MessageProcessorContext` to 6 fields
- [ ] Update `processServerMessage` to delegate tool cases to `handleToolMessage`
- [ ] Update `cursor-session.ts` context assembly
- [ ] Create `tool-dispatch.test.ts` with dispatch routing and rejection tests
- [ ] Run targeted tests

---

### Step 3: Testing & Verification

**Status:** ⬜ Not Started

- [ ] FULL test suite passing
- [ ] All failures fixed
- [ ] Build passes
- [ ] Verify `native-tools.ts` unchanged, existing tests unmodified and green

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
| 2026-05-04 | Task staged | PROMPT.md and STATUS.md created |

---

## Blockers

_None_

---

## Notes

_Reserved for execution notes_
